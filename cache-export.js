// CSV serialization and download helpers for the locally cached listing records.
var LRCacheExport = (() => {
  const BATCH_SIZE = 200;
  const AMENITY_COLUMNS = [
    "parking",
    "secureRoom",
    "elevator",
    "storage",
    "airConditioner",
    "accessible",
    "balcony",
    "sunBoiler",
    "grating",
    "garden",
    "pool",
  ];
  const BASE_COLUMNS = [
    "cache_key",
    "site",
    "record_type",
    "listing_id",
    "listing_url",
    "title",
    "notes",
    "address",
    "city",
    "neighborhood",
    "updated_at",
    "updated_at_iso",
    "is_expired",
    "listing_created_at",
    "listing_updated_at",
    "latitude",
    "longitude",
    "price",
    "maxPrice",
    "sqm",
    "maxSqm",
    "pricePerSqm",
    "observedPrice",
    "priceHistory",
    "rooms",
    "railMeters",
    "railApprox",
    "railStation",
    "brokerage",
  ];

  function parseCacheKey(key) {
    const separator = key.indexOf(":");
    return separator < 0
      ? { site: "unknown", listingId: key }
      : { site: key.slice(0, separator), listingId: key.slice(separator + 1) };
  }

  function fallbackUrl(site, id) {
    const encodedId = encodeURIComponent(id);
    if (site === "madlan") return `https://www.madlan.co.il/listings/${encodedId}`;
    if (site === "yad2") return `https://www.yad2.co.il/realestate/item/${encodedId}`;
    return "";
  }

  function recordUrl(site, id, record) {
    return (
      record.url ||
      record.listingUrl ||
      record.href ||
      record.link ||
      fallbackUrl(site, id)
    );
  }

  function priceHistoryJson(record) {
    const history = Array.isArray(record.priceHistory) ? record.priceHistory : [];
    const validHistory = history.filter(
      (point) =>
        point &&
        Number.isFinite(point.price) &&
        (Number.isFinite(point.at) || point.baselineUnknown === true)
    );
    const uncertainBaseline = LRCacheData.hasUncertainInitialPriceBaseline(validHistory);
    return JSON.stringify(
      validHistory.map((point, index) => {
        const unknownDate =
          index === 0 &&
          (uncertainBaseline || !Number.isFinite(point.at));
        const estimatedAt = unknownDate
          ? LRCacheData.inferredPriceHistoryTimestamp(validHistory, index)
          : null;
        const hasEstimatedDate = Number.isFinite(estimatedAt);
        return {
          price: point.price,
          date:
            unknownDate && !hasEstimatedDate ||
            !Number.isFinite(new Date(hasEstimatedDate ? estimatedAt : point.at).getTime())
              ? null
              : new Date(hasEstimatedDate ? estimatedAt : point.at).toISOString(),
          ...(unknownDate ? { baselineUnknown: true } : {}),
          ...(hasEstimatedDate ? { baselineDateEstimated: true } : {}),
        };
      })
    );
  }

  function validPriceHistory(record) {
    const history = Array.isArray(record && record.priceHistory)
      ? record.priceHistory.filter(
          (point) =>
            point &&
            Number.isFinite(point.price) &&
            (Number.isFinite(point.at) || point.baselineUnknown === true)
        )
      : [];
    return history;
  }

  function getPriceTimelineEvents(cache) {
    const events = [];
    for (const [key, record] of getRecords(cache)) {
      if (record.recordType === "project") continue;
      const { site, listingId } = parseCacheKey(key);
      const history = validPriceHistory(record);
      if (!history.length) continue;
      const uncertainBaseline = LRCacheData.hasUncertainInitialPriceBaseline(history);
      const listing = {
        key,
        site,
        listingId,
        title: record.title || record.address || key,
        address: record.address || "",
        city: record.city || "",
        url: recordUrl(site, listingId, record),
        currentPrice: Number.isFinite(record.price) ? record.price : null,
        sqm: record.sqm,
        rooms: record.rooms,
        pricePerSqm: LRCacheData.pricePerSqm(record),
        railMeters: record.railMeters,
        railApprox: record.railApprox,
        railStation: record.railStation || "",
        brokerage: record.brokerage,
        amenities:
          record.amenities && typeof record.amenities === "object"
            ? record.amenities
            : {},
      };
      for (let index = 1; index < history.length; index++) {
        const previous = history[index - 1];
        const point = history[index];
        const uncertainInitialComparison = uncertainBaseline && index === 1;
        const baselineEstimatedAt = uncertainInitialComparison
          ? LRCacheData.inferredPriceHistoryTimestamp(history, 0)
          : null;
        const shared = {
          ...listing,
          at: point.at,
          fromPrice: previous.price,
          toPrice: point.price,
          ...(Number.isFinite(baselineEstimatedAt)
            ? { baselineEstimatedAt, baselineDateEstimated: true }
            : {}),
        };
        if (
          !Number.isFinite(point.at) ||
          !Number.isFinite(previous.price) ||
          !Number.isFinite(point.price) ||
          point.price === previous.price
        ) {
          if (uncertainInitialComparison && Number.isFinite(point.at)) {
            events.push({ ...shared, kind: "uncertain" });
          }
          continue;
        }
        const change = point.price - previous.price;
        events.push({
          ...shared,
          kind: change < 0 ? "decrease" : "increase",
          change,
        });
      }
    }
    return events.sort((left, right) => {
      if (!Number.isFinite(left.at) && !Number.isFinite(right.at)) return 0;
      if (!Number.isFinite(left.at)) return 1;
      if (!Number.isFinite(right.at)) return -1;
      return right.at - left.at;
    });
  }

  function getPriceChanges(cache) {
    return getPriceTimelineEvents(cache).filter(
      (event) => event.kind === "increase" || event.kind === "decrease"
    );
  }

  function historyDate(timestamp) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      day: "numeric",
      month: "numeric",
      year: "numeric",
    }).format(new Date(timestamp));
  }

  function textDate(timestamp) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
      return "תאריך לא ידוע";
    }
    return new Intl.DateTimeFormat("he-IL-u-nu-latn", {
      timeZone: "Asia/Jerusalem",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(timestamp));
  }

  function textPrice(value) {
    return Number.isFinite(value) ? `₪${Math.round(value).toLocaleString("he-IL")}` : "לא ידוע";
  }

  function textValue(value) {
    if (value === undefined) return "לא ידוע";
    if (value === null) return "לא ידוע";
    if (typeof value === "boolean") return value ? "כן" : "לא";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  const TEXT_FIELD_LABELS = {
    recordType: "סוג",
    title: "שם המודעה",
    notes: "הערה אישית",
    address: "כתובת",
    city: "עיר",
    neighborhood: "שכונה",
    updatedAt: "נשמר/עודכן",
    listingCreatedAt: "תאריך יצירת מודעה",
    listingUpdatedAt: "תאריך עדכון מודעה",
    listingStatus: "סטטוס מודעה",
    listingStatusCheckedAt: "תאריך בדיקת סטטוס",
    price: "מחיר",
    maxPrice: "מחיר מרבי",
    observedPrice: "מחיר שנצפה",
    sqm: "שטח (מ״ר)",
    maxSqm: "שטח מרבי (מ״ר)",
    pricePerSqm: "מחיר למ״ר",
    ppsm: "מחיר למ״ר",
    rooms: "חדרים",
    railMeters: "מרחק מהרכבת (מ׳)",
    railApprox: "מרחק משוער",
    railStation: "תחנת רכבת קרובה",
    brokerage: "תיווך",
    coordinates: "קואורדינטות",
    amenities: "מאפייני הנכס",
    url: "קישור",
    listingUrl: "קישור למודעה",
    href: "קישור",
    link: "קישור",
  };

  async function buildTxt(cache, onProgress = () => {}) {
    const records = getRecords(cache);
    const lines = [
      "מידע שמור — קרבה לרכבת הקלה",
      `נוצר בתאריך: ${textDate(Date.now())}`,
      `מספר רשומות: ${records.length.toLocaleString("he-IL")}`,
      "",
    ];
    onProgress(0, records.length);
    for (let index = 0; index < records.length; index++) {
      const [key, record] = records[index];
      const { site, listingId } = parseCacheKey(key);
      lines.push("=".repeat(72));
      lines.push(record.title || record.address || key);
      lines.push(`אתר: ${site === "yad2" ? "יד2" : site === "madlan" ? "מדלן" : site}`);
      lines.push(`מזהה: ${listingId}`);
      const url = recordUrl(site, listingId, record);
      if (url) lines.push(`קישור: ${url}`);
      for (const [field, value] of Object.entries(record)) {
        if (field === "title") continue;
        const label = TEXT_FIELD_LABELS[field] || field;
        if (field === "priceHistory") {
          const history = validPriceHistory(record);
          lines.push("היסטוריית מחירים:");
          if (!history.length) {
            lines.push("  אין תצפיות מחיר");
          } else {
            for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
              const point = history[historyIndex];
              const estimatedAt = LRCacheData.inferredPriceHistoryTimestamp(history, historyIndex);
              const timestamp = Number.isFinite(estimatedAt) ? estimatedAt : point.at;
              const estimated = Number.isFinite(estimatedAt);
              lines.push(`  ${textDate(timestamp)}${estimated ? " (משוער)" : ""} — ${textPrice(point.price)}`);
            }
          }
        } else if (field === "amenities" && value && typeof value === "object") {
          lines.push(`${label}:`);
          for (const [amenity, amenityValue] of Object.entries(value)) {
            lines.push(`  ${AMENITY_LABELS[amenity] || amenity}: ${textValue(amenityValue)}`);
          }
        } else if (field === "coordinates" && value && typeof value === "object") {
          lines.push(`קו רוחב: ${textValue(value.lat)}`);
          lines.push(`קו אורך: ${textValue(value.lon)}`);
        } else if (field === "indexedFrom") {
          lines.push(`מקור המידע: ${value === "search" ? "תוצאות חיפוש בלבד (חלקי)" : "עמוד המודעה"}`);
        } else if (field === "recordType") {
          lines.push(`סוג: ${value === "project" ? "פרויקט" : "מודעה"}`);
        } else if (field === "listingStatus") {
          const status = value === "active" ? "פעילה" : value === "removed" ? "הוסרה" : "לא נבדקה";
          lines.push(`${label}: ${status}`);
        } else if (["price", "maxPrice", "observedPrice", "pricePerSqm", "ppsm"].includes(field)) {
          lines.push(`${label}: ${textPrice(value)}`);
        } else if (["updatedAt", "listingStatusCheckedAt"].includes(field)) {
          lines.push(`${label}: ${Number.isFinite(value) ? textDate(value) : textValue(value)}`);
        } else {
          lines.push(`${label}: ${textValue(value)}`);
        }
      }
      lines.push("");
      if ((index + 1) % BATCH_SIZE === 0 && index + 1 < records.length) {
        onProgress(index + 1, records.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    onProgress(records.length, records.length);
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function downloadTxt(text, date = new Date()) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `listing-cache-${date.toISOString().slice(0, 10)}.txt`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function cell(value) {
    if (value === undefined || value === null) return "";
    const isString = typeof value === "string";
    let text =
      isString
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (isString && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function getRecords(cache) {
    return Object.entries(cache && typeof cache === "object" ? cache : {}).filter(
      ([, record]) => record && typeof record === "object" && !Array.isArray(record)
    );
  }

  async function buildCsv(cache, onProgress = () => {}, now = Date.now()) {
    const records = getRecords(cache);
    const amenityKeys = new Set(AMENITY_COLUMNS);
    const extraFields = new Set();
    for (const [, record] of records) {
      for (const key of Object.keys(record.amenities || {})) amenityKeys.add(key);
      for (const key of Object.keys(record)) {
        if (
          ![
            "amenities",
            "coordinates",
            "updatedAt",
            "listingCreatedAt",
            "listingUpdatedAt",
            "url",
            "listingUrl",
            "href",
            "link",
            "recordType",
            "title",
            "notes",
            "address",
            "city",
            "neighborhood",
            "price",
            "maxPrice",
            "sqm",
            "maxSqm",
            "pricePerSqm",
            "ppsm",
            "observedPrice",
            "priceHistory",
            "rooms",
            "railMeters",
            "railApprox",
            "railStation",
            "brokerage",
          ].includes(key)
        ) {
          extraFields.add(key);
        }
      }
    }

    const amenities = [...amenityKeys];
    const extras = [...extraFields].sort();
    const headers = [
      ...BASE_COLUMNS,
      ...amenities.map((key) => `amenity_${key}`),
      "amenities_json",
      "coordinates_json",
      ...extras.map((key) => `record_${key}`),
      "record_json",
    ];
    const lines = [headers.map(cell).join(",")];
    onProgress(0, records.length);

    for (let index = 0; index < records.length; index++) {
      const [key, record] = records[index];
      const { site, listingId } = parseCacheKey(key);
      const coordinates = record.coordinates || {};
      const timestamp = Number.isFinite(record.updatedAt) ? record.updatedAt : "";
      const row = [
        key,
        site,
        record.recordType === "project" ? "project" : "listing",
        listingId,
        recordUrl(site, listingId, record),
        record.title,
        record.notes,
        record.address,
        record.city,
        record.neighborhood,
        timestamp,
        timestamp ? new Date(timestamp).toISOString() : "",
        timestamp ? now - timestamp >= 60 * 24 * 60 * 60 * 1000 : "",
        record.listingCreatedAt,
        record.listingUpdatedAt,
        coordinates.lat,
        coordinates.lon,
        record.price,
        record.maxPrice,
        record.sqm,
        record.maxSqm,
        record.pricePerSqm ?? record.ppsm,
        record.observedPrice,
        priceHistoryJson(record),
        record.rooms,
        record.railMeters,
        record.railApprox,
        record.railStation,
        record.brokerage,
        ...amenities.map((amenity) => record.amenities && record.amenities[amenity]),
        record.amenities,
        record.coordinates,
        ...extras.map((field) => record[field]),
        record,
      ];
      lines.push(row.map(cell).join(","));

      if ((index + 1) % BATCH_SIZE === 0 && index + 1 < records.length) {
        onProgress(index + 1, records.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    onProgress(records.length, records.length);
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function downloadCsv(csv, date = new Date()) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `listing-cache-${date.toISOString().slice(0, 10)}.csv`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const AMENITY_LABELS = {
    parking: "חניה",
    secureRoom: "ממ״ד",
    elevator: "מעלית",
    storage: "מחסן",
    airConditioner: "מיזוג אוויר",
    accessible: "נגישות",
    balcony: "מרפסת",
    sunBoiler: "דוד שמש",
    grating: "סורגים",
    garden: "גינה",
    pool: "בריכה",
  };
  const EXCEL_COLUMNS = [
    { key: "site", label: "אתר" },
    { key: "recordType", label: "סוג", width: 14 },
    { key: "listingId", label: "מזהה מודעה/פרויקט" },
    { key: "listingUrl", label: "קישור למודעה/פרויקט", width: 42, hyperlink: true },
    { key: "title", label: "שם מודעה/פרויקט", width: 32 },
    { key: "notes", label: "הערה אישית", width: 42 },
    { key: "address", label: "כתובת", width: 32 },
    { key: "city", label: "עיר", width: 18 },
    { key: "neighborhood", label: "שכונה", width: 18 },
    { key: "updatedAt", label: "נשמר במטמון בתאריך", width: 22 },
    { key: "listingCreatedAt", label: "תאריך יצירת מודעה", width: 20 },
    { key: "listingUpdatedAt", label: "תאריך עדכון מודעה", width: 20 },
    { key: "price", label: "מחיר / החל מ׳ (₪)", width: 18 },
    { key: "maxPrice", label: "מחיר עד (₪)", width: 16 },
    { key: "sqm", label: "שטח / החל מ׳ (מ״ר)", width: 18 },
    { key: "maxSqm", label: "שטח עד (מ״ר)", width: 16 },
    { key: "pricePerSqm", label: "מחיר למ״ר (₪)", width: 18 },
    // עמודות ניתוח: חלקן נוסחאות Excel חיות (הגיל מתעדכן כל יום שפותחים את הקובץ)
    { key: "listingAgeDays", label: "גיל המודעה (ימים)", width: 16, analysis: true, style: 10 },
    { key: "sellerPressure", label: "מדד לחץ למכור (0–100)", width: 18, analysis: true },
    { key: "firstPrice", label: "מחיר ראשון שנצפה (₪)", width: 20, analysis: true },
    { key: "priceChange", label: "שינוי מחיר (₪)", width: 16, analysis: true, style: 5 },
    { key: "priceChangePct", label: "שינוי מחיר (%)", width: 14, analysis: true, style: 11 },
    { key: "ppsmVsCity", label: "מחיר למ״ר מול חציון העיר", width: 22, analysis: true, style: 11 },
    { key: "dealScore", label: "ציון שווה", width: 12, analysis: true },
    { key: "pressureLevel", label: "רמת לחץ למכור", width: 14, analysis: true },
    { key: "observedPrice", label: "מחיר שנמדד באתר (₪)", width: 21 },
    { key: "priceHistoryCount", label: "תצפיות מחיר", width: 14 },
    { key: "rooms", label: "חדרים", width: 12 },
    { key: "latitude", label: "קו רוחב", width: 14 },
    { key: "longitude", label: "קו אורך", width: 14 },
    { key: "railMeters", label: "מרחק מהרכבת (מ׳)", width: 22 },
    { key: "railApprox", label: "מרחק הרכבת משוער?", width: 18, booleanYesNo: true },
    { key: "railStation", label: "תחנה קרובה", width: 24 },
    {
      key: "brokerage",
      label: "תיווך?",
      width: 12,
      booleanYesNo: true,
      reverseBooleanColors: true,
    },
  ];

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function columnName(index) {
    let name = "";
    for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
      name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
    }
    return name;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const [filename, content] of files) {
      const name = encoder.encode(filename);
      const data = encoder.encode(content);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      localParts.push(local);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);
      offset += local.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  async function buildExcel(cache, onProgress = () => {}, now = Date.now()) {
    const records = getRecords(cache);
    const amenityKeys = new Set(AMENITY_COLUMNS);
    for (const [, record] of records) {
      for (const key of Object.keys(record.amenities || {})) amenityKeys.add(key);
    }
    const columns = [
      ...EXCEL_COLUMNS,
      ...[...amenityKeys].map((key) => ({
        key: `amenity_${key}`,
        amenity: key,
        label: AMENITY_LABELS[key] || key,
        width: 14,
      })),
    ];
    const links = [];
    const historyLinks = [];
    const rows = [];
    const historyRows = [];
    const col = (key) => columnName(columns.findIndex((column) => column.key === key));
    const ppsmOf = (record) => {
      const value = record.pricePerSqm ?? record.ppsm;
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    // חציון מחיר למ״ר לכל עיר (רק מודעות; עיר עם 3 מודעות לפחות)
    const cityPpsm = new Map();
    for (const [, record] of records) {
      if (record.recordType === "project" || !record.city || !ppsmOf(record)) continue;
      if (!cityPpsm.has(record.city)) cityPpsm.set(record.city, []);
      cityPpsm.get(record.city).push(ppsmOf(record));
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const cityMedian = new Map(
      [...cityPpsm].filter(([, values]) => values.length >= 3).map(([city, values]) => [city, median(values)])
    );
    const analysisFormula = (key, row) => {
      const created = `${col("listingCreatedAt")}${row}`;
      const age = `${col("listingAgeDays")}${row}`;
      const price = `${col("price")}${row}`;
      const first = `${col("firstPrice")}${row}`;
      const change = `${col("priceChange")}${row}`;
      const pct = `${col("priceChangePct")}${row}`;
      if (key === "listingAgeDays") {
        return `IF(${created}="","",TODAY()-DATE(VALUE(LEFT(${created},4)),VALUE(MID(${created},6,2)),VALUE(MID(${created},9,2))))`;
      }
      if (key === "priceChange") return `IF(OR(${price}="",${first}=""),"",${price}-${first})`;
      if (key === "priceChangePct") return `IF(OR(${change}="",N(${first})=0),"",${change}/${first})`;
      return "";
    };
    const historyColumns = [
      { key: "site", label: "אתר", width: 14 },
      { key: "title", label: "שם מודעה", width: 32 },
      { key: "address", label: "כתובת", width: 30 },
      { key: "listingId", label: "מזהה מודעה", width: 20 },
      { key: "listingUrl", label: "קישור למודעה", width: 24 },
      { key: "date", label: "תאריך תצפית", width: 18 },
      { key: "price", label: "מחיר (₪)", width: 18 },
      { key: "change", label: "שינוי במחיר (₪)", width: 20 },
      { key: "status", label: "מה השתנה", width: 42 },
    ];
    onProgress(0, records.length);

    for (let index = 0; index < records.length; index++) {
      const [key, record] = records[index];
      const { site, listingId } = parseCacheKey(key);
      const coordinates = record.coordinates || {};
      const history = validPriceHistory(record);
      const pressure = LRCacheData.sellerPressure(record, now);
      const timestamp = Number.isFinite(record.updatedAt)
        ? new Date(record.updatedAt).toISOString()
        : "";
      const values = {
        site: site === "yad2" ? "יד2" : site === "madlan" ? "מדלן" : site,
        recordType: record.recordType === "project" ? "פרויקט" : "מודעה",
        listingId,
        listingUrl: recordUrl(site, listingId, record),
        title: record.title,
        notes: record.notes,
        address: record.address,
        city: record.city,
        neighborhood: record.neighborhood,
        updatedAt: timestamp,
        listingCreatedAt: record.listingCreatedAt,
        listingUpdatedAt: record.listingUpdatedAt,
        price: record.price,
        maxPrice: record.maxPrice,
        sqm: record.sqm,
        maxSqm: record.maxSqm,
        pricePerSqm: record.pricePerSqm ?? record.ppsm,
        observedPrice: record.observedPrice,
        priceHistoryCount: history.length,
        rooms: record.rooms,
        latitude: coordinates.lat,
        longitude: coordinates.lon,
        railMeters: record.railMeters,
        railApprox: record.railApprox,
        railStation: record.railStation,
        brokerage: record.brokerage,
        firstPrice: record.recordType === "project" || !history.length ? undefined : history[0].price,
        ppsmVsCity:
          record.recordType !== "project" && ppsmOf(record) && cityMedian.has(record.city)
            ? ppsmOf(record) / cityMedian.get(record.city) - 1
            : undefined,
        dealScore: LRCacheData.dealScore(record) ?? undefined,
        sellerPressure: pressure ? pressure.score : undefined,
        pressureLevel: pressure ? LRCacheData.PRESSURE_LABELS[pressure.level] : undefined,
      };
      for (const column of columns) {
        if (column.amenity) values[column.key] = record.amenities?.[column.amenity];
      }

      const cells = columns.map((column, columnIndex) => {
        const value = values[column.key];
        const reference = `${columnName(columnIndex)}${index + 2}`;
        const formula = column.analysis && record.recordType !== "project"
          ? analysisFormula(column.key, index + 2)
          : "";
        if (formula) {
          return `<c r="${reference}"${column.style ? ` s="${column.style}"` : ""}><f>${xmlEscape(formula)}</f></c>`;
        }
        if (column.analysis && typeof value === "number" && Number.isFinite(value)) {
          return `<c r="${reference}" s="${column.style || (column.key === "firstPrice" ? 5 : 0)}" t="n"><v>${value}</v></c>`;
        }
        if (column.hyperlink && value) {
          const relationshipId = `rId${links.length + 1}`;
          links.push({ id: relationshipId, target: value, reference });
          const label = values.recordType === "פרויקט" ? "פתיחת פרויקט ↗" : "פתיחת מודעה ↗";
          return `<c r="${reference}" s="4" t="inlineStr"><is><t>${label}</t></is></c>`;
        }
        if ((column.amenity || column.key === "brokerage") && typeof value === "boolean") {
          const affirmativeStyle = column.reverseBooleanColors ? 3 : 2;
          const negativeStyle = column.reverseBooleanColors ? 2 : 3;
          return `<c r="${reference}" s="${value ? affirmativeStyle : negativeStyle}" t="inlineStr"><is><t>${value ? "כן" : "לא"}</t></is></c>`;
        }
        if (column.booleanYesNo && typeof value === "boolean") {
          return `<c r="${reference}" t="inlineStr"><is><t>${value ? "כן" : "לא"}</t></is></c>`;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
          return `<c r="${reference}" s="${column.key === "price" || column.key === "pricePerSqm" ? 5 : 0}" t="n"><v>${value}</v></c>`;
        }
        return value === undefined || value === null || value === ""
          ? `<c r="${reference}"/>`
          : `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
      });
      rows.push(`<row r="${index + 2}">${cells.join("")}</row>`);

      const listingUrl = recordUrl(site, listingId, record);
      const uncertainBaseline = LRCacheData.hasUncertainInitialPriceBaseline(history);
      for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
        const point = history[historyIndex];
        const previous = history[historyIndex - 1];
        const rowNumber = historyRows.length + 2;
        const estimatedAt = LRCacheData.inferredPriceHistoryTimestamp(history, historyIndex);
        const hasEstimatedDate = Number.isFinite(estimatedAt);
        const baselineDateUnknown =
          historyIndex === 0 &&
          (uncertainBaseline || !Number.isFinite(point.at)) &&
          !hasEstimatedDate;
        const estimatedBaseline = historyIndex === 0 && uncertainBaseline && hasEstimatedDate;
        const firstChangeDateUnknown =
          historyIndex === 1 && uncertainBaseline && !Number.isFinite(
            LRCacheData.inferredPriceHistoryTimestamp(history, 0)
          );
        let change = null;
        let status;
        let changeStyle = 5;
        if (baselineDateUnknown) {
          status = "מחיר קודם — התאריך לא ידוע";
        } else if (estimatedBaseline) {
          status = "מחיר קודם — תאריך משוער";
        } else if (firstChangeDateUnknown) {
          status = "המחיר השתנה — מועד השינוי המדויק לא ידוע";
        } else if (!previous) {
          status = "מחיר בסיס";
        } else {
          change = point.price - previous.price;
          if (change < 0) {
            status = historyIndex === 1 && uncertainBaseline
              ? "הוזלה — מחיר קודם עם תאריך משוער"
              : "הוזלה";
            changeStyle = 7;
          } else if (change > 0) {
            status = historyIndex === 1 && uncertainBaseline
              ? "עלייה — מחיר קודם עם תאריך משוער"
              : "עלייה";
            changeStyle = 8;
          } else {
            status = "ללא שינוי";
          }
        }
        const historyCells = [
          `<c r="A${rowNumber}" s="6" t="inlineStr"><is><t>${xmlEscape(site === "yad2" ? "יד2" : site === "madlan" ? "מדלן" : site)}</t></is></c>`,
          `<c r="B${rowNumber}" s="6" t="inlineStr"><is><t>${xmlEscape(record.title || listingId)}</t></is></c>`,
          `<c r="C${rowNumber}" s="6" t="inlineStr"><is><t>${xmlEscape(record.address || "")}</t></is></c>`,
          `<c r="D${rowNumber}" s="6" t="inlineStr"><is><t>${xmlEscape(listingId)}</t></is></c>`,
        ];
        if (listingUrl) {
          const relationshipId = `rId${historyLinks.length + 1}`;
          historyLinks.push({ id: relationshipId, target: listingUrl, reference: `E${rowNumber}` });
          historyCells.push(
            `<c r="E${rowNumber}" s="4" t="inlineStr"><is><t>פתיחת מודעה ↗</t></is></c>`
          );
        } else {
          historyCells.push(`<c r="E${rowNumber}" s="6" t="inlineStr"><is><t></t></is></c>`);
        }
        historyCells.push(
          baselineDateUnknown
            ? `<c r="F${rowNumber}" s="6" t="inlineStr"><is><t>לא ידוע</t></is></c>`
            : `<c r="F${rowNumber}" s="6" t="inlineStr"><is><t>${xmlEscape(historyDate(hasEstimatedDate ? estimatedAt : point.at))}${estimatedBaseline ? " (משוער)" : ""}</t></is></c>`,
          `<c r="G${rowNumber}" s="5" t="n"><v>${point.price}</v></c>`,
          Number.isFinite(change)
            ? `<c r="H${rowNumber}" s="${changeStyle}" t="n"><v>${change}</v></c>`
            : `<c r="H${rowNumber}" s="6" t="inlineStr"><is><t>—</t></is></c>`,
          `<c r="I${rowNumber}" s="9" t="inlineStr"><is><t>${xmlEscape(status)}</t></is></c>`
        );
        historyRows.push(`<row r="${rowNumber}" ht="22" customHeight="1">${historyCells.join("")}</row>`);
      }

      if ((index + 1) % BATCH_SIZE === 0 && index + 1 < records.length) {
        onProgress(index + 1, records.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    onProgress(records.length, records.length);

    const lastColumn = columnName(columns.length - 1);
    const lastRow = records.length + 1;
    const widths = columns
      .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width || 18}" customWidth="1"/>`)
      .join("");
    const header = columns
      .map(
        (column, index) =>
          `<c r="${columnName(index)}1" s="1" t="inlineStr"><is><t>${xmlEscape(column.label)}</t></is></c>`
      )
      .join("");
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1" ht="30" customHeight="1">${header}</row>${rows.join("")}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/>${links.length ? `<hyperlinks>${links.map((link) => `<hyperlink ref="${link.reference}" r:id="${link.id}"/>`).join("")}</hyperlinks>` : ""}</worksheet>`;
    const historyHeader = historyColumns
      .map(
        (column, index) =>
          `<c r="${columnName(index)}1" s="1" t="inlineStr"><is><t>${xmlEscape(column.label)}</t></is></c>`
      )
      .join("");
    const historyWidths = historyColumns
      .map(
        (column, index) =>
          `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`
      )
      .join("");
    const historyLastRow = historyRows.length + 1;
    const historySheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${historyWidths}</cols><sheetData><row r="1" ht="30" customHeight="1">${historyHeader}</row>${historyRows.join("")}</sheetData><autoFilter ref="A1:I${historyLastRow}"/>${historyLinks.length ? `<hyperlinks>${historyLinks.map((link) => `<hyperlink ref="${link.reference}" r:id="${link.id}"/>`).join("")}</hyperlinks>` : ""}</worksheet>`;
    // ---- גיליון סיכום: נוסחאות על גיליון המודעות, כך שסינון/עריכה שם מתעדכנים כאן
    const range = (key) => `'מודעות'!$${col(key)}$2:$${col(key)}$${Math.max(2, lastRow)}`;
    const typeRange = range("recordType");
    const summaryRows = [];
    const textCell = (ref, text, style = 0) =>
      `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`;
    const formulaCell = (ref, formula, style = 0) =>
      `<c r="${ref}"${style ? ` s="${style}"` : ""}><f>${xmlEscape(formula)}</f></c>`;
    summaryRows.push(`<row r="1" ht="28" customHeight="1">${textCell("A1", "סיכום המידע השמור", 12)}</row>`);
    const totals = [
      ["מודעות שמורות", `COUNTIF(${typeRange},"מודעה")`, 10],
      ["פרויקטים שמורים", `COUNTIF(${typeRange},"פרויקט")`, 10],
      ["מחיר ממוצע (₪)", `IFERROR(AVERAGEIF(${typeRange},"מודעה",${range("price")}),"")`, 5],
      ["מחיר למ״ר חציוני (₪)", `IFERROR(MEDIAN(${range("pricePerSqm")}),"")`, 5],
      ["גיל מודעה ממוצע (ימים)", `IFERROR(AVERAGE(${range("listingAgeDays")}),"")`, 10],
      ["מודעות שירדו במחיר", `COUNTIF(${range("priceChange")},"<0")`, 10],
      ["מודעות עם לחץ גבוה למכור", `COUNTIF(${range("pressureLevel")},"גבוה")`, 10],
      ["מדד לחץ למכור ממוצע", `IFERROR(AVERAGE(${range("sellerPressure")}),"")`, 10],
      ["מודעות תיווך", `COUNTIF(${range("brokerage")},"כן")`, 10],
      ["מרחק ממוצע מהרכבת (מ׳)", `IFERROR(AVERAGE(${range("railMeters")}),"")`, 10],
    ];
    totals.forEach(([label, formula, style], offset) => {
      const row = offset + 3;
      summaryRows.push(`<row r="${row}">${textCell(`A${row}`, label, 13)}${formulaCell(`B${row}`, formula, style)}</row>`);
    });
    const cityHeaderRow = totals.length + 5;
    const cityHeaders = ["עיר", "מודעות", "מחיר ממוצע (₪)", "מחיר למ״ר חציוני (₪)", "גיל ממוצע (ימים)", "ירדו במחיר", "לחץ גבוה למכור"];
    summaryRows.push(
      `<row r="${cityHeaderRow}" ht="26" customHeight="1">${cityHeaders.map((label, i) => textCell(`${columnName(i)}${cityHeaderRow}`, label, 1)).join("")}</row>`
    );
    const cityCounts = new Map();
    for (const [, record] of records) {
      if (record.recordType === "project" || !record.city) continue;
      cityCounts.set(record.city, (cityCounts.get(record.city) || 0) + 1);
    }
    const cityRange = range("city");
    [...cityCounts].sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([city], offset) => {
      const row = cityHeaderRow + 1 + offset;
      const cityRef = `$A${row}`;
      const ppsmValues = cityPpsm.get(city);
      summaryRows.push(`<row r="${row}">${[
        textCell(`A${row}`, city, 13),
        formulaCell(`B${row}`, `COUNTIFS(${cityRange},${cityRef},${typeRange},"מודעה")`, 10),
        formulaCell(`C${row}`, `IFERROR(AVERAGEIFS(${range("price")},${cityRange},${cityRef},${typeRange},"מודעה"),"")`, 5),
        ppsmValues ? `<c r="D${row}" s="5" t="n"><v>${Math.round(median(ppsmValues))}</v></c>` : `<c r="D${row}"/>`,
        formulaCell(`E${row}`, `IFERROR(AVERAGEIFS(${range("listingAgeDays")},${cityRange},${cityRef}),"")`, 10),
        formulaCell(`F${row}`, `COUNTIFS(${cityRange},${cityRef},${range("priceChange")},"<0")`, 10),
        formulaCell(`G${row}`, `COUNTIFS(${cityRange},${cityRef},${range("pressureLevel")},"גבוה")`, 10),
      ].join("")}</row>`);
    });
    const summaryNote = cityHeaderRow + cityCounts.size + 3;
    summaryRows.push(`<row r="${summaryNote}">${textCell(`A${summaryNote}`, "מדד לחץ למכור (0–100): ימים באוויר עד 60 נק׳ (מלא ב־120 יום), ירידת מחיר מהשיא עד 30 נק׳ (מלא ב־10%), מספר הורדות עד 10 נק׳ (מלא ב־3). גבוה = 60 ומעלה, בינוני = 30 ומעלה. גיל המודעה מחושב מחדש בכל פתיחה של הקובץ.", 9)}</row>`);
    const summarySheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1" tabSelected="1"/></sheetViews><cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="7" width="20" customWidth="1"/></cols><sheetData>${summaryRows.join("")}</sheetData></worksheet>`;

    const relationships = [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      ...links.map(
        (link) =>
          `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(link.target)}" TargetMode="External"/>`
      ),
      "</Relationships>",
    ].join("");
    const historyRelationships = [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      ...historyLinks.map(
        (link) =>
          `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(link.target)}" TargetMode="External"/>`
      ),
      "</Relationships>",
    ].join("");
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="סיכום" sheetId="3" r:id="rId4"/><sheet name="מודעות" sheetId="1" r:id="rId1"/><sheet name="היסטוריית מחירים" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="5"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font><font><color rgb="FF0563C1"/><u/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FF167C72"/><sz val="15"/><name val="Arial"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF167C72"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="14"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="3" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1"><alignment vertical="center"/></xf></cellXfs></styleSheet>`;
    return zipFiles([
      ["[Content_Types].xml", contentTypes],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", workbook],
      ["xl/_rels/workbook.xml.rels", workbookRels],
      ["xl/styles.xml", styles],
      ["xl/worksheets/sheet1.xml", sheet],
      ["xl/worksheets/_rels/sheet1.xml.rels", relationships],
      ["xl/worksheets/sheet2.xml", historySheet],
      ["xl/worksheets/_rels/sheet2.xml.rels", historyRelationships],
      ["xl/worksheets/sheet3.xml", summarySheet],
    ]);
  }

  function downloadExcel(blob, date = new Date()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `listing-cache-${date.toISOString().slice(0, 10)}.xlsx`;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return {
    buildCsv,
    downloadCsv,
    buildExcel,
    downloadExcel,
    buildTxt,
    downloadTxt,
    getPriceChanges,
    getPriceTimelineEvents,
    parseCacheKey,
    recordUrl,
  };
})();

if (typeof module !== "undefined") module.exports = LRCacheExport;
