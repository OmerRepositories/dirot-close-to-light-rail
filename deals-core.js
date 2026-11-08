// עסקאות אמת (רשות המסים) כפי שיד2 ומדלן מציגות אותן בעמוד מודעה.
// אותה עסקה מופיעה בשני האתרים, לכן המפתח נבנה מהתוכן ולא ממזהה של אתר:
// עיר | רחוב מנורמל | מספר בית | תאריך עסקה | מחיר. עסקה שנראתה בשני האתרים נשמרת פעם אחת עם שני המקורות.
var LRDeals = (() => {
  const STORAGE_KEY = "lightrailDeals";
  const FETCH_LOG_KEY = "lightrailDealsFetched";
  const MAX_DEALS = 60000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // מילים שמופיעות לפעמים לפני שם הרחוב ולפעמים לא
  const STREET_PREFIXES = new Set(["רחוב", "רח", "שדרות", "שד", "שדרת", "דרך", "סמטת", "סמ"]);

  function cleanText(value) {
    return String(value || "")
      .replace(/[‎‏‪-‮]/g, "")
      .replace(/["'`״׳]/g, "")
      .replace(/[-–־,.()/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normCity(city) {
    return cleanText(city);
  }

  // סדר המילים לא משנה ("אמיר בנימיני" = "בנימיני אמיר"), כי האתרים לא תמיד כותבים באותו סדר
  function normStreet(street) {
    return cleanText(street)
      .split(" ")
      .filter((word) => word && !STREET_PREFIXES.has(word))
      .sort()
      .join(" ");
  }

  function normHouse(house) {
    const match = cleanText(house).match(/^(\d{1,4})\s*([א-ת])?$/);
    return match ? `${Number(match[1])}${match[2] || ""}` : "";
  }

  function normDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
  }

  function dealKey(deal) {
    if (!deal) return null;
    const city = normCity(deal.city);
    const street = normStreet(deal.street);
    const house = normHouse(deal.house);
    const date = normDate(deal.date);
    const price = Math.round(Number(deal.price));
    if (!city || !street || !house || !date || !(price > 0)) return null;
    return `${city}|${street}|${house}|${date}|${price}`;
  }

  const finite = (value, min, max) => {
    const number = Number(value);
    return value !== null && value !== "" && Number.isFinite(number) && number >= min && number <= max ? number : null;
  };

  function build(fields, source) {
    const deal = {
      city: String(fields.city || "").trim(),
      street: String(fields.street || "").trim(),
      house: normHouse(fields.house),
      neighborhood: fields.neighborhood ? String(fields.neighborhood).trim() : null,
      date: normDate(fields.date),
      price: finite(fields.price, 10000, 1e9),
      sqm: finite(fields.sqm, 10, 2000),
      rooms: finite(fields.rooms, 0.5, 30),
      floor: finite(fields.floor, -5, 200),
      totalFloors: finite(fields.totalFloors, 0, 200),
      buildYear: finite(fields.buildYear, 1800, 2100),
      propertyType: fields.propertyType ? String(fields.propertyType).trim() : null,
      sources: [source],
    };
    const key = dealKey(deal);
    return key ? { key, deal } : null;
  }

  // תוצאה מ-gw.yad2.co.il/latest-deals-completed
  function fromYad2(result) {
    if (!result || typeof result !== "object") return null;
    const address = result.address || {};
    return build({
      city: address.city && address.city.text,
      street: address.street && address.street.text,
      house: address.houseNumber,
      neighborhood: address.neighborhood && address.neighborhood.text,
      date: result.saleDate,
      price: result.price,
      sqm: result.buildingMR,
      rooms: result.rooms,
      floor: result.floor,
      totalFloors: result.numberOfFloors,
      buildYear: result.buildYear,
      propertyType: result.propertyType,
    }, "yad2");
  }

  // שורה מטבלת העסקאות של מדלן. הכתובת היא "רחוב מספר" בלי עיר – העיר באה מהמודעה.
  function fromMadlan(row, city) {
    if (!row || typeof row !== "object" || row.action !== "sale" || row.isFinal === false) return null;
    const address = cleanText(row.address);
    const match = address.match(/^(.*?)\s+(\d{1,4}\s*[א-ת]?)$/) || address.match(/^(\d{1,4}\s*[א-ת]?)\s+(.*)$/);
    if (!match) return null;
    const numberFirst = /^\d/.test(match[1]);
    return build({
      city,
      street: numberFirst ? match[2] : match[1],
      house: numberFirst ? match[1] : match[2],
      date: row.date,
      price: row.price,
      sqm: row.size,
      rooms: row.beds,
      floor: row.floor,
      totalFloors: row.totalFloors,
      buildYear: row.year,
    }, "madlan");
  }

  // מיזוג עסקה קיימת עם חדשה: איחוד מקורות, השלמת שדות חסרים (לא דורסים ערך קיים)
  function mergeDeal(existing, incoming, now) {
    if (!existing) return { deal: { ...incoming, firstSeenAt: now, updatedAt: now }, changed: true };
    const merged = { ...existing };
    let changed = false;
    for (const [field, value] of Object.entries(incoming)) {
      if (field === "sources") continue;
      if ((merged[field] === null || merged[field] === undefined || merged[field] === "") && value !== null && value !== undefined && value !== "") {
        merged[field] = value;
        changed = true;
      }
    }
    const sources = [...new Set([...(existing.sources || []), ...(incoming.sources || [])])].sort();
    if (sources.length !== (existing.sources || []).length) {
      merged.sources = sources;
      changed = true;
    }
    if (changed) merged.updatedAt = now;
    return { deal: changed ? merged : existing, changed };
  }

  function mergeAll(store, items, now = Date.now()) {
    const next = { ...(store && typeof store === "object" ? store : {}) };
    let added = 0;
    let updated = 0;
    for (const item of items) {
      if (!item || !item.key) continue;
      const existed = Boolean(next[item.key]);
      const { deal, changed } = mergeDeal(next[item.key], item.deal, now);
      if (!changed) continue;
      next[item.key] = deal;
      if (existed) updated++;
      else added++;
    }
    const keys = Object.keys(next);
    if (keys.length > MAX_DEALS) {
      // שומרים את החדשות ביותר לפי תאריך העסקה
      keys.sort((a, b) => String(next[a].date).localeCompare(String(next[b].date)));
      for (const key of keys.slice(0, keys.length - MAX_DEALS)) delete next[key];
    }
    return { store: next, added, updated };
  }

  // ---------- השוואת מודעה לעסקאות ----------
  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // מודעה: הכתובת נשמרת כ"רחוב מספר, עיר"
  function listingPlace(record) {
    const first = String((record && record.address) || "").split(",")[0];
    const text = cleanText(first);
    const match = text.match(/^(.*?)\s+(\d{1,4}\s*[א-ת]?)$/);
    return {
      city: normCity(record && record.city),
      street: normStreet(match ? match[1] : text),
      house: match ? normHouse(match[2]) : "",
      neighborhood: cleanText(record && record.neighborhood),
    };
  }

  function buildIndex(store, { years = 4, now = Date.now() } = {}) {
    const minDate = new Date(now - years * 365 * DAY_MS).toISOString().slice(0, 10);
    const byStreet = new Map();
    const byHood = new Map();
    for (const deal of Object.values(store || {})) {
      if (!deal || !(deal.price > 0) || !(deal.sqm > 0) || String(deal.date) < minDate) continue;
      const city = normCity(deal.city);
      const streetKey = `${city}|${normStreet(deal.street)}`;
      if (!byStreet.has(streetKey)) byStreet.set(streetKey, []);
      byStreet.get(streetKey).push(deal);
      if (deal.neighborhood) {
        const hoodKey = `${city}|${cleanText(deal.neighborhood)}`;
        if (!byHood.has(hoodKey)) byHood.set(hoodKey, []);
        byHood.get(hoodKey).push(deal);
      }
    }
    return { byStreet, byHood, years };
  }

  function summarize(level, deals, listingPpsm) {
    const ppsm = deals.map((deal) => deal.price / deal.sqm);
    const value = median(ppsm);
    const dates = deals.map((deal) => deal.date).sort();
    return {
      level,
      count: deals.length,
      medianPpsm: Math.round(value),
      diffPct: Number.isFinite(listingPpsm) && value ? Math.round(((listingPpsm - value) / value) * 1000) / 10 : null,
      fromDate: dates[0],
      toDate: dates[dates.length - 1],
    };
  }

  // הרמה הכי ספציפית שיש בה מספיק עסקאות: בניין (3+), רחוב (3+), שכונה (5+)
  function compareListing(record, index, listingPpsm) {
    if (!record || !index) return null;
    const place = listingPlace(record);
    if (!place.city || !place.street) return null;
    const street = index.byStreet.get(`${place.city}|${place.street}`) || [];
    const building = place.house ? street.filter((deal) => normHouse(deal.house) === place.house) : [];
    if (building.length >= 3) return summarize("building", building, listingPpsm);
    if (street.length >= 3) return summarize("street", street, listingPpsm);
    const hood = place.neighborhood ? index.byHood.get(`${place.city}|${place.neighborhood}`) || [] : [];
    if (hood.length >= 5) return summarize("neighborhood", hood, listingPpsm);
    return null;
  }

  const LEVEL_LABELS = { building: "בבניין", street: "ברחוב", neighborhood: "בשכונה" };

  return {
    STORAGE_KEY,
    FETCH_LOG_KEY,
    LEVEL_LABELS,
    normStreet,
    normCity,
    normHouse,
    dealKey,
    fromYad2,
    fromMadlan,
    mergeDeal,
    mergeAll,
    listingPlace,
    buildIndex,
    compareListing,
  };
})();

if (typeof module !== "undefined") module.exports = LRDeals;
