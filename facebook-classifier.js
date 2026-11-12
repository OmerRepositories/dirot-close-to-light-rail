// Facebook-specific post classification; depends on parse.js for price and area extraction.
(() => {
  const root = globalThis;
  const parser = root.LR;
  if (!parser || typeof parser.extractPriceSqmFree !== "function") {
    throw new Error("facebook-classifier.js requires parse.js to load first.");
  }

  const normalizeQuotes = (value) =>
    String(value || "")
      .replace(/[״“”]/g, '"')
      .replace(/[׳‘’]/g, "'");

  // כמה מפרטי המודעה יש בפוסט – 7 פרמטרים: מחיר, שטח (מ"ר / מטר / מטר מרובע עם מספר), חדרים, קומה,
  // מיקום (רחוב/עיר/שכונה), סוג נכס, ומאפיינים (ממ"ד / מעלית / חניה / מרפסת / מחסן...).
  // מודעה = לפחות חצי מהפרטים העיקריים (3; מאפיינים נספרים כאחד מהם), וגם לפחות אחד מהבסיסיים:
  // מחיר, שטח או חדרים.
  // פוסט עם פחות מזה הוא בדרך כלל סתם פוסט של אנשים ("מישהו מכיר דירה באזור?").
  const SQM_RE = /(?<![\d.,])\d{2,4}(?:[.,]\d+)?\s*(?:מ["'״׳]?ר(?![א-ת])|מ["'״׳]ר|מטר(?:ים)?(?:\s+מרובע(?:ים)?)?(?![א-ת])|מ\s*["'״׳]?\s*ר\b|sqm\b|m2\b|מ²)/i;
  // שטח הדירה מהטקסט – בלי שטח של מרפסת / גינה / מחסן ("מרפסת 12 מר", "30 מ"ר מרפסות")
  const EXTRA_AREA_BEFORE = /(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|חני(?:ה|ות)|גג|מרתף)[^\n\d]{0,8}$/;
  const EXTRA_AREA_AFTER = /^\s*(?:של\s+)?(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|גג|מרתף)/;
  function apartmentSqm(source) {
    for (const match of source.matchAll(new RegExp(SQM_RE.source, "gi"))) {
      if (EXTRA_AREA_BEFORE.test(source.slice(Math.max(0, match.index - 16), match.index))) continue;
      if (EXTRA_AREA_AFTER.test(source.slice(match.index + match[0].length, match.index + match[0].length + 12))) continue;
      const value = Number(match[0].match(/\d{2,4}(?:[.,]\d+)?/)[0].replace(",", "."));
      if (value >= 15 && value <= 1000) return value;
    }
    return null;
  }
  const AMENITY_RE = /ממ["'״׳]?ד|מרחב\s+מוגן|מעלית|חני(?:ה|יה|ות)|מרפס(?:ת|ות)|מחסן|מיזוג|מזגנים|דוד\s+שמש|גינה|משופצת|שמורה/;
  const LISTING_FIELDS_MIN = 3;
  function listingDetails(source, parsed) {
    const location = typeof parser.parseFreeAddress === "function" ? parser.parseFreeAddress(source) : null;
    const fields = {
      price: Boolean(parsed && parsed.price),
      sqm: Boolean(parsed && parsed.sqm) || apartmentSqm(source) !== null,
      rooms: /\d(?:[.,]\d)?\s*(?:חדרים?|חד['׳]?)(?![א-ת])|(?:שני|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש)\s+חדרים/.test(source),
      floor: /קומה\s*:?\s*-?\d|קומת\s+(?:קרקע|גג|כניסה)|קומה\s+(?:ראשונה|שנייה|שניה|שלישית|רביעית|חמישית|אחרונה|גבוהה|נמוכה)|\d{1,2}\s*מתוך\s*\d{1,2}/.test(source),
      location: Boolean(location && (location.street || location.city || location.hood)),
      type: /דירה|דירת|פנטהאוז|דופלקס|טריפלקס|קוטג|וילה|בית\s+(?:פרטי|צמוד|דו)|יחידת\s+דיור|מיני\s*פנטהאוז|מגרש/.test(source),
      amenities: AMENITY_RE.test(source),
    };
    const count = Object.values(fields).filter(Boolean).length;
    // חובה: מחיר או שטח (מספר עם מ"ר / מטר) – בלי אף אחד מהם זה לא מודעה, גם עם חדרים ומאפיינים
    const core = fields.price || fields.sqm;
    return { fields, count, enough: core && count >= LISTING_FIELDS_MIN };
  }

  function listingOrThin(source, parsed) {
    const details = listingDetails(source, parsed);
    return details.enough
      ? { type: "listing", parsed, details: details.count }
      : { type: "other", thin: true, details: details.count };
  }

  // פוסט "נמכר" (הודעת הצלחה של מתווך) – לא מודעה
  const SOLD_RE = /(?:^|[\s!*|])נמכר(?:ה)?\s*[!.]|ירד(?:ה)?\s+מהמדף|נ\s*-\s*מ\s*-\s*כ\s*-\s*ר|עבר(?:ה)?\s+לסטטוס|\bSOLD\b(?!\s*out)/i;
  // נכס מסחרי (משרד / חנות / מבנה) – לא דירת מגורים
  const COMMERCIAL_RE = /חנות|חנויות|משרד(?:ים)?(?:\s|\d|:|$)|\d\s*משרדים|נכס\s+מסחרי|שטח\s+מסחרי|מבנה\s+תעשי|אולם\s+(?:אירועים|תצוגה)|קליניקה|מחסן\s+לוגיסטי/;
  const HOME_RE = /דירה|דירת|דירות|בית\s+פרטי|הבית|וילה|קוטג|פנטהאוז|דופלקס|דו[-\s]?משפחתי|יחידת\s+דיור/;
  // סכומים חודשיים שאינם שכר דירה של המודעה: נכס מושכר שמוצע למכירה, ועד בית, ארנונה
  const RENT_NOISE_RE = /(?:מושכר(?:ת)?|מניב(?:ה)?|שכירות\s+קיימת|מקבלת\s+שכירות|תשואת\s+שכירות|ועד\s+(?:ה)?בית|ארנונה|הנכס\s+מושכר|כיום\s+מושכר(?:ת)?)[^\n]{0,70}/g;
  // מכירה בלי המילה "למכירה": "בבלעדיות", "בייצוג בלעדי", "מחיר שיווק", "מוכרת את הבית"
  const SALE_EXTRA_RE = /בבלעדיות|בלעדיות|בייצוג\s+בלעדי|חדש(?:ה)?\s+ובלעדי|מחיר\s+(?:שיווק|מבוקש)|מוכר(?:ת|ים)?\s+את\s+(?:ה)?(?:דירה|בית|נכס)|הזדמנות\s+(?:השקעה|למשקיעים)/;

  function classifyFacebookPost(text) {
    const original = normalizeQuotes(text);
    if (SOLD_RE.test(original)) return { type: "other", sold: true };
    if (COMMERCIAL_RE.test(original) && !HOME_RE.test(original)) return { type: "other", commercial: true };
    // לזיהוי השכרה: בלי משפטים על שכר דירה קיים / ועד בית (אלה לא אומרים שהמודעה להשכרה)
    const source = original.replace(RENT_NOISE_RE, " ");
    const seekingMatch =
      /מחפש(?:ת|ים|ות)?\s+(?:(?:.{1,35}?)\s+)?(?:דירה|דירות|נכס|נכסים|בית|בתים|יחיד(?:ה|ת)(?:\s+דיור)?|קרקע|מגרש|חדרים?|לשכור|לקנות|לרכוש|שותף|שותפים)/.exec(
        source
      );
    const seekingIndex = seekingMatch ? seekingMatch.index : -1;
    const saleMatch =
      /למכירה|למכור|מוכר(?:ת)?\s+(?:דירה|נכס|בית)|מכירה\s+(?:ישירה|מפרטי|פרטית)/.exec(source) ||
      SALE_EXTRA_RE.exec(source);
    const saleIndex = saleMatch ? saleMatch.index : -1;
    const rentMatch =
      /להשכרה|לשכירות|השכרה|שכר\s*דירה|שכ"ד|דמי\s*שכירות|לחודש|\/\s*חודש|בחודש|סאבלט/.exec(
        source
      );
    const rentIndex = rentMatch ? rentMatch.index : -1;
    const property =
      /דירה|דירת|חדרים|חד'|פנטהאוז|דופלקס|טריפלקס|מ"ר|מ'ר|\bמר\b|נכס|קוטג|בית\b|וילה|מגרש/.test(
        source
      );
    const sellerLanguage =
      /תיאום\s+(?:ביקור|סיור)|חייגו|התקשרו|שלחו\s+הודעה|צרו\s+קשר|בואו\s+להתרשם|מחכה\s+לכם/.test(
        source
      );
    const parsed = parser.extractPriceSqmFree(source);
    // "95 מטר", "95 מטר מרובע", "95 מטרים" – שטח גם כשהמנתח הכללי זיהה רק מ"ר
    if (!parsed.sqm) {
      const value = apartmentSqm(source);
      if (value !== null) {
        parsed.sqm = value;
        if (parsed.price && !parsed.rent) {
          parsed.ppsm = Math.round(parsed.price / value);
          parsed.reason = null;
        } else if (!parsed.price) {
          parsed.reason = "לא זוהה מחיר";
        }
      }
    }
    const hasListingDetails =
      Boolean(parsed.price || parsed.sqm) ||
      /\d(?:[.,]\d)?\s*(?:חדרים?|חד['׳]?)/.test(source);
    const explicitlyForSale = saleIndex >= 0;
    const saleListing =
      explicitlyForSale &&
      property &&
      hasListingDetails &&
      (seekingIndex < 0 || sellerLanguage || saleIndex < seekingIndex) &&
      (rentIndex < 0 || saleIndex < rentIndex);

    if (saleListing) return listingOrThin(source, parsed);

    if (seekingIndex >= 0 && (rentIndex < 0 || seekingIndex < rentIndex)) {
      if (!sellerLanguage) return { type: "seeking" };
    }

    if (rentIndex >= 0 && (saleIndex < 0 || rentIndex < saleIndex)) {
      return { type: "rent" };
    }

    const lowPrice = [...source.matchAll(
      /(?:₪\s*([\d,]{3,})|([\d,]{3,})\s*(?:₪|ש["״]?ח|שקל(?:ים)?))/g
    )]
      .map((match) => Number((match[1] || match[2]).replace(/,/g, "")))
      .some((price) => price >= 800 && price <= 40000);
    if (lowPrice && !explicitlyForSale) return { type: "rent" };

    if (seekingIndex >= 0 && !sellerLanguage) return { type: "seeking" };

    if (property && hasListingDetails) return listingOrThin(source, parsed);
    return { type: "other" };
  }

  parser.classifyFacebookPost = classifyFacebookPost;
  if (typeof module !== "undefined") module.exports = classifyFacebookPost;
})();
