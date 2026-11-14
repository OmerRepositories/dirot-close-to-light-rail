// עסקאות אמת (רשות המסים) כפי שיד2 ומדלן מציגות אותן בעמוד מודעה.
// אותה עסקה מופיעה בשני האתרים, לכן המפתח נבנה מהתוכן ולא ממזהה של אתר:
// עיר | רחוב מנורמל | מספר בית | תאריך עסקה | מחיר. עסקה שנראתה בשני האתרים נשמרת פעם אחת עם שני המקורות.
var LRDeals = (() => {
  // הפורמט הישן: כל העסקאות של כל הערים במפתח אחד. היום כל עיר נשמרת במפתח משלה
  // ("lightrailDeals:בת ים"), כדי שמודעה תקרא ותכתוב רק את העסקאות של העיר שלה
  const STORAGE_KEY = "lightrailDeals";
  const SHARD_PREFIX = "lightrailDeals:";
  const FETCH_LOG_KEY = "lightrailDealsFetched";
  // כל מודעה ביד2 מביאה עד 10,000 עסקאות; אזורים חופפים, אז בפועל הרבה פחות עסקאות ייחודיות
  const MAX_DEALS = 200000;
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

  // אותם שמות ערים/רחובות חוזרים עשרות אלפי פעמים – זוכרים את התוצאה במקום להריץ שוב את הביטויים הרגולריים
  function memoText(fn) {
    const cache = new Map();
    return (value) => {
      const key = value ? String(value) : "";
      let result = cache.get(key);
      if (result === undefined) {
        result = fn(key);
        if (cache.size > 50000) cache.clear();
        cache.set(key, result);
      }
      return result;
    };
  }

  const normCity = memoText((city) => cleanText(city));

  // סדר המילים לא משנה ("אמיר בנימיני" = "בנימיני אמיר"), כי האתרים לא תמיד כותבים באותו סדר
  const normStreet = memoText((street) =>
    cleanText(street)
      .split(" ")
      .filter((word) => word && !STREET_PREFIXES.has(word))
      .sort()
      .join(" ")
  );

  // "שכונת שיפר" = "שיפר"; כתיב מלא/חסר ("נווה"/"נוה") לא משנה
  const normHood = memoText((hood) =>
    cleanText(hood)
      .replace(/^(?:שכונת|שכונה|שכ)\s+/, "")
      .replace(/וו/g, "ו")
      .replace(/יי/g, "י")
      .trim()
  );

  const normHouse = memoText((house) => {
    const match = cleanText(house).match(/^(\d{1,4})\s*([א-ת])?$/);
    return match ? `${Number(match[1])}${match[2] || ""}` : "";
  });

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

  // קומה כפי שאתר הנדל"ן הממשלתי כותב אותה: "שמינית", "קרקע", או מספר
  const NADLAN_FLOORS = new Map([
    ["קרקע", 0], ["ראשונה", 1], ["ראשון", 1], ["שניה", 2], ["שנייה", 2], ["שני", 2], ["שלישית", 3], ["שלישי", 3],
    ["רביעית", 4], ["רביעי", 4], ["חמישית", 5], ["חמישי", 5], ["שישית", 6], ["שישי", 6], ["שביעית", 7], ["שביעי", 7],
    ["שמינית", 8], ["שמיני", 8], ["תשיעית", 9], ["תשיעי", 9], ["עשירית", 10], ["עשירי", 10],
    ["אחת עשרה", 11], ["שתים עשרה", 12], ["שתיים עשרה", 12], ["שלוש עשרה", 13], ["ארבע עשרה", 14], ["חמש עשרה", 15],
    ["מרתף", -1],
  ]);
  function nadlanFloor(text) {
    const value = cleanText(text);
    if (!value) return null;
    if (/^-?\d{1,3}$/.test(value)) return Number(value);
    return NADLAN_FLOORS.has(value) ? NADLAN_FLOORS.get(value) : null;
  }

  // שורה מטבלת העסקאות באתר הנדל"ן הממשלתי (nadlan.gov.il). העמודות: מספר סידורי, כתובת ("רחוב מספר"),
  // שטח, תאריך (dd/mm/yyyy), מחיר, גוש/חלקה, סוג נכס, חדרים, קומה. העיר והשכונה באות מכותרות העמוד (ctx).
  function fromNadlan(cells, ctx) {
    if (!Array.isArray(cells) || cells.length < 9 || !ctx || !ctx.city) return null;
    const address = String(cells[1] || "").replace(/\s+/g, " ").trim();
    const match = address.match(/^(.*?)\s+(\d{1,4}\s*[א-ת]?)$/);
    const date = String(cells[3] || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match || !date) return null;
    const type = String(cells[6] || "").trim();
    return build({
      city: ctx.city,
      street: match[1],
      house: match[2],
      neighborhood: ctx.neighborhood || null,
      date: `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}`,
      price: String(cells[4] || "").replace(/[^\d]/g, ""),
      sqm: String(cells[2] || "").replace(/[^\d.]/g, ""),
      rooms: String(cells[7] || "").replace(/[^\d.]/g, ""),
      floor: nadlanFloor(cells[8]),
      propertyType: type && type !== "לא ידוע" ? type : null,
    }, "nadlan");
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

  // ---------- שמירה לפי עיר ----------
  // area: chrome.storage.local (או מימוש עם get/set/remove שמחזירים Promise)
  function shardKey(city) {
    return SHARD_PREFIX + normCity(city);
  }

  function isDealsKey(key) {
    return key === STORAGE_KEY || String(key).startsWith(SHARD_PREFIX);
  }

  // העיר נמצאת בתחילת מפתח העסקה (עיר|רחוב|בית|תאריך|מחיר)
  function cityOfKey(key) {
    return String(key).split("|")[0];
  }

  function splitByCity(store) {
    const shards = {};
    for (const [key, deal] of Object.entries(store || {})) {
      const shard = SHARD_PREFIX + cityOfKey(key);
      (shards[shard] = shards[shard] || {})[key] = deal;
    }
    return shards;
  }

  function joinShards(values) {
    const store = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (isDealsKey(key) && value && typeof value === "object") Object.assign(store, value);
    }
    return store;
  }

  async function dealsKeys(area) {
    if (typeof area.getKeys === "function") return (await area.getKeys()).filter(isDealsKey);
    return Object.keys(await area.get(null)).filter(isDealsKey);
  }

  // העברה חד-פעמית מהמפתח הישן (וגם אחרי שחזור גיבוי ישן): מפצלים לפי עיר, ממזגים עם מה שכבר
  // נשמר בכל עיר, ורק אחרי שהכל נכתב מוחקים את המפתח הישן
  async function migrate(area) {
    const legacy = (await area.get(STORAGE_KEY))[STORAGE_KEY];
    if (!legacy || typeof legacy !== "object") return 0;
    const shards = splitByCity(legacy);
    const existing = await area.get(Object.keys(shards));
    const next = {};
    for (const [shard, deals] of Object.entries(shards)) {
      next[shard] = mergeAll(existing[shard], Object.entries(deals).map(([key, deal]) => ({ key, deal }))).store;
    }
    if (Object.keys(next).length) await area.set(next);
    await area.remove(STORAGE_KEY);
    return Object.keys(legacy).length;
  }

  async function loadAll(area) {
    const keys = await dealsKeys(area);
    return keys.length ? joinShards(await area.get(keys)) : {};
  }

  // עסקאות של עיר אחת (כולל המפתח הישן, אם עוד לא הועבר)
  async function loadCity(area, city) {
    if (!normCity(city)) return loadAll(area);
    const shard = shardKey(city);
    const values = await area.get([shard, STORAGE_KEY]);
    const legacy = values[STORAGE_KEY];
    if (!legacy) return values[shard] || {};
    const prefix = normCity(city) + "|";
    const store = {};
    for (const [key, deal] of Object.entries(legacy)) if (key.startsWith(prefix)) store[key] = deal;
    return Object.assign(store, values[shard] || {});
  }

  async function hasAny(area) {
    return (await dealsKeys(area)).length > 0;
  }

  // ממזג עסקאות חדשות וכותב רק את הערים שהשתנו. מחזיר גם את המצב לפני ואחרי של הערים שנגעו בהן
  async function saveItems(area, items, now = Date.now()) {
    await migrate(area);
    const groups = {};
    for (const item of items) {
      if (!item || !item.key) continue;
      const shard = SHARD_PREFIX + cityOfKey(item.key);
      (groups[shard] = groups[shard] || []).push(item);
    }
    const shards = Object.keys(groups);
    const stored = shards.length ? await area.get(shards) : {};
    const before = {};
    const after = {};
    const changed = {};
    let added = 0;
    let updated = 0;
    for (const shard of shards) {
      Object.assign(before, stored[shard] || {});
      const merged = mergeAll(stored[shard], groups[shard], now);
      Object.assign(after, merged.store);
      added += merged.added;
      updated += merged.updated;
      if (merged.added || merged.updated) changed[shard] = merged.store;
    }
    if (Object.keys(changed).length) await area.set(changed);
    return { added, updated, before, after };
  }

  // ---------- השוואת מודעה לעסקאות ----------
  // מיון מספרי מהיר (מערך טיפוסי ממיין מספרים בלי פונקציית השוואה)
  const sortedNumbers = (values) => Float64Array.from(values).sort();

  function medianOfSorted(sorted) {
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function median(values) {
    return values.length ? medianOfSorted(sortedNumbers(values)) : null;
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
      neighborhood: normHood(record && record.neighborhood),
    };
  }

  // השכונה של בניין/רחוב לפי עסקאות אחרות שיש להן שכונה (עסקאות מדלן מגיעות בלי שכונה):
  // בניין – השכונה הנפוצה בו; רחוב – רק כשלפחות 80% מ־3 עסקאות ומעלה באותה שכונה
  function hoodGuesser(deals) {
    const byBuilding = new Map();
    const byStreet = new Map();
    const vote = (map, key, hood) => {
      if (!map.has(key)) map.set(key, new Map());
      const counts = map.get(key);
      counts.set(hood, (counts.get(hood) || 0) + 1);
    };
    for (const deal of deals) {
      const hood = normHood(deal.neighborhood);
      if (!hood) continue;
      const streetKey = `${normCity(deal.city)}|${normStreet(deal.street)}`;
      vote(byStreet, streetKey, hood);
      const house = normHouse(deal.house);
      if (house) vote(byBuilding, `${streetKey}|${house}`, hood);
    }
    const top = (counts) => {
      let best = "";
      let bestCount = 0;
      let total = 0;
      for (const [hood, count] of counts) {
        total += count;
        if (count > bestCount) {
          best = hood;
          bestCount = count;
        }
      }
      return { hood: best, share: total ? bestCount / total : 0, total };
    };
    return (city, street, house) => {
      const streetKey = `${city}|${street}`;
      const building = house && byBuilding.get(`${streetKey}|${house}`);
      if (building) return top(building).hood;
      const onStreet = byStreet.get(streetKey);
      if (!onStreet) return "";
      const result = top(onStreet);
      return result.total >= 3 && result.share >= 0.8 ? result.hood : "";
    };
  }

  // השכונה של המודעה כפי שהיא באינדקס: השם שלה אם יש עסקאות בשכונה בשם הזה,
  // אחרת לפי הבניין/הרחוב (מדלן ויד2 לא תמיד קוראות לשכונה באותו שם)
  function listingHood(place, index) {
    if (place.neighborhood && index.byHood.has(`${place.city}|${place.neighborhood}`)) return place.neighborhood;
    const guessed = index.guessHood && place.street ? index.guessHood(place.city, place.street, place.house) : "";
    return guessed || place.neighborhood;
  }

  function buildIndex(store, { years = 4, now = Date.now() } = {}) {
    const minDate = new Date(now - years * 365 * DAY_MS).toISOString().slice(0, 10);
    const byStreet = new Map();
    const byHood = new Map();
    const byCity = new Map();
    const deals = Object.values(store || {}).filter(
      (deal) => deal && deal.price > 0 && deal.sqm > 0 && String(deal.date) >= minDate
    );
    const guessHood = hoodGuesser(deals);
    for (const deal of deals) {
      const city = normCity(deal.city);
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city).push(deal);
      const streetKey = `${city}|${normStreet(deal.street)}`;
      if (!byStreet.has(streetKey)) byStreet.set(streetKey, []);
      byStreet.get(streetKey).push(deal);
      const hood = normHood(deal.neighborhood) || guessHood(city, normStreet(deal.street), normHouse(deal.house));
      if (hood) {
        const hoodKey = `${city}|${hood}`;
        if (!byHood.has(hoodKey)) byHood.set(hoodKey, []);
        byHood.get(hoodKey).push(deal);
      }
    }
    return { byStreet, byHood, byCity, years, guessHood };
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
    const hoodName = listingHood(place, index);
    const hood = hoodName ? index.byHood.get(`${place.city}|${hoodName}`) || [] : [];
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
      neighborhood: (() => {
        const hoodName = listingHood(place, index);
        return hoodName ? index.byHood.get(`${place.city}|${hoodName}`) || [] : [];
      })(),
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

  // טקסט החיפוש: מספר בית או טווח ("בלוי 28-30", "בלוי 28–30", "בלוי 28 עד 30") מתאים למספר הבית
  // בדיוק (28 מתאים גם ל-28א, לא ל-280); שאר המילים מחפשות בעיר, ברחוב ובשכונה.
  function parseDealsQuery(query) {
    let text = String(query || "");
    let houseRange = null;
    const rangeMatch = text.match(/(\d{1,4})\s*(?:-|–|־|עד)\s*(\d{1,4})/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      houseRange = { min: Math.min(a, b), max: Math.max(a, b) };
      text = text.replace(rangeMatch[0], " ");
    }
    const words = cleanText(text).split(" ").filter(Boolean);
    const numbers = words.filter((word) => /^\d{1,4}[א-ת]?$/.test(word));
    return { words: words.filter((word) => !numbers.includes(word)), numbers, houseRange };
  }

  const houseNumber = (house) => {
    const match = String(house || "").match(/^(\d{1,4})/);
    return match ? Number(match[1]) : null;
  };

  // filters: { query, city, neighborhood, source ("yad2" | "madlan" | "both"), rooms/sqm/floor/price/ppsm/year/house: { min, max } }
  // (קומה: קרקע = 0; עסקה בלי קומה ידועה לא עוברת סינון קומה; שכונה: רק עסקאות שהשכונה שלהן ידועה)
  function filterDeals(store, filters = {}) {
    const { words, numbers, houseRange } = parseDealsQuery(filters.query);
    const city = filters.city ? normCity(filters.city) : "";
    const hood = filters.neighborhood ? normHood(filters.neighborhood) : "";
    // כמה שכונות: ["עיר|שכונה", …] – עסקה עוברת אם היא באחת מהן (אותו שם שכונה בעיר אחרת לא נחשב)
    const hoodIds = Array.isArray(filters.neighborhoods) && filters.neighborhoods.length
      ? new Set(filters.neighborhoods.map(hoodId).filter(Boolean))
      : null;
    const range = (name) => filters[name] || {};
    const out = [];
    for (const [key, deal] of Object.entries(store || {})) {
      if (!deal || typeof deal !== "object") continue;
      if (city && normCity(deal.city) !== city) continue;
      if (hood && normHood(deal.neighborhood) !== hood) continue;
      if (hoodIds && !hoodIds.has(dealHoodId(deal))) continue;
      const sources = deal.sources || [];
      if (filters.source === "both" ? sources.length < 2 : filters.source && !sources.includes(filters.source)) continue;
      if (words.length) {
        const haystack = cleanText(`${deal.city} ${deal.street} ${deal.neighborhood || ""}`);
        if (!words.every((word) => haystack.includes(word))) continue;
      }
      const house = houseNumber(deal.house);
      // מספר בודד: 28 = 28 / 28א; עם אות ("28א") – בדיוק אותו בית
      if (numbers.length && !numbers.some((number) =>
        /[א-ת]$/.test(number) ? normHouse(deal.house) === normHouse(number) : house === Number(number)
      )) continue;
      if (houseRange && !inRange(house, houseRange.min, houseRange.max)) continue;
      if (!inRange(house, range("house").min, range("house").max)) continue;
      if (!inRange(deal.rooms, range("rooms").min, range("rooms").max)) continue;
      if (!inRange(deal.sqm, range("sqm").min, range("sqm").max)) continue;
      if (!inRange(deal.floor, range("floor").min, range("floor").max)) continue;
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

  const hebrewCollator = new Intl.Collator("he");

  // ערכים חסרים תמיד בסוף, בלי קשר לכיוון המיון. הערך של כל עסקה מחושב פעם אחת (לא בכל השוואה),
  // ותאריכים (YYYY-MM-DD) מושווים כמחרוזות רגילות – מהיר בהרבה מהשוואה לפי שפה
  // מיון לפי כמה עמודות (כמו ORDER BY a, b, c): key יכול להיות מערך [{ key, direction }, ...] –
  // השנייה מכריעה רק כשהראשונה שווה, וכן הלאה. ערכים חסרים בסוף בכל רמה.
  function sortDeals(list, key = "date", direction = -1) {
    const sorts = (Array.isArray(key) ? key : [{ key, direction }])
      .filter((sort) => sort && sort.key)
      .map((sort) => ({
        value: SORT_VALUES[sort.key] || SORT_VALUES.date,
        plain: sort.key === "date" || !SORT_VALUES[sort.key],
        direction: sort.direction < 0 ? -1 : 1,
      }));
    if (!sorts.length) sorts.push({ value: SORT_VALUES.date, plain: true, direction: -1 });
    const isMissing = (v) => v === null || v === undefined || v === "" || Number.isNaN(v);
    const rows = list.map((entry) => ({ entry, values: sorts.map((sort) => sort.value(entry[1])) }));
    rows.sort((a, b) => {
      for (let i = 0; i < sorts.length; i++) {
        const left = a.values[i];
        const right = b.values[i];
        const leftMissing = isMissing(left);
        const rightMissing = isMissing(right);
        if (leftMissing || rightMissing) {
          if (leftMissing === rightMissing) continue;
          return leftMissing ? 1 : -1;
        }
        const comparison = typeof left === "string"
          ? (sorts[i].plain ? (left < right ? -1 : left > right ? 1 : 0) : hebrewCollator.compare(left, right))
          : left - right;
        if (comparison) return comparison * sorts[i].direction;
      }
      return 0;
    });
    return rows.map((row) => row.entry);
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

  // ---------- סטטיסטיקות לתוצאות חיפוש עסקאות ----------
  // אחוזון בשיטת אינטרפולציה לינארית (p בין 0 ל-1)
  function quantile(values, p) {
    return values.length ? quantileOfSorted(sortedNumbers(values), p) : null;
  }

  function quantileOfSorted(sorted, p) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);

  // מדדים לקבוצת עסקאות: כמות, חציונים, טווח בין־רבעוני של מחיר למ״ר
  function groupStats(deals) {
    const ppsm = [];
    const prices = [];
    const sqm = [];
    for (const deal of deals) {
      const value = dealPpsm(deal);
      if (Number.isFinite(value)) ppsm.push(value);
      if (deal.price > 0) prices.push(deal.price);
      if (deal.sqm > 0) sqm.push(deal.sqm);
    }
    // מיון אחד של המחיר למ״ר משמש לחציון, לאחוזונים ולמינימום/מקסימום
    const sortedPpsm = sortedNumbers(ppsm);
    return {
      count: deals.length,
      medianPrice: round(median(prices)),
      medianPpsm: round(medianOfSorted(sortedPpsm)),
      p25Ppsm: round(quantileOfSorted(sortedPpsm, 0.25)),
      p75Ppsm: round(quantileOfSorted(sortedPpsm, 0.75)),
      minPpsm: sortedPpsm.length ? sortedPpsm[0] : null,
      maxPpsm: sortedPpsm.length ? sortedPpsm[sortedPpsm.length - 1] : null,
      medianSqm: round(median(sqm)),
      ppsmCount: ppsm.length,
    };
  }

  function bucketStats(deals, buckets, valueOf) {
    return buckets
      .map((bucket) => {
        const inBucket = deals.filter((deal) => {
          const value = valueOf(deal);
          return Number.isFinite(value) && value >= bucket.min && value <= bucket.max;
        });
        return { label: bucket.label, ...groupStats(inBucket) };
      })
      .filter((row) => row.count > 0);
  }

  const ROOM_BUCKETS = [
    { label: "עד 2", min: 0, max: 2 },
    { label: "2.5–3", min: 2.5, max: 3 },
    { label: "3.5–4", min: 3.5, max: 4 },
    { label: "4.5–5", min: 4.5, max: 5 },
    { label: "5.5+", min: 5.5, max: Infinity },
  ];
  const FLOOR_BUCKETS = [
    { label: "קרקע", min: -Infinity, max: 0 },
    { label: "1–3", min: 1, max: 3 },
    { label: "4–8", min: 4, max: 8 },
    { label: "9–15", min: 9, max: 15 },
    { label: "16+", min: 16, max: Infinity },
  ];
  const BUILD_BUCKETS = [
    { label: "עד 1979", min: 0, max: 1979 },
    { label: "1980–1999", min: 1980, max: 1999 },
    { label: "2000–2014", min: 2000, max: 2014 },
    { label: "2015 ואילך", min: 2015, max: Infinity },
  ];
  const SIZE_BUCKETS = [
    { label: "עד 60 מ״ר", min: 0, max: 60 },
    { label: "61–80 מ״ר", min: 60.01, max: 80 },
    { label: "81–100 מ״ר", min: 80.01, max: 100 },
    { label: "101–130 מ״ר", min: 100.01, max: 130 },
    { label: "131+ מ״ר", min: 130.01, max: Infinity },
  ];
  // שנה שיש בה פחות עסקאות מזה לא נכנסת לחישוב שינוי שנתי (חציון של 1–2 עסקאות לא מייצג)
  const TREND_MIN_DEALS = 3;

  // שינוי בחציון המחיר למ״ר בין שתי השנים האחרונות שיש בהן מספיק עסקאות (לקבוצה: עיר, שכונה, רחוב)
  function yearOverYear(deals) {
    const byYear = new Map();
    for (const deal of deals) {
      const ppsm = dealPpsm(deal);
      const year = Number(String(deal.date).slice(0, 4));
      if (!Number.isFinite(ppsm) || !(year > 1900)) continue;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(ppsm);
    }
    const years = [...byYear.keys()].filter((year) => byYear.get(year).length >= TREND_MIN_DEALS).sort((a, b) => a - b);
    if (years.length < 2) return null;
    const last = years[years.length - 1];
    const previous = years[years.length - 2];
    const lastMedian = median(byYear.get(last));
    const previousMedian = median(byYear.get(previous));
    return { fromYear: previous, toYear: last, pct: Math.round((lastMedian / previousMedian - 1) * 1000) / 10 };
  }

  // קיבוץ לפי מפתח (עיר / שכונה / רחוב / סוג נכס), עם מדדים ושינוי שנתי, מהגדול לקטן
  function groupBy(deals, keyOf, fieldsOf) {
    const groups = new Map();
    for (const deal of deals) {
      const key = keyOf(deal);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { ...fieldsOf(deal), deals: [] });
      groups.get(key).deals.push(deal);
    }
    return [...groups.values()]
      .map(({ deals: groupDeals, ...fields }) => {
        const latest = groupDeals.reduce((best, deal) => (String(deal.date) > String(best.date) ? deal : best));
        return { ...fields, ...groupStats(groupDeals), change: yearOverYear(groupDeals), lastDate: latest.date || null };
      })
      .sort((a, b) => b.count - a.count);
  }

  // רבעונים אחרונים: כמות וחציון למ״ר בכל רבעון – מגמה טרייה יותר משנתית
  function byQuarter(deals, count = 12) {
    const quarters = new Map();
    for (const deal of deals) {
      const match = String(deal.date).match(/^(\d{4})-(\d{2})/);
      if (!match) continue;
      const key = `${match[1]}-Q${Math.ceil(Number(match[2]) / 3)}`;
      if (!quarters.has(key)) quarters.set(key, []);
      quarters.get(key).push(deal);
    }
    return [...quarters.keys()].sort().slice(-count).map((key) => ({ label: key.replace("-Q", " רבעון "), key, ...groupStats(quarters.get(key)) }));
  }

  // list: [[key, deal], ...] כפי ש-filterDeals מחזירה
  function analyzeDeals(list) {
    const deals = (Array.isArray(list) ? list : []).map(([, deal]) => deal).filter((deal) => deal && typeof deal === "object");
    const dated = deals.filter((deal) => /^\d{4}-\d{2}-\d{2}$/.test(String(deal.date)));
    const byYearMap = new Map();
    for (const deal of dated) {
      const year = Number(deal.date.slice(0, 4));
      if (!byYearMap.has(year)) byYearMap.set(year, []);
      byYearMap.get(year).push(deal);
    }
    const byYear = [...byYearMap.keys()].sort((a, b) => a - b).map((year) => ({ year, ...groupStats(byYearMap.get(year)) }));

    // שינוי במחיר למ״ר: בין שתי השנים האחרונות שיש בהן מספיק עסקאות, וממוצע שנתי לאורך כל התקופה
    const trendYears = byYear.filter((row) => row.ppsmCount >= TREND_MIN_DEALS && Number.isFinite(row.medianPpsm));
    let lastChange = null;
    let annualChange = null;
    if (trendYears.length >= 2) {
      const last = trendYears[trendYears.length - 1];
      const previous = trendYears[trendYears.length - 2];
      lastChange = {
        fromYear: previous.year,
        toYear: last.year,
        pct: Math.round(((last.medianPpsm / previous.medianPpsm - 1) * 1000)) / 10,
      };
      const first = trendYears[0];
      const span = last.year - first.year;
      if (span >= 2) {
        annualChange = {
          fromYear: first.year,
          toYear: last.year,
          pct: Math.round((Math.pow(last.medianPpsm / first.medianPpsm, 1 / span) - 1) * 1000) / 10,
        };
      }
    }

    // לפי בניין (רחוב + מספר בית): הבניינים עם הכי הרבה עסקאות
    const buildings = new Map();
    for (const deal of deals) {
      if (!deal.street) continue;
      const key = placeKey(deal.city, deal.street, deal.house);
      if (!buildings.has(key)) buildings.set(key, { city: deal.city, street: deal.street, house: deal.house, deals: [] });
      buildings.get(key).deals.push(deal);
    }
    const byBuilding = [...buildings.values()]
      .map((building) => {
        const latest = building.deals.reduce((best, deal) => (String(deal.date) > String(best.date) ? deal : best));
        return {
          city: building.city,
          street: building.street,
          house: building.house,
          ...groupStats(building.deals),
          lastDate: latest.date || null,
          lastPrice: latest.price || null,
        };
      })
      .sort((a, b) => b.count - a.count || (String(b.lastDate) > String(a.lastDate) ? 1 : String(b.lastDate) < String(a.lastDate) ? -1 : 0));

    const latest = dated.reduce((best, deal) => (!best || deal.date > best.date ? deal : best), null);
    const points = dated
      .map((deal) => ({ date: deal.date, ppsm: dealPpsm(deal), price: deal.price, sqm: deal.sqm, rooms: deal.rooms, floor: deal.floor, street: deal.street, house: deal.house, city: deal.city }))
      .filter((point) => Number.isFinite(point.ppsm));

    return {
      overall: groupStats(deals),
      fromDate: dated.length ? dated.reduce((min, deal) => (deal.date < min ? deal.date : min), dated[0].date) : null,
      toDate: latest ? latest.date : null,
      latest: latest || null,
      byYear,
      lastChange,
      annualChange,
      byRooms: bucketStats(deals, ROOM_BUCKETS, (deal) => deal.rooms),
      byFloor: bucketStats(deals, FLOOR_BUCKETS, (deal) => deal.floor),
      byBuildYear: bucketStats(deals, BUILD_BUCKETS, (deal) => deal.buildYear),
      bySize: bucketStats(deals, SIZE_BUCKETS, (deal) => deal.sqm),
      byType: groupBy(deals, (deal) => deal.propertyType || "", (deal) => ({ label: deal.propertyType })),
      byCity: groupBy(deals, (deal) => normCity(deal.city), (deal) => ({ city: deal.city })),
      byNeighborhood: groupBy(
        deals,
        (deal) => (deal.neighborhood ? `${normCity(deal.city)}|${normHood(deal.neighborhood)}` : ""),
        (deal) => ({ city: deal.city, neighborhood: deal.neighborhood })
      ),
      byStreet: groupBy(
        deals,
        (deal) => (deal.street ? `${normCity(deal.city)}|${normStreet(deal.street)}` : ""),
        (deal) => ({ city: deal.city, street: deal.street })
      ),
      byQuarter: byQuarter(dated),
      withNeighborhood: deals.filter((deal) => deal.neighborhood).length,
      byBuilding,
      streetCount: new Set([...buildings.values()].map((building) => `${normCity(building.city)}|${normStreet(building.street)}`)).size,
      points,
    };
  }

  // "עיר|שכונה" (כפי שנבחרה ברשימה) -> מפתח מנורמל להשוואה. כתיב מלא/חסר של העיר לא משנה
  // ("פתח תקוה" = "פתח תקווה")
  const hoodCity = (city) => normCity(city).replace(/וו/g, "ו").replace(/יי/g, "י");
  function dealHoodId(deal) {
    const hood = deal && deal.neighborhood ? normHood(deal.neighborhood) : "";
    return hood ? `${hoodCity(deal.city)}|${hood}` : "";
  }
  function hoodId(value) {
    const text = String(value || "");
    const cut = text.indexOf("|");
    if (cut < 0) return "";
    return dealHoodId({ city: text.slice(0, cut), neighborhood: text.slice(cut + 1) });
  }

  // השכונה של עסקה בלי שכונה – רק לפי עסקאות באותה כתובת בדיוק (אותה עיר, אותו רחוב ואותו מספר בית),
  // וכשלשכונה אחת יש רוב מוחלט (יותר ממחצית) מהעסקאות בכתובת שהשכונה שלהן ידועה. בלי מספר בית – לא מנחשים.
  // מחזיר מאגר חדש (לא משנה את השמור): עסקה שהושלמה מקבלת neighborhood + neighborhoodInferred: true
  function withInferredHoods(store) {
    const placeOf = (deal) => {
      const street = normStreet(deal.street);
      const house = normHouse(deal.house);
      return street && house ? `${hoodCity(deal.city)}|${street}|${house}` : "";
    };
    const votes = new Map();
    for (const deal of Object.values(store || {})) {
      if (!deal || !deal.neighborhood) continue;
      const place = placeOf(deal);
      const hood = normHood(deal.neighborhood);
      if (!place || !hood) continue;
      if (!votes.has(place)) votes.set(place, new Map());
      const counts = votes.get(place);
      const entry = counts.get(hood) || { count: 0, name: String(deal.neighborhood).trim() };
      entry.count++;
      counts.set(hood, entry);
    }
    const winners = new Map();
    for (const [place, counts] of votes) {
      let total = 0;
      let best = null;
      for (const entry of counts.values()) {
        total += entry.count;
        if (!best || entry.count > best.count) best = entry;
      }
      if (best && best.count * 2 > total) winners.set(place, best.name);
    }
    if (!winners.size) return store || {};
    const out = {};
    for (const [key, deal] of Object.entries(store || {})) {
      const name = deal && !deal.neighborhood ? winners.get(placeOf(deal)) : null;
      out[key] = name ? { ...deal, neighborhood: name, neighborhoodInferred: true } : deal;
    }
    return out;
  }

  // השוואת שכונות: לכל שכונה שנבחרה – חציון המחיר למ״ר בכל שנה (רק שנים עם minCount עסקאות לפחות,
  // כדי שעסקה בודדת לא תיראה כמו מגמה). hoods: ["עיר|שכונה", …] בסדר הבחירה
  function hoodSeries(deals, hoods, { minCount = 2 } = {}) {
    const series = [];
    const byId = new Map();
    for (const value of Array.isArray(hoods) ? hoods : []) {
      const id = hoodId(value);
      if (!id || byId.has(id)) continue;
      const cut = String(value).indexOf("|");
      const entry = { id, city: String(value).slice(0, cut), neighborhood: String(value).slice(cut + 1), years: new Map(), count: 0 };
      byId.set(id, entry);
      series.push(entry);
    }
    // מקבל עסקאות או זוגות [key, deal] (כפי ש-filterDeals מחזירה)
    for (const item of Array.isArray(deals) ? deals : []) {
      const deal = Array.isArray(item) ? item[1] : item;
      if (!deal || !deal.neighborhood) continue;
      const entry = byId.get(dealHoodId(deal));
      const year = Number(String(deal.date || "").slice(0, 4));
      const ppsm = dealPpsm(deal);
      if (!entry || !(year > 1990) || !Number.isFinite(ppsm)) continue;
      if (!entry.years.has(year)) entry.years.set(year, []);
      entry.years.get(year).push(ppsm);
      entry.count++;
    }
    return series.map((entry) => ({
      id: entry.id,
      city: entry.city,
      neighborhood: entry.neighborhood,
      count: entry.count,
      years: [...entry.years]
        .filter(([, values]) => values.length >= minCount)
        .map(([year, values]) => ({ year, medianPpsm: Math.round(median(values)), count: values.length }))
        .sort((a, b) => a.year - b.year),
    }));
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
        add(hoods, `${normCity(deal.city)}|${normHood(deal.neighborhood)}`, { city: deal.city, neighborhood: deal.neighborhood }, deal, year);
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
    SHARD_PREFIX,
    FETCH_LOG_KEY,
    shardKey,
    isDealsKey,
    splitByCity,
    joinShards,
    migrate,
    loadAll,
    loadCity,
    hasAny,
    saveItems,
    LEVEL_LABELS,
    LEVEL_NAMES,
    LEVEL_MINIMUMS,
    compareListingAll,
    normStreet,
    normCity,
    normHood,
    normHouse,
    dealKey,
    fromYad2,
    fromMadlan,
    fromNadlan,
    nadlanFloor,
    mergeDeal,
    mergeAll,
    listingPlace,
    buildIndex,
    compareListing,
    dealPpsm,
    filterDeals,
    sortDeals,
    summarizeDeals,
    analyzeDeals,
    quantile,
    dealsByArea,
    hoodId,
    dealHoodId,
    hoodSeries,
    withInferredHoods,
    placeKey,
  };
})();

if (typeof module !== "undefined") module.exports = LRDeals;
