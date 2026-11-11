// Madlan exposes listing address and map-point data in its hydrated listing payload.
var LRMadlan = (() => {
  function listingId(root) {
    if (root === document) {
      const pageMatch = location.pathname.match(/\/(?:listings|bulletin)\/([^/]+)/);
      if (pageMatch) return pageMatch[1];
    }
    const card = root.closest
      ? root.closest("[data-auto='listed-bulletin'][data-auto-bulletin-id]")
      : root.matches && root.matches("[data-auto='listed-bulletin'][data-auto-bulletin-id]")
        ? root
        : null;
    const cardId = card && card.getAttribute("data-auto-bulletin-id");
    if (cardId) return cardId;
    const listingLink = root.querySelector
      ? root.querySelector('a[data-auto="listed-bulletin-clickable"][href], a[href*="/listings/"]')
      : null;
    const links = listingLink
      ? [listingLink]
      : root.querySelectorAll
        ? root.querySelectorAll("a[href]")
        : [];
    for (const link of links) {
      try {
        const path = new URL(link.href, location.href).pathname;
        const match = path.match(/\/(?:listings|bulletin)\/([^/]+)/);
        if (match) return match[1];
      } catch {}
    }
    const match = location.pathname.match(/\/(?:listings|bulletin)\/([^/]+)/);
    return match ? match[1] : null;
  }

  function listingUrl(root) {
    if (root === document && /\/(?:listings|bulletin)\//.test(location.pathname)) {
      return location.href;
    }
    const link = root.querySelector
      ? root.querySelector('a[data-auto="listed-bulletin-clickable"][href], a[href*="/listings/"], a[href*="/bulletin/"]')
      : null;
    return link ? new URL(link.href, location.href).href : null;
  }

  // סריקת כל תגי ה-script בדף (מגה-בייטים של JSON) בכל רענון ולכל כרטיס הייתה יקרה מאוד.
  // התוצאות נשמרות עד שתוכן הסקריפטים בדף משתנה (מספר הסקריפטים / האורך הכולל / הכתובת).
  let scriptMemoSignature = "";
  const scriptMemo = new Map();

  // חתימה זולה: כתובת, מספר הסקריפטים ואורך הסקריפט האחרון (בלי לקרוא מגה-בייטים בכל קריאה)
  function scriptsSignature() {
    const scripts = document.scripts;
    const last = scripts.length ? scripts[scripts.length - 1] : null;
    return `${location.href}|${scripts.length}|${last ? (last.textContent || "").length : 0}`;
  }

  function memoByScripts(key, compute) {
    const signature = scriptsSignature();
    if (signature !== scriptMemoSignature) {
      scriptMemoSignature = signature;
      scriptMemo.clear();
    }
    if (scriptMemo.has(key)) return scriptMemo.get(key);
    const value = compute();
    scriptMemo.set(key, value);
    return value;
  }

  // מדלן שולחת את כל נתוני הדף באובייקט אחד: window.__SSR_HYDRATED_CONTEXT__={...}.
  // מפענחים אותו פעם אחת לדף ובונים אינדקס לפי מזהה מודעה (במקום חיפוש regex לכל כרטיס).
  // אחרי מעבר עמוד בלי טעינה מחדש הנתונים בדף נשארים של העמוד הקודם – אז מזהה לא יימצא
  // והקוד חוזר לקריאה מהכרטיס עצמו.
  const SSR_PREFIX = "window.__SSR_HYDRATED_CONTEXT__=";

  function parseSsrContext(source) {
    let body = source.slice(SSR_PREFIX.length).trim().replace(/;\s*$/, "");
    try {
      return JSON.parse(body);
    } catch {}
    // האובייקט הוא JavaScript ולא JSON תקין: יש בו undefined כערך
    body = body.replace(/([:,\[])undefined(?=\s*[,}\]])/g, "$1null");
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  function buildListingIndex(context) {
    const index = new Map();
    const seen = new Set();
    const stack = [context];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (typeof node.id === "string" && node.locationPoint && typeof node.locationPoint === "object") {
        const existing = index.get(node.id);
        // אותה מודעה מופיעה כמה פעמים (חיפוש, קרוסלות, עמוד המודעה) – שומרים את המלאה ביותר
        if (!existing || Object.keys(node).length > Object.keys(existing).length) index.set(node.id, node);
      }
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === "object") stack.push(value);
      }
    }
    return index;
  }

  function listingIndex() {
    return memoByScripts("index", () => {
      for (const script of document.scripts) {
        const source = script.textContent || "";
        if (!source.startsWith(SSR_PREFIX)) continue;
        const context = parseSsrContext(source);
        return context ? buildListingIndex(context) : null;
      }
      return null;
    });
  }

  function indexedListing(id) {
    const index = id ? listingIndex() : null;
    return index ? index.get(id) || null : null;
  }

  // היסטוריית המחירים של מדלן עצמה: [{price, at}] לפי סדר הזמן
  function priceEvents(listing) {
    const events = listing && Array.isArray(listing.eventsHistory) ? listing.eventsHistory : [];
    return events
      .map((event) => ({ price: Number(event && event.price), at: Date.parse(event && event.date) }))
      .filter((event) => Number.isFinite(event.price) && event.price > 0 && Number.isFinite(event.at))
      .sort((a, b) => a.at - b.at);
  }

  function readListingDate(id, keys) {
    if (!id) return null;
    return memoByScripts(`date|${id}|${keys.join(",")}`, () => scanListingDate(id, keys));
  }

  function scanListingDate(id, keys) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idMarker = new RegExp(`["']id["']\\s*:\\s*["']${escapedId}["']`, "g");
    for (const script of document.scripts) {
      const source = script.textContent || "";
      let match;
      while ((match = idMarker.exec(source))) {
        const start = Math.max(0, match.index - 1000);
        const listingText = source.slice(start, Math.min(source.length, match.index + 12000));
        for (const key of keys) {
          const field = new RegExp(
            `["']${key}["']\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|(\\d{10,13}))`
          );
          const value = field.exec(listingText);
          if (value) {
            return value[1] !== undefined
              ? decodeJsonString(value[1])
              : Number(value[2]);
          }
        }
        idMarker.lastIndex = match.index + match[0].length;
      }
      idMarker.lastIndex = 0;
    }
    return null;
  }

  function listingExportData(root) {
    const roomsElement =
      root.querySelector('[data-auto="beds-count"]') ||
      (root === document ? null : root.querySelector('[data-auto="property-rooms"]'));
    const roomsMatch = roomsElement && roomsElement.innerText.match(/\d+(?:[.,]\d+)?/);
    const rooms = roomsMatch ? Number(roomsMatch[0].replace(",", ".")) : null;
    const id = listingId(root);
    const listing = indexedListing(id);
    const events = priceEvents(listing);
    // firstTimeSeen = מתי מדלן ראתה את המודעה לראשונה; אירוע "new" בהיסטוריה כגיבוי
    // כשהמודעה נמצאה בנתוני הדף לא מחפשים בטקסט: חיפוש כזה מוצא גם updatedAt של נתוני משקיעים
    const createdAt = listing
      ? listing.firstTimeSeen || (events.length ? new Date(events[0].at).toISOString() : null)
      : readListingDate(id, ["releaseDate", "createdAt", "publishedAt"]);
    const updatedAt = listing
      ? listing.lastUpdated || null
      : readListingDate(id, ["updatedAt", "lastUpdatedAt", "modifiedAt"]);
    // קומה מנתוני הדף ("6", "0", "קרקע"); בלעדיה אי אפשר להבדיל בין דירות זהות בקומות שונות
    const floorText = listing && listing.floor !== undefined && listing.floor !== null ? String(listing.floor).trim() : "";
    const floor = /^-?\d{1,3}$/.test(floorText) ? Number(floorText) : /קרקע/.test(floorText) ? 0 : null;
    return {
      rooms: Number.isFinite(rooms) ? rooms : null,
      floor,
      // המחיר הקודם שמוצג מחוק בכרטיס (לפני הורדת המחיר האחרונה) – חשוב כשאין נתוני דף
      previousPrice: root === document ? null : cardPreviousPrice(root),
      listingCreatedAt: createdAt,
      listingUpdatedAt: updatedAt,
      priceEvents: events.length ? events : null,
    };
  }

  function priceFromText(value) {
    const digits = String(value || "").replace(/[‎‏‪-‮]/g, "").match(/\d{1,3}(?:,\d{3})+|\d{5,}/);
    const price = digits ? Number(digits[0].replace(/,/g, "")) : NaN;
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function cardPreviousPrice(root) {
    const element = root.querySelector && root.querySelector('[data-auto="property-prevous-price"]');
    return element ? priceFromText(element.textContent) : null;
  }

  // כרטיס פרויקט בתוצאות חיפוש: מקשר ל־‎/projects/‎ ומציג "החל מ־" (property-min-price)
  function isProjectCard(root) {
    if (!root || root === document || !root.querySelector) return false;
    if (root.querySelector('[data-auto="property-min-price"]')) return true;
    const link = root.querySelector('a[data-auto="listed-bulletin-clickable"][href]');
    if (!link) return false;
    try {
      return /^\/projects\//i.test(new URL(link.href, location.href).pathname);
    } catch {
      return false;
    }
  }

  function isProjectPage(path) {
    return (
      /^\/projects\/[^/]+\/?$/.test(path) ||
      Boolean(document.querySelector('[data-testid="project-address"]'))
    );
  }

  function isProjectListingPage(path) {
    return /^\/projects-for-(?:sale|rent)(?:\/|$)/i.test(path);
  }

  function searchCityContext(path, title) {
    if (!/^\/for-(?:sale|rent)(?:\/|$)/i.test(path)) return null;
    try {
      const segment = decodeURIComponent(path).split("/").filter(Boolean)[1] || "";
      if (segment.includes(",")) return null;
      const pathCities = LR.findCities(segment);
      if (pathCities.length === 1) return pathCities[0];
      if (pathCities.length > 1) return null;
    } catch {}

    const titleText = String(title || "");
    if (!/(?:למכירה|להשכרה)/.test(titleText)) return null;
    const titleCities = LR.findCities(titleText);
    return titleCities.length === 1 ? titleCities[0] : null;
  }

  function projectExportData(root, text) {
    if (!isProjectPage(location.pathname)) return null;
    const id = location.pathname.match(/^\/projects\/([^/]+)\/?$/);
    const addressElement = root.querySelector('[data-testid="project-address"]');
    const titleElement = root.querySelector('[data-testid="project-title"], h1');
    const address = addressElement ? addressElement.innerText.trim() : "";
    const parsedAddress = LR.parseAddress(address, null);
    const stats = LR.extractPriceSqm(text);
    return {
      id: id ? id[1] : location.pathname.split("/").filter(Boolean).pop(),
      title: titleElement ? titleElement.innerText.trim() : "",
      address,
      city: parsedAddress.city || "",
      neighborhood: parsedAddress.hood || "",
      coordinates: null,
      price: stats.price,
      sqm: stats.sqm,
      pricePerSqm: stats.ppsm,
      url: location.href,
      recordType: "project",
    };
  }

  function decodeJsonString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value;
    }
  }

  function listingData(root) {
    const id = listingId(root);
    if (!id) return null;
    const data = memoByScripts(`data|${id}`, () => indexedLocation(indexedListing(id)) || scanListingData(id));
    // עותק, כדי שקוד שמשנה את התוצאה לא ישנה את המטמון
    return data ? { ...data, coordinates: data.coordinates ? { ...data.coordinates } : null } : null;
  }

  function indexedLocation(listing) {
    const point = listing && listing.locationPoint;
    if (!point || point.lat === null || point.lng === null) return null;
    const lat = Number(point.lat);
    const lon = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const address = listing.addressDetails || {};
    const text = (value) => (value === null || value === undefined || value === "" ? null : String(value));
    return {
      coordinates: { lat, lon },
      city: text(address.city),
      street: text(address.streetName),
      number: text(address.streetNumber),
    };
  }

  function scanListingData(id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scripts = [...document.scripts].map((script) => script.textContent || "");
    for (const source of scripts) {
      const directMarker = new RegExp(
        `["']id["']\\s*:\\s*["']${escapedId}["']\\s*,\\s*["']locationPoint["']\\s*:\\s*\\{\\s*["']lat["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*["']lng["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`
      );
      const directPoint = directMarker.exec(source);
      if (directPoint) {
        const addressStart = source.indexOf('"addressDetails"', directPoint.index);
        const addressTail =
          addressStart >= 0 ? source.slice(addressStart, addressStart + 5000) : "";
        const address = addressTail.match(
          /["']addressDetails["']\s*:\s*\{[\s\S]{0,3000}?["']city["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1000}?["']streetName["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,500}?["']streetNumber["']\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        return {
          coordinates: { lat: Number(directPoint[1]), lon: Number(directPoint[2]) },
          city: address ? decodeJsonString(address[1]) : null,
          street: address ? decodeJsonString(address[2]) : null,
          number: address ? decodeJsonString(address[3]) : null,
        };
      }
      const marker = new RegExp(`["']id["']\\s*:\\s*["']${escapedId}["']`, "g");
      let match;
      while ((match = marker.exec(source))) {
        const tail = source.slice(match.index, match.index + 5000);
        const point = tail.match(
          /["']locationPoint["']\s*:\s*\{\s*["']lat["']\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*["']lng["']\s*:\s*(-?\d+(?:\.\d+)?)/
        );
        if (!point) {
          marker.lastIndex = match.index + match[0].length;
          continue;
        }
        const address = tail.match(
          /["']addressDetails["']\s*:\s*\{[\s\S]{0,3000}?["']city["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,1000}?["']streetName["']\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,500}?["']streetNumber["']\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        return {
          coordinates: { lat: Number(point[1]), lon: Number(point[2]) },
          city: address ? decodeJsonString(address[1]) : null,
          street: address ? decodeJsonString(address[2]) : null,
          number: address ? decodeJsonString(address[3]) : null,
        };
      }
    }
    return null;
  }

  function readAddress(root, text, ctxCity, single) {
    const data = listingData(root);
    const projectPage = isProjectPage(location.pathname);
    const imageElement =
      !projectPage && !single
        ? root.querySelector('[data-auto="universal-card-image"][alt]')
        : null;
    const imageAddress = String((imageElement && imageElement.alt) || "").trim();
    const propertyAddressElement =
      !projectPage && !single ? root.querySelector('[data-auto="property-address"]') : null;
    const usePropertyAddress = !imageAddress && Boolean(propertyAddressElement);
    const addressElement = projectPage
      ? root.querySelector('[data-testid="project-address"]')
      : single
        ? root.querySelector(
            '[data-auto="primary_address_text"], [data-testid="address"]'
          )
        : imageAddress
          ? imageElement
          : propertyAddressElement ||
            root.querySelector('[data-auto="primary_address_text"], [data-testid="address"]');
    const addressText = imageAddress
      ? imageAddress
      : addressElement
        ? addressElement.innerText || addressElement.textContent || ""
        : projectPage
          ? ""
          : String(text || "").replace(/Top\s*\d+\s*במדד\s*המתווכים/gi, "");
    const parsed = single
      ? LR.parseAny(addressText, ctxCity)
      : LR.parseAddress(addressText, ctxCity);
    if (usePropertyAddress && !(data && data.street && data.number && data.city)) {
      const cardAddress = LR.parseAddress(addressText, null);
      const hood = cardAddress.hood || cardAddress.city;
      const city = (data && data.city) || ctxCity;
      if (city) {
        const withCity = cardAddress.street
          ? LR.parseAddress(`${cardAddress.street}, ${city}`, city)
          : LR.parseAddress(city, city);
        return {
          ...withCity,
          city,
          hood,
          coordinates: (data && data.coordinates) || null,
        };
      }
      return {
        ...cardAddress,
        city: data && data.city ? data.city : null,
        hood,
        queries: [],
        coordinates: data && data.coordinates ? data.coordinates : null,
      };
    }
    if (!data) return { ...parsed, coordinates: null };
    if (data.street && data.number && data.city) {
      const structured = LR.parseAddress(
        `${data.street} ${data.number}, ${data.city}`,
        ctxCity
      );
      return { ...structured, coordinates: data.coordinates };
    }
    return { ...parsed, coordinates: data.coordinates };
  }

  function extractPriceSqm(root, rawText) {
    // המחיר הקודם (מחוק) בכרטיס הוא לא המחיר – מוציאים אותו מהטקסט לפני חיפוש מחיר בטקסט
    const previousElement =
      root !== document && root.querySelector
        ? root.querySelector('[data-auto="property-prevous-price"]')
        : null;
    const previousDigits = previousElement
      ? String(previousElement.textContent || "").match(/\d{1,3}(?:,\d{3})+|\d{5,}/)
      : null;
    const text = previousDigits ? String(rawText || "").split(previousDigits[0]).join(" ") : rawText;
    const areaElement =
      root === document
        ? root.querySelector('[data-auto="area"]')
        : root.querySelector('[data-auto="property-size"]') ||
          root.querySelector('[data-auto="area"]');
    if (!areaElement) return LR.extractPriceSqm(text);

    const areaMatch = String(areaElement.innerText || areaElement.textContent || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .match(
        /^\s*(\d{1,3}(?:,\d{3})+|\d{2,4}(?:[.,]\d+)?)\s*(?:מ["״”'׳]?ר)?\s*$/i
    );
    if (!areaMatch) return LR.extractPriceSqm(text);

    const areaText = areaMatch[1];
    const normalizedArea = /^\d{1,3}(?:,\d{3})+$/.test(areaText)
      ? areaText.replace(/,/g, "")
      : areaText.replace(",", ".");
    const normalizedSqm = Number(normalizedArea);
    if (!Number.isFinite(normalizedSqm) || normalizedSqm < 15 || normalizedSqm > 1000) {
      return LR.extractPriceSqm(text);
    }

    const priceElement =
      root === document
        ? root.querySelector('[data-auto="current-price"]') ||
          root.querySelector('[data-auto="property-price"]')
        : root.querySelector('[data-auto="property-price"]') ||
          root.querySelector('[data-auto="current-price"]');
    const sourceText = priceElement
      ? `${priceElement.innerText || priceElement.textContent}\n${normalizedSqm} מ״ר`
      : `${text}\n${normalizedSqm} מ״ר`;
    return LR.extractPriceSqm(sourceText);
  }

  const AMENITY_KEYS = [
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

  // מאפייני הנכס מנתוני הדף. מרפסת/גינה/מחסן/חניה מופיעים לפעמים רק כשטחים (additionalAreas)
  // או כמספר חניות – בדיוק כמו שמדלן מציגה אותם ברשימה בעמוד.
  function dataAmenities(listing) {
    const amenities = listing && listing.amenities;
    if (!amenities || typeof amenities !== "object") return null;
    const areas = amenities.additionalAreas || {};
    const hasAreas = (...values) =>
      values.some((value) => (Array.isArray(value) ? value.length > 0 : Number(value) > 0));
    const known = (value) => (typeof value === "boolean" ? value : null);
    const derived = (value, fallback) => (typeof value === "boolean" ? value || fallback : fallback || null);
    return {
      parking: Number.isFinite(Number(listing.parking)) && listing.parking !== null ? Number(listing.parking) > 0 : null,
      secureRoom: known(amenities.secureRoom),
      elevator: known(amenities.elevator),
      storage: derived(amenities.storage, hasAreas(areas.warehouseAreas, areas.storeroomArea)),
      airConditioner: known(amenities.airConditioner),
      accessible: known(amenities.accessible),
      balcony: derived(amenities.balcony, hasAreas(areas.balconyAreas, areas.balconiesArea)),
      sunBoiler: known(amenities.sunBoiler),
      grating: known(amenities.grating),
      garden: derived(amenities.garden, hasAreas(areas.gardenAreas)),
      pool: known(amenities.pool),
    };
  }

  function checklistAmenity(checklist, key) {
    const item = checklist.querySelector(`[data-auto-checklist-amenity-item="${key}"]`);
    if (!item) return false;
    const rect = item.querySelector("svg rect");
    return Boolean(rect && rect.getAttribute("fill") === "#018489");
  }

  function readAmenities(root) {
    const checklist = root.querySelector('[data-auto="amenities-checklist-block"]');
    if (!checklist) return null;
    // קודם נתוני הדף (לא תלויים בצבע האייקון); מה שלא ידוע שם – לפי צבע הסימון ברשימה
    const fromData = root === document ? dataAmenities(indexedListing(listingId(root))) : null;
    const result = {};
    for (const key of AMENITY_KEYS) {
      const value = fromData ? fromData[key] : null;
      result[key] = typeof value === "boolean" ? value : checklistAmenity(checklist, key);
    }
    return result;
  }

  // עמוד מודעה במדלן: "המודעה הוסרה … אינה זמינה יותר" = הוסרה; עמוד עם פרטי נכס (שטח/מחיר) = פעילה
  // מודעה שהוסרה: הקישור /listings/ID מנתב לעמוד חיפוש (/for-sale/…) עם ההודעה – אז אין מזהה בכתובת
  // (redirected: true), והמנהל משייך את התוצאה למודעה שהוא עצמו פתח באותה לשונית.
  function listingPageStatus(root = document) {
    const text = String((root.body && (root.body.innerText || root.body.textContent)) || "").replace(/\s+/g, " ");
    const removed = text.includes("המודעה הוסרה") && text.includes("אינה זמינה יותר");
    const match = location.pathname.match(/\/(?:listings|bulletin)\/([^/?#]+)/);
    if (!match) {
      if (!removed) return null;
      // הניתוב של מדלן הוא בתוך אותו עמוד (history), כך שהכתובת המקורית שמורה ברשומת הניווט
      let originalId = null;
      try {
        const nav = typeof performance !== "undefined" && performance.getEntriesByType
          ? performance.getEntriesByType("navigation")[0]
          : null;
        const original = nav && nav.name ? new URL(nav.name).pathname.match(/\/(?:listings|bulletin)\/([^/?#]+)/) : null;
        originalId = original ? original[1] : null;
      } catch {}
      return { id: originalId, status: "removed", redirected: true };
    }
    const id = match[1];
    if (removed) return { id, status: "removed" };
    if (root.querySelector('[data-auto="area"]') || root.querySelector('[data-auto="current-price"]')) {
      return { id, status: "active" };
    }
    return null;
  }

  return {
    listingPageStatus,
    listingId,
    listingUrl,
    readAddress,
    searchCityContext,
    listingExportData,
    projectExportData,
    extractPriceSqm,
    readAmenities,
    isProjectCard,
    isProjectPage,
    isProjectListingPage,
  };
})();
