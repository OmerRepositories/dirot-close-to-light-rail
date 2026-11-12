// פענוח מחדש של מודעות פייסבוק שמורות מהטקסט שנשמר איתן (postText) – כשהמנתח משתפר, הרשומות
// הישנות מתעדכנות בלי לחזור לפייסבוק. נטען ברקע (importScripts) אחרי parse.js ו-facebook-classifier.js.
const LRFacebookReparse = (() => {
  // להעלות בכל שינוי במנתח שאמור לתקן מודעות שכבר נשמרו
  const PARSER_VERSION = 2;
  const VERSION_KEY = "lrFacebookParserVersion";
  const FIELDS = ["price", "sqm", "pricePerSqm", "rooms", "floor", "buildingTopFloor", "address", "city", "neighborhood"];

  const num = (value) => (Number.isFinite(value) ? value : undefined);
  const same = (a, b) => (a ?? undefined) === (b ?? undefined);

  // מחזיר { record, addressChanged, notListing } כשמשהו השתנה, אחרת null
  function reparseRecord(record, LR, now = Date.now()) {
    if (!record || record.site !== "facebook" || record.recordType === "project") return null;
    const text = typeof record.postText === "string" ? record.postText : "";
    if (!text.trim()) return null;
    const classification = typeof LR.classifyFacebookPost === "function" ? LR.classifyFacebookPost(text) : null;
    const parsed = (classification && classification.parsed) || LR.extractPriceSqmFree(text);
    // ההקשר של הקבוצה לא נשמר – העיר השמורה (מהפוסט או מהקבוצה) משמשת כברירת מחדל
    const address = LR.parseFreeAddress(text, record.city || "");
    const roomsFloor = LR.extractRoomsFloorFree(text);
    const next = {
      price: !parsed.rent ? num(parsed.price) : undefined,
      sqm: num(parsed.sqm),
      pricePerSqm: num(parsed.ppsm),
      rooms: roomsFloor.rooms ?? undefined,
      floor: roomsFloor.floor ?? undefined,
      buildingTopFloor: roomsFloor.topFloor ?? undefined,
      address: [address.street, address.city].filter(Boolean).join(", "),
      city: address.city || record.city || "",
      neighborhood: address.hood || "",
    };
    // לא מוחקים ערך שהיה כשהמנתח החדש לא מצא כלום – רק מתקנים
    for (const field of FIELDS) {
      if ((next[field] === undefined || next[field] === "") && record[field] !== undefined && record[field] !== "") next[field] = record[field];
    }
    if (next.price !== undefined && next.sqm && next.pricePerSqm === undefined) next.pricePerSqm = Math.round(next.price / next.sqm);
    const notListing = Boolean(classification && classification.type !== "listing");
    const changed = FIELDS.filter((field) => !same(record[field], next[field]));
    if (!changed.length && Boolean(record.facebookNotListing) === notListing) return null;

    const out = { ...record };
    for (const field of FIELDS) {
      if (next[field] === undefined) delete out[field];
      else out[field] = next[field];
    }
    if (notListing) out.facebookNotListing = true;
    else delete out.facebookNotListing;
    // המחיר הישן היה טעות פענוח, לא שינוי מחיר אמיתי – מתקנים אותו גם בהיסטוריה
    if (!same(record.price, out.price) && Array.isArray(record.priceHistory)) {
      const history = [];
      for (const point of record.priceHistory) {
        const price = point && point.price === record.price ? out.price : point && point.price;
        if (!Number.isFinite(price)) continue;
        if (history.length && history[history.length - 1].price === price) continue;
        history.push({ ...point, price });
      }
      out.priceHistory = history;
    }
    const addressChanged = !same(record.address, out.address);
    if (addressChanged) {
      // המרחק חושב לכתובת הישנה
      delete out.railMeters;
      delete out.railStation;
      delete out.railApprox;
    }
    out.updatedAt = now;
    return { record: out, changed, addressChanged, notListing, queries: addressChanged ? address.queries : [], street: address.street };
  }

  return { PARSER_VERSION, VERSION_KEY, reparseRecord };
})();

if (typeof module !== "undefined") module.exports = LRFacebookReparse;
