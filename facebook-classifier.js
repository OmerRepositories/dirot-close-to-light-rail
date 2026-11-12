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
      .replace(/[׳‘’]/g, "'")
      .replace(/[‎‏​-‍⁠﻿]/g, "");

  // כמה מפרטי המודעה יש בפוסט – 7 פרמטרים: מחיר, שטח (מ"ר / מטר / מטר מרובע עם מספר), חדרים, קומה,
  // מיקום (רחוב/עיר/שכונה), סוג נכס, ומאפיינים (ממ"ד / מעלית / חניה / מרפסת / מחסן...).
  // מודעה = לפחות חצי מהפרטים העיקריים (3; מאפיינים נספרים כאחד מהם), וגם לפחות אחד מהבסיסיים:
  // מחיר, שטח או חדרים.
  // פוסט עם פחות מזה הוא בדרך כלל סתם פוסט של אנשים ("מישהו מכיר דירה באזור?").
  const SQM_RE = /(?<![\d.,])\d{2,4}(?:[.,]\d+)?\s*(?:מ["'״׳]?ר(?![א-ת])|מ["'״׳]ר|מטר(?:ים)?(?:\s+מרובע(?:ים)?)?(?![א-ת])|מ\s*["'״׳]?\s*ר\b|sqm\b|m2\b|מ²)/i;
  // שטח הדירה מהטקסט – בלי שטח של מרפסת / גינה / מחסן ("מרפסת 12 מר", "30 מ"ר מרפסות")
  const EXTRA_AREA_BEFORE = /(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|חני(?:ה|ות)|גג|מרתף|מגרש|מגרשים|קרקע|סלון|מטבח|(?<![א-ת])חדר(?![א-ת]))[^\n\d]{0,18}$/;
  const EXTRA_AREA_AFTER = /^[ \t]*(?:של\s+)?(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|גג|מרתף|מגרש|קרקע)/;
  function apartmentSqm(source) {
    for (const match of source.matchAll(new RegExp(SQM_RE.source, "gi"))) {
      const before = source.slice(Math.max(0, match.index - 26), match.index);
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 12);
      if (EXTRA_AREA_BEFORE.test(before)) continue;
      if (EXTRA_AREA_AFTER.test(after)) continue;
      // "50 מטר מהרכבת" / "במרחק 200 מטר" – מרחק, לא שטח
      if (/מטר/.test(match[0]) && (/^\s*(?:מה[א-ת]{2,}|ממ[א-ת]{2,}|מתחנ|מבית|ל(?:ה)?(?:רכבת|ים|חוף|תחנ|פארק|מרכז|קניון)|עד)/.test(after) || /(?:מרחק|במרחק|עד)\s*$/.test(before))) continue;
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
  const COMMERCIAL_RE = /(?<![א-ת])(?:חנות|חנויות)|(?<![א-ת])משרד(?:ים)?(?:\s|\d|:|$)|\d\s*משרדים|נכס\s+מסחרי|שטח\s+מסחרי|מבנה\s+תעשי|אולם\s+(?:אירועים|תצוגה)|קליניקה|מחסן\s+לוגיסטי/;
  const HOME_RE = /דירה|דירת|דירות|בית\s+פרטי|הבית|וילה|קוטג|פנטהאוז|דופלקס|דו[-\s]?משפחתי|יחידת\s+דיור|\d(?:\.5)?\s*חדרים/;
  // סכומים חודשיים שאינם שכר דירה של המודעה: נכס מושכר שמוצע למכירה, ועד בית, ארנונה
  const RENT_NOISE_RE = /(?:מושכר(?:ת)?|מניב(?:ה)?|שכירות\s+קיימת|שכירות\s+חודשית|מקבלת\s+שכירות|תשואת\s+שכירות|תשואה|ועד\s+(?:ה)?בית|ארנונה|הנכס\s+מושכר|כיום\s+מושכר(?:ת)?|(?:מוצעת|ניתן|אפשר)\s+גם\s+להשכרה)(?:(?!מחיר)[^\n|]){0,70}/g;
  // מגרש בלבד (בלי בית בנוי) – לא דירה
  const PLOT_ONLY_RE = /(?:למכירה|רכישת|מוכר(?:ים|ת)?)\s+מגרש|מגרש\s+(?:למכירה|לבנייה|לבניה)/;
  const BUILT_HOME_RE = /בנוי|בית\s+(?:פרטי|קיים|בנוי)|דירה|דירת|\d\s*חדרים|וילה|קוטג/;
  // פרויקט חדש: "דירות 5 חדרים החל מ-2,750,000" – מחיר התחלתי, לא דירה מסוימת
  const PROJECT_RE = /החל\s+מ[-־]?\s*₪?\s*\d|(?:דירות|יחידות)\s+אחרונות|בפרויקט\s+(?:חדש|יוקרתי)[^\n]{0,40}(?:דירות|יחידות)\s+\d/;
  // "מחפשים דירת 4 חדרים? ... אז כדאי שתכירו" – שאלה רטורית של מוכר, לא מחפש
  const RHETORICAL_SEEKING_RE = /^[^\n?]{0,120}\?/;
  // מכירה בלי המילה "למכירה": "בבלעדיות", "בייצוג בלעדי", "מחיר שיווק", "מוכרת את הבית"
  const SALE_EXTRA_RE = /בבלעדיות|בלעדיות|בייצוג\s+בלעדי|חדש(?:ה)?\s+ובלעדי|מחיר\s+(?:שיווק|מבוקש)|מוכר(?:ת|ים)?\s+את\s+(?:ה)?(?:דירה|בית|נכס)|הזדמנות\s+(?:השקעה|למשקיעים)/;

  // בניין שלם / מבנה מחולק ליחידות – לא דירה בודדת
  const BUILDING_RE = /בניין\s+(?:שלם|של\s+\d+\s+(?:קומות|דירות|יחידות)|\d+\s+קומות|מגורים\s+שלם)|מחולק\s+ל[-־\s]?\d+\s+(?:יחידות|דירות)/;
  // "תתרגל להגיד נמכר" – סלוגן שיווקי בתוך מודעה, לא הודעת "נמכר"
  const SOLD_SLOGAN_RE = /(?:להגיד|לומר|תגיד(?:ו|י)?)\s+["']?נמכר(?:ה)?/g;

  function classifyFacebookPost(text) {
    const original = normalizeQuotes(text);
    if (SOLD_RE.test(original.replace(SOLD_SLOGAN_RE, " "))) return { type: "other", sold: true };
    if (BUILDING_RE.test(original)) return { type: "other", building: true };
    if (PLOT_ONLY_RE.test(original) && !BUILT_HOME_RE.test(original)) return { type: "other", plot: true };
    if (PROJECT_RE.test(original)) return { type: "other", project: true };
    if (COMMERCIAL_RE.test(original) && !HOME_RE.test(original)) return { type: "other", commercial: true };
    // לזיהוי השכרה: בלי משפטים על שכר דירה קיים / ועד בית (אלה לא אומרים שהמודעה להשכרה)
    const source = original.replace(RENT_NOISE_RE, " ");
    let seekingMatch = null;
    for (const match of source.matchAll(
      /מחפש(?:ת|ים|ות)?\s+(?:(?:.{1,35}?)\s+)?(?:דירה|דירות|דירת|נכס|נכסים|בית|בתים|יחיד(?:ה|ת)(?:\s+דיור)?|קרקע|מגרש|חדרים?|לשכור|לקנות|לרכוש|שותף|שותפים|הפינה|פינה)|דרוש(?:ה|ים|ות)?\s+(?:דירה|דירת|נכס|בית|יחידת)|תקציב\s*:?\s*(?:של\s+)?עד/g
    )) {
      // שאלה רטורית בפוסט של מוכר ("מחפשים דירה מרווחת? בשישי אני פותח את הדלת") – לא מחפש
      if (RHETORICAL_SEEKING_RE.test(source.slice(match.index))) continue;
      seekingMatch = match;
      break;
    }
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
      /דירה|דירת|חדרים|חד'|פנטהאוז|דופלקס|טריפלקס|מ"ר|מ'ר|\bמר\b|נכס|קוטג|בית\b|וילה|מגרש|יחידת\s+דיור|יחידה/.test(
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
      // "150 ש"ח לחודש" בפוסט על אימונים / חוגים – לא השכרת דירה
      if (!property) return { type: "other" };
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
