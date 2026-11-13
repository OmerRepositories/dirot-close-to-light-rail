// סריקת רחובות מועדפים ביד2 (רשות – כבויה כברירת מחדל): לכל רחוב מועדף מוצאים את המזהים של יד2
// (אזור / עיר / רחוב) דרך החיפוש של האתר, ופותחים את עמוד התוצאות של הרחוב – עמוד אחרי עמוד.
// הכרטיסים בעמוד נשמרים כרגיל ע"י סקריפט התוכן (עם כל המסננים: מחיר, שטח, ערים).
// כאן רק הלוגיקה בלי דפדפן, כדי שאפשר יהיה לבדוק אותה.
var LRStreetScan = (() => {
  // מספר האזור ביד2 -> השם שלו בכתובת (בלי השם הזה יד2 מתעלמת מהעיר ומהרחוב)
  const REGION_SLUGS = {
    1: "center-and-sharon",
    2: "south",
    3: "tel-aviv-area",
    4: "east",
    5: "coastal-north",
    6: "jerusalem-area",
    7: "north-and-valleys",
    8: "jerusalem",
  };
  // sites: באילו אתרים לסרוק. מדלן כבויה כברירת מחדל (נוספה ב-1.83.0 – רשות)
  const DEFAULTS = { enabled: false, everyHours: 24, maxPages: 5, delaySeconds: 20, sites: { yad2: true, madlan: false } };
  const SITES = ["yad2", "madlan"];
  const IDS_KEYS = { yad2: "lightrailYad2StreetIds", madlan: "lightrailMadlanStreetIds" };
  const LIMITS = {
    everyHours: [1, 168],
    maxPages: [1, 20],
    delaySeconds: [10, 300],
  };

  function clampInt(value, [min, max], fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const sites = source.sites && typeof source.sites === "object" ? source.sites : {};
    return {
      enabled: source.enabled === true,
      everyHours: clampInt(source.everyHours, LIMITS.everyHours, DEFAULTS.everyHours),
      maxPages: clampInt(source.maxPages, LIMITS.maxPages, DEFAULTS.maxPages),
      delaySeconds: clampInt(source.delaySeconds, LIMITS.delaySeconds, DEFAULTS.delaySeconds),
      sites: Object.fromEntries(SITES.map((site) => [site, typeof sites[site] === "boolean" ? sites[site] : DEFAULTS.sites[site]])),
    };
  }

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  // שורות הרחובות המועדפים ("ההגנה, פתח תקווה") -> רחובות לסריקה. רחוב בלי עיר לא נסרק:
  // אותו שם רחוב קיים בהרבה ערים, ואין דרך לדעת לאיזו התכוונת
  function streetsToScan(lines) {
    const seen = new Set();
    const streets = [];
    const skipped = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
      const [streetPart, ...cityParts] = String(raw || "").split(",");
      const street = clean(streetPart).replace(/^(?:רחוב|רח['׳]?)\s+/, "");
      const city = clean(cityParts.join(","));
      if (!street) continue;
      if (!city) {
        skipped.push(clean(raw));
        continue;
      }
      // "פתח תקווה, פתח תקווה" – שם העיר ולא רחוב (נוסף ממודעה שנשמרה בלי רחוב)
      const loose = (value) => value.replace(/["'׳״]/g, "").replace(/וו/g, "ו").replace(/יי/g, "י");
      if (loose(street) === loose(city)) continue;
      const key = cacheKey(street, city);
      if (seen.has(key)) continue;
      seen.add(key);
      streets.push({ label: `${street}, ${city}`, street, city, key, query: `${street} ${city}` });
    }
    return { streets, skipped };
  }

  function cacheKey(street, city) {
    const words = (value) => (typeof LRStreetFilter !== "undefined" ? LRStreetFilter.normalize(value) : clean(value));
    return `${words(street)}|${words(city).replace(/וו/g, "ו").replace(/יי/g, "י")}`;
  }

  // מתוך תשובת החיפוש של יד2 (address-autocomplete v2) – הרחוב שמתאים לשם ולעיר
  function pickStreet(response, street, city) {
    const list = response && Array.isArray(response.streets) ? response.streets : [];
    const filter = typeof LRStreetFilter !== "undefined" ? LRStreetFilter : null;
    const norm = (value) => (filter ? filter.normalize(value) : clean(value));
    const wanted = norm(street);
    let best = null;
    let bestScore = 0;
    for (const item of list) {
      if (!item || !item.streetId || !item.cityId || !REGION_SLUGS[item.regionId]) continue;
      const title = clean(item.fullTitleText);
      const comma = title.lastIndexOf(",");
      if (comma < 0) continue;
      const itemStreet = norm(title.slice(0, comma));
      const itemCity = title.slice(comma + 1).trim();
      if (filter && !filter.cityAllowed([city], itemCity)) continue;
      const score = itemStreet === wanted ? 3 : (` ${itemStreet} `).includes(` ${wanted} `) ? 2 : 0;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    if (!best) return null;
    return {
      title: clean(best.fullTitleText),
      region: String(best.regionId),
      area: best.areaId ? String(best.areaId) : "",
      city: String(best.cityId),
      street: String(best.streetId),
    };
  }

  // עמוד התוצאות של רחוב (למכירה). עמוד 1 בלי פרמטר page
  function streetUrl(ids, page = 1) {
    const slug = ids && REGION_SLUGS[ids.region];
    if (!slug || !ids.city || !ids.street) return null;
    const url = new URL(`https://www.yad2.co.il/realestate/forsale/${slug}`);
    if (ids.area) url.searchParams.set("area", ids.area);
    url.searchParams.set("city", ids.city);
    url.searchParams.set("street", ids.street);
    if (page > 1) url.searchParams.set("page", String(page));
    return url.href;
  }

  // מדלן: ההצעות מתיבת החיפוש של האתר ([{ text: "גובר רבקה, פתח תקווה", type: "רחוב" }]) – האינדקס של
  // הרחוב המתאים, או -1. מדלן כותבת לפעמים את השם בסדר הפוך ("גובר רבקה" ל"רבקה גובר"), לכן משווים מילים
  // בלי חשיבות לסדר; העיר חייבת להתאים
  function pickMadlanSuggestion(suggestions, street, city) {
    const filter = typeof LRStreetFilter !== "undefined" ? LRStreetFilter : null;
    const words = (value) => (filter ? filter.normalize(value) : clean(value)).split(" ").filter(Boolean);
    const wanted = words(street);
    let best = -1;
    let bestScore = 0;
    (Array.isArray(suggestions) ? suggestions : []).forEach((item, index) => {
      if (!item || !/רחוב/.test(String(item.type || ""))) return;
      const text = clean(item.text);
      const comma = text.lastIndexOf(",");
      if (comma < 0) return;
      const itemCity = text.slice(comma + 1).trim();
      if (filter && !filter.cityAllowed([city], itemCity)) return;
      const have = words(text.slice(0, comma));
      if (!wanted.length || !wanted.every((word) => have.includes(word))) return;
      const score = have.length === wanted.length ? 2 : 1; // אותן מילים בדיוק עדיף על שם ארוך יותר
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    return best;
  }

  // עמוד התוצאות של רחוב במדלן לפי המזהה שלו ("גובר-רבקה-פתח-תקווה-ישראל")
  function madlanStreetUrl(docId, page = 1) {
    const id = String(docId || "").trim();
    if (!id || id.includes("/") || !/-ישראל$/.test(id)) return null;
    return `https://www.madlan.co.il/for-sale/${encodeURIComponent(id)}${page > 1 ? `?page=${page}` : ""}`;
  }

  function streetPageUrl(site, ids, page = 1) {
    return site === "madlan" ? madlanStreetUrl(ids && ids.docId, page) : streetUrl(ids, page);
  }

  // כמה עמודים לסרוק ברחוב: לפי מה שיד2 דיווחה, עד המקסימום שהמשתמש בחר
  function pagesFor(totalPages, maxPages) {
    const total = Number.isFinite(totalPages) && totalPages > 0 ? Math.floor(totalPages) : 1;
    return Math.max(1, Math.min(total, maxPages));
  }

  // מזהי רחובות שנשמרו לפני יותר מחודש נבדקים מחדש (יד2 לא משנה אותם, אבל לא סומכים לנצח)
  const IDS_TTL_MS = 30 * 24 * 3600 * 1000;
  function cachedIds(cache, key, now = Date.now()) {
    const entry = cache && cache[key];
    if (!entry || !Number.isFinite(entry.at) || now - entry.at > IDS_TTL_MS) return undefined;
    return entry.ids || null; // null = יד2 לא מכירה את הרחוב (נשמר כדי לא לחפש שוב בכל ריצה)
  }

  function summary({ streets = 0, pages = 0, cards = 0, added = 0, notFound = [], skipped = [] } = {}) {
    const parts = [
      `נסרקו ${streets.toLocaleString("he-IL")} רחובות (${pages.toLocaleString("he-IL")} עמודים, ${cards.toLocaleString("he-IL")} כרטיסים)`,
      `${added.toLocaleString("he-IL")} מודעות חדשות נשמרו`,
    ];
    if (notFound.length) parts.push(`לא נמצאו ביד2: ${notFound.join("; ")}`);
    if (skipped.length) parts.push(`בלי עיר (לא נסרקו): ${skipped.join("; ")}`);
    return parts.join(" · ");
  }

  return {
    REGION_SLUGS, DEFAULTS, LIMITS, SITES, IDS_KEYS, normalizeSettings, streetsToScan, cacheKey, pickStreet, streetUrl,
    pickMadlanSuggestion, madlanStreetUrl, streetPageUrl, pagesFor, cachedIds, summary,
  };
})();

if (typeof module !== "undefined") module.exports = LRStreetScan;
