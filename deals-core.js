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
    const byCity = new Map();
    for (const deal of Object.values(store || {})) {
      if (!deal || !(deal.price > 0) || !(deal.sqm > 0) || String(deal.date) < minDate) continue;
      const city = normCity(deal.city);
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city).push(deal);
      const streetKey = `${city}|${normStreet(deal.street)}`;
      if (!byStreet.has(streetKey)) byStreet.set(streetKey, []);
      byStreet.get(streetKey).push(deal);
      if (deal.neighborhood) {
        const hoodKey = `${city}|${cleanText(deal.neighborhood)}`;
        if (!byHood.has(hoodKey)) byHood.set(hoodKey, []);
        byHood.get(hoodKey).push(deal);
      }
    }
    return { byStreet, byHood, byCity, years };
  }

  function summarize(level, deals, listingPpsm, similar) {
    const ppsm = deals.map((deal) => deal.price / deal.sqm);
    const value = median(ppsm);
    const dates = deals.map((deal) => deal.date).sort();
    return {
      level,
      similar,
      count: deals.length,
      medianPpsm: Math.round(value),
      diffPct: Number.isFinite(listingPpsm) && value ? Math.round(((listingPpsm - value) / value) * 1000) / 10 : null,
      fromDate: dates[0],
      toDate: dates[dates.length - 1],
    };
  }

  // עסקה "דומה" למודעה: שטח בטווח ±35% ועד חדר אחד הבדל (כשהם ידועים). בלי זה דופלקס של 228 מ״ר
  // הושווה לדירות רגילות ברחוב ויצא "32% מתחת" – השוואה מטעה.
  function similarTo(record) {
    const sqm = Number(record && record.sqm);
    const rooms = Number(record && record.rooms);
    return (deal) =>
      (!(sqm > 0) || (deal.sqm >= sqm * 0.65 && deal.sqm <= sqm * 1.35)) &&
      (!(rooms > 0) || !(deal.rooms > 0) || Math.abs(deal.rooms - rooms) <= 1);
  }

  // הרמה הכי ספציפית שיש בה מספיק עסקאות: בניין (3+), רחוב (3+), שכונה (5+).
  // קודם רק עסקאות בגודל דומה; אם אין מספיק באף רמה – כל העסקאות, עם similar: false.
  function compareListing(record, index, listingPpsm) {
    if (!record || !index) return null;
    const place = listingPlace(record);
    if (!place.city || !place.street) return null;
    const street = index.byStreet.get(`${place.city}|${place.street}`) || [];
    const building = place.house ? street.filter((deal) => normHouse(deal.house) === place.house) : [];
    const hood = place.neighborhood ? index.byHood.get(`${place.city}|${place.neighborhood}`) || [] : [];
    const levels = [["building", building, 3], ["street", street, 3], ["neighborhood", hood, 5]];
    const similar = similarTo(record);
    for (const [level, deals, minimum] of levels) {
      const close = deals.filter(similar);
      if (close.length >= minimum) return summarize(level, close, listingPpsm, true);
    }
    for (const [level, deals, minimum] of levels) {
      if (deals.length >= minimum) return summarize(level, deals, listingPpsm, false);
    }
    return null;
  }

  // כל ארבע הרמות בנפרד, כל אחת עם מינימום עסקאות משלה. בכל רמה – קודם עסקאות בגודל דומה,
  // ואם אין מספיק, כל הגדלים (similar: false). רמה בלי מספיק עסקאות = null.
  const LEVEL_MINIMUMS = { building: 3, street: 3, neighborhood: 5, city: 10 };

  function compareListingAll(record, index, listingPpsm) {
    const empty = { building: null, street: null, neighborhood: null, city: null };
    if (!record || !index) return empty;
    const place = listingPlace(record);
    if (!place.city) return empty;
    const street = place.street ? index.byStreet.get(`${place.city}|${place.street}`) || [] : [];
    const groups = {
      building: place.house ? street.filter((deal) => normHouse(deal.house) === place.house) : [],
      street,
      neighborhood: place.neighborhood ? index.byHood.get(`${place.city}|${place.neighborhood}`) || [] : [],
      city: (index.byCity && index.byCity.get(place.city)) || [],
    };
    const similar = similarTo(record);
    const result = {};
    for (const [level, deals] of Object.entries(groups)) {
      const minimum = LEVEL_MINIMUMS[level];
      const close = deals.filter(similar);
      result[level] = close.length >= minimum
        ? summarize(level, close, listingPpsm, true)
        : deals.length >= minimum
          ? summarize(level, deals, listingPpsm, false)
          : null;
    }
    return result;
  }

  const LEVEL_LABELS = { building: "בבניין", street: "ברחוב", neighborhood: "בשכונה", city: "בעיר" };
  const LEVEL_NAMES = { building: "בניין", street: "רחוב", neighborhood: "שכונה", city: "עיר" };

  // ---------- חיפוש עסקאות ----------
  function dealPpsm(deal) {
    return deal && deal.price > 0 && deal.sqm > 0 ? Math.round(deal.price / deal.sqm) : null;
  }

  const inRange = (value, min, max) =>
    (!Number.isFinite(min) || (Number.isFinite(value) && value >= min)) &&
    (!Number.isFinite(max) || (Number.isFinite(value) && value <= max));

  // filters: { query, city, source ("yad2" | "madlan" | "both"), rooms/sqm/price/ppsm/year: { min, max } }
  function filterDeals(store, filters = {}) {
    const words = cleanText(filters.query).split(" ").filter(Boolean);
    const city = filters.city ? normCity(filters.city) : "";
    const range = (name) => filters[name] || {};
    const out = [];
    for (const [key, deal] of Object.entries(store || {})) {
      if (!deal || typeof deal !== "object") continue;
      if (city && normCity(deal.city) !== city) continue;
      const sources = deal.sources || [];
      if (filters.source === "both" ? sources.length < 2 : filters.source && !sources.includes(filters.source)) continue;
      if (words.length) {
        const haystack = cleanText(`${deal.city} ${deal.street} ${deal.house} ${deal.neighborhood || ""}`);
        if (!words.every((word) => haystack.includes(word))) continue;
      }
      if (!inRange(deal.rooms, range("rooms").min, range("rooms").max)) continue;
      if (!inRange(deal.sqm, range("sqm").min, range("sqm").max)) continue;
      if (!inRange(deal.price, range("price").min, range("price").max)) continue;
      if (!inRange(dealPpsm(deal), range("ppsm").min, range("ppsm").max)) continue;
      if (!inRange(Number(String(deal.date).slice(0, 4)), range("year").min, range("year").max)) continue;
      out.push([key, deal]);
    }
    return out;
  }

  const SORT_VALUES = {
    date: (deal) => deal.date || "",
    price: (deal) => deal.price,
    ppsm: dealPpsm,
    sqm: (deal) => deal.sqm,
    rooms: (deal) => deal.rooms,
    address: (deal) => `${deal.city} ${deal.street} ${String(deal.house).padStart(5, "0")}`,
  };

  // ערכים חסרים תמיד בסוף, בלי קשר לכיוון המיון
  function sortDeals(list, key = "date", direction = -1) {
    const value = SORT_VALUES[key] || SORT_VALUES.date;
    return [...list].sort(([, a], [, b]) => {
      const left = value(a);
      const right = value(b);
      const leftMissing = left === null || left === undefined || left === "";
      const rightMissing = right === null || right === undefined || right === "";
      if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
      return (typeof left === "string" ? left.localeCompare(right, "he") : left - right) * direction;
    });
  }

  function summarizeDeals(list) {
    const ppsm = list.map(([, deal]) => dealPpsm(deal)).filter(Number.isFinite);
    const prices = list.map(([, deal]) => deal.price).filter(Number.isFinite);
    const dates = list.map(([, deal]) => deal.date).filter(Boolean).sort();
    return {
      count: list.length,
      medianPpsm: ppsm.length ? Math.round(median(ppsm)) : null,
      medianPrice: prices.length ? Math.round(median(prices)) : null,
      fromDate: dates[0] || null,
      toDate: dates[dates.length - 1] || null,
    };
  }

  // עסקאות לפי עיר ולפי שכונה בשנים האחרונות (ללוח הבקרה). years: כמה שנים כולל השנה הנוכחית.
  function dealsByArea(store, { years = 3, now = Date.now() } = {}) {
    const lastYear = new Date(now).getFullYear();
    const yearList = Array.from({ length: years }, (_, index) => lastYear - years + 1 + index);
    const firstYear = yearList[0];
    const cities = new Map();
    const hoods = new Map();
    const add = (map, key, extra, deal, year) => {
      const entry = map.get(key) || { ...extra, count: 0, byYear: Object.fromEntries(yearList.map((y) => [y, 0])), ppsm: [], prices: [] };
      entry.count++;
      entry.byYear[year]++;
      const ppsm = dealPpsm(deal);
      if (Number.isFinite(ppsm)) entry.ppsm.push(ppsm);
      if (deal.price > 0) entry.prices.push(deal.price);
      map.set(key, entry);
    };
    for (const deal of Object.values(store || {})) {
      if (!deal || !deal.city) continue;
      const year = Number(String(deal.date).slice(0, 4));
      if (!(year >= firstYear && year <= lastYear)) continue;
      add(cities, normCity(deal.city), { city: deal.city }, deal, year);
      if (deal.neighborhood) {
        add(hoods, `${normCity(deal.city)}|${cleanText(deal.neighborhood)}`, { city: deal.city, neighborhood: deal.neighborhood }, deal, year);
      }
    }
    const finish = (entry) => ({
      ...entry,
      medianPpsm: entry.ppsm.length ? Math.round(median(entry.ppsm)) : null,
      medianPrice: entry.prices.length ? Math.round(median(entry.prices)) : null,
      ppsm: undefined,
      prices: undefined,
    });
    const byCount = (a, b) => b.count - a.count;
    return {
      years: yearList,
      cities: [...cities.values()].map(finish).sort(byCount),
      neighborhoods: [...hoods.values()].map(finish).sort(byCount),
    };
  }

  // מפתח מקום של מודעה או עסקה – להצלבה בין עסקאות למודעות שמורות באותה כתובת
  function placeKey(city, street, house = "") {
    return `${normCity(city)}|${normStreet(street)}|${normHouse(house)}`;
  }

  return {
    STORAGE_KEY,
    FETCH_LOG_KEY,
    LEVEL_LABELS,
    LEVEL_NAMES,
    LEVEL_MINIMUMS,
    compareListingAll,
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
    dealPpsm,
    filterDeals,
    sortDeals,
    summarizeDeals,
    dealsByArea,
    placeKey,
  };
})();

if (typeof module !== "undefined") module.exports = LRDeals;
