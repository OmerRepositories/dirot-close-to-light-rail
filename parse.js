// Shared extraction helpers (address, price, area, city); Facebook classification lives in facebook-classifier.js.
var LR = (() => {
  const HEB = /[֐-׿]/;
  const W = "[\\u0590-\\u05FF\"'\\-]+"; // מילה בעברית (כולל גרשיים ומקף)

  // מילים שמתארות סוג נכס ולא מקום
  const TYPE_WORDS =
    /^(דירה|דירת גן|דירת גג|גג\/פנטהאוז|פנטהאוז|דופלקס|טריפלקס|בית פרטי|בית|וילה|קוטג'?|מגרש|יחידת דיור|סטודיו|לופט|משק|נחלה|דירת סטודיו|דו משפחתי|חד משפחתי|בניין|מבנה)(\s|$)/;

  // שורות שהן לא כתובת
  const NOISE_LINE =
    /₪|^\d+(\.\d+)?$|חדרים|חד['׳]|מ["״”'׳]ר|קומה|קומות|^חדש( מהקבלן)?$|ממתין|מתווך|תיווך|^פרטי$|קבלן|כניסה|עודכן|^לפני |פרסם|מבצע|ללא עמלה|מציג|מחיר|טלפון|שמור|מועדפים/;

  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const toNum = (s) => Number(String(s).replace(/[^\d.]/g, ""));
  const normQuotes = (s) =>
    String(s || "")
      .replace(/[״“”]/g, '"')
      .replace(/[׳‘’]/g, "'")
      .replace(/[‎‏​-‍⁠﻿]/g, "");

  function normStreet(s) {
    return s
      .replace(/^(רחוב|רח'|רח׳)\s+/, "")
      .replace(/^שד['׳]\s*/, "שדרות ")
      .trim();
  }

  // ---------- ערים ----------
  const CITIES = [
    "תל אביב יפו", "תל אביב", "ירושלים", "חיפה", "ראשון לציון", "פתח תקווה", "אשדוד", "נתניה",
    "באר שבע", "חולון", "בני ברק", "רמת גן", "אשקלון", "רחובות", "בת ים", "הרצליה", "כפר סבא",
    "מודיעין", "רעננה", "חדרה", "לוד", "רמלה", "נס ציונה", "גבעתיים", "הוד השרון", "קריית אונו",
    "אור יהודה", "יהוד", "טבריה", "נהריה", "קריית גת", "עפולה", "עכו", "כרמיאל", "אילת", "נצרת",
    "נצרת עילית", "נוף הגליל", "קריית שמונה", "צפת", "בית שמש", "מעלה אדומים", "מודיעין עילית",
    "ביתר עילית", "בית שאן", "דימונה", "ערד", "אופקים", "נתיבות", "קריית מלאכי", "יבנה", "גדרה",
    "קריית עקרון", "רמת השרון", "גבעת שמואל", "אלעד", "ראש העין", "כפר יונה", "פרדס חנה",
    "זכרון יעקב", "בנימינה", "קיסריה", "טירת כרמל", "קריית אתא", "קריית ביאליק", "קריית מוצקין",
    "קריית ים", "יקנעם", "מגדל העמק", "אור עקיבא", "גן יבנה", "מזכרת בתיה", "באר יעקב", "תל מונד",
    "אבן יהודה", "קדימה צורן", "צור יגאל", "כוכב יאיר", "להבים", "רהט", "טייבה", "טירה",
    "קלנסווה", "אום אל פחם", "שפרעם", "חריש", "שוהם", "גני תקווה", "סביון",
  ];
  const CANON = { "תל אביב": "תל אביב יפו" };
  const ALIASES = {
    'ת"א': "תל אביב יפו",
    'פ"ת': "פתח תקווה",
    "פתח תיקוה": "פתח תקווה",
    "פתח תיקווה": "פתח תקווה",
    'ר"ג': "רמת גן",
    'ראשל"צ': "ראשון לציון",
    'ב"ש': "באר שבע",
    'ב"ב': "בני ברק",
    'ק"ג': "קריית גת",
  };

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function cityPattern(name) {
    return esc(name)
      .replace(/ /g, "[\\s\\-]+")
      .replace(/קריית/g, "קרי?ית")
      .replace(/זכרון/g, "זי?כרון");
  }
  const cityRes = [
    ...CITIES.map((n) => ({ canon: CANON[n] || n, name: n, pat: cityPattern(n) })),
    ...Object.entries(ALIASES).map(([a, c]) => ({ canon: c, name: a, pat: esc(a) })),
  ].map((c) => ({
    ...c,
    re: new RegExp(`(^|[^\\u0590-\\u05FF])([בלמוהש]?)(${c.pat})(?![\\u0590-\\u05FF])`),
  }));

  // מוצא עיר בטקסט חופשי (כותרת קבוצה, פוסט). מחזיר { canon, pat } או null.
  // streetAware: שם עיר שהוא בעצם שם רחוב לא נחשב עיר – "ברחוב ראשון לציון 12" / "רח' חולון 5" /
  // "ראשון לציון 12, פתח תקווה" (שם עיר ומיד אחריו מספר בית). אז מחפשים את המופע הבא של עיר.
  const STREET_BEFORE = /(?:ברחוב|רחוב|ברח'|רח'|בשדרות|שדרות|בשד'|שד'|בשביל|שביל|בסמטת|סמטת|כיכר|בכיכר)\s*:?\s*$/;
  const HOUSE_AFTER = /^\s+\d{1,3}[א-ת]?(?!\d|[.,]\d|\s*(?:חדר|חד'|חד׳|מ"ר|מטר|קומ|דקות|דק'|ק"מ|אלף|מיליון|₪))/;
  function findCityHit(text, { streetAware = false } = {}) {
    const t = normQuotes(text);
    let best = null;
    for (const c of cityRes) {
      let m = null;
      if (streetAware) {
        const all = new RegExp(c.re.source, "g");
        for (const hit of t.matchAll(all)) {
          const start = hit.index + hit[1].length;
          const end = hit.index + hit[0].length;
          if (STREET_BEFORE.test(t.slice(Math.max(0, start - 12), start)) || HOUSE_AFTER.test(t.slice(end, end + 30))) continue;
          m = hit;
          break;
        }
      } else {
        m = c.re.exec(t);
      }
      if (!m) continue;
      const cand = {
        canon: c.canon,
        pat: c.pat,
        idx: m.index,
        len: c.name.length,
        end: m.index + m[0].length,
        b: m[2] === "ב" ? 1 : 0,
      };
      if (
        !best ||
        cand.b > best.b ||
        (cand.b === best.b && (cand.idx < best.idx || (cand.idx === best.idx && cand.len > best.len)))
      ) {
        best = cand;
      }
    }
    return best;
  }
  const findCity = (text) => {
    const h = findCityHit(text);
    return h ? h.canon : null;
  };
  function findCities(text) {
    const t = normQuotes(text);
    return [...new Set(cityRes.filter((city) => city.re.test(t)).map((city) => city.canon))];
  }

  // ---------- בניית שאילתות גיאוקוד ----------
  // מחזיר [{ q, approx, bias }] לפי סדר עדיפות.
  function buildQueries({ street, ctx, city, hood, allowCityOnly = true }) {
    const queries = [];
    const add = (q, approx = false, bias = false, cityOnly = false) => {
      if (q && !queries.some((x) => x.q === q)) queries.push({ q, approx, bias, ...(cityOnly ? { cityOnly: true } : {}) });
    };
    const st = street ? normStreet(street) : null;
    if (st) {
      const noNum = st.replace(/\s*\d+[א-ת]?\s*$/, "").trim();
      const hasNum = noNum !== st && noNum.length >= 2;
      // אם המשתמש סינן לפי עיר / הפוסט מציין עיר – זה הניסיון הראשון
      if (ctx) add(`${st}, ${ctx}`);
      if (city && city !== ctx) add(`${st}, ${city}`);
      if (hood && hood !== city && hood !== ctx) add(`${st}, ${hood}`);
      // בלי מספר בית (רחוב בלבד) – הערכה
      if (hasNum) {
        if (ctx) add(`${noNum}, ${ctx}`, true);
        else if (city) add(`${noNum}, ${city}`, true);
      }
      add(st, true, true); // רחוב בלי עיר (עם הטיה לאזור הדף)
    }
    if (hood && (ctx || city)) add(`${hood}, ${ctx || city}`, true);
    if (!st && !hood && allowCityOnly) {
      const c = city || ctx;
      if (c) add(c, true, false, true);
    }
    return queries.slice(0, 6);
  }

  // ---------- כרטיס מרשימה (יד2 / מדלן) ----------
  function parseAddress(text, ctxCity) {
    let raw = String(text || "")
      .split("\n")
      .map(clean)
      .filter(Boolean);
    // פיצול לפי מפרידים כמו " · "
    raw = raw.flatMap((l) => l.split(/\s[·•|‧]\s/)).map(clean).filter(Boolean);
    // מספר שנשאר לבד בשורה מצורף לשורה שלפניו ("פנחס מאירי" + "37")
    const merged = [];
    for (const l of raw) {
      const prev = merged[merged.length - 1];
      if (/^\d{1,4}$/.test(l) && prev && HEB.test(prev) && !/\d$/.test(prev) && !/,$/.test(prev)) {
        merged[merged.length - 1] = prev + " " + l;
      } else merged.push(l);
    }

    const lines = merged.filter((s) => s.length < 90 && HEB.test(s) && !NOISE_LINE.test(s));

    let street = null;
    const locs = []; // שכונה / עיר, לפי סדר הופעה

    for (const line of lines) {
      if (line.includes(",")) {
        const parts = line
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p && !TYPE_WORDS.test(p));
        if (!parts.length) continue;
        const di = parts.findIndex((p) => /\d/.test(p));
        if (di >= 0 && !street) {
          street = parts[di];
          parts.splice(di, 1);
        }
        for (const p of parts) if (!locs.includes(p)) locs.push(p);
      } else if (!street && /\d/.test(line) && line.length >= 4 && !TYPE_WORDS.test(line)) {
        street = line;
      }
    }

    const city = locs.length ? locs[locs.length - 1] : null;
    const hood = locs.length > 1 ? locs[0] : null;
    const queries = buildQueries({ street, ctx: ctxCity || null, city, hood });
    return { queries, street: street ? normStreet(street) : null, city, hood };
  }

  // מחיר, שטח, ומחיר למ"ר מכרטיס יד2/מדלן. תמיד מחזיר אובייקט; ppsm הוא null אם אי אפשר לחשב.
  function extractPriceSqm(text) {
    text = String(text || "");

    let price = null;
    const pm = text.match(/₪\s*([\d,]{5,})/) || text.match(/([\d,]{5,})\s*₪/);
    if (pm) price = toNum(pm[1]);
    if (!price) {
      const mm = text.match(/(\d+(?:\.\d+)?)\s*(?:מיליון|M\b)/);
      if (mm) price = Math.round(toNum(mm[1]) * 1e6);
    }
    if (!price) {
      // גיבוי: מספר גדול עם פסיקים, גם בלי סימן ₪
      const nums = [...text.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)]
        .map((m) => toNum(m[0]))
        .filter((n) => n >= 100000);
      if (nums.length) price = nums[0];
    }

    let sqm = null;
    const sm = text.match(/(?<![\d.,])(\d{2,4}(?:\.\d+)?)\s*מ["״”'׳]?ר(?![א-ת])/);
    if (sm) sqm = toNum(sm[1]);
    if (sqm && (sqm < 15 || sqm > 1000)) sqm = null;

    let reason = null;
    if (!price && !sqm) reason = "לא זוהו מחיר ושטח";
    else if (!price) reason = "לא זוהה מחיר";
    else if (!sqm) reason = "לא זוהה שטח (מ״ר)";
    else if (price < 100000) reason = "נראה כמחיר שכירות";

    const ppsm = !reason ? Math.round(price / sqm) : null;
    return { price, sqm, ppsm, reason };
  }

  // ---------- טקסט חופשי (פוסטים בפייסבוק) ----------
  const STOP_AFTER = new Set([
    "ליד", "קרוב", "בלב", "מרכז", "ב", "ו", "עם", "על", "צמוד", "במרכז", "מרפסת", "חדרים", "קומה", "מחיר", "דירה", "בבניין", "בניין", "למכירה", "להשכרה",
    // "ברחוב רמבם בפתח תקווה", "שפרינצק שבשכונת אחדות", "בפרויקט סמייל במתחם" – כאן נגמר שם הרחוב
    "בפתח", "בקרית", "בקריית", "ברמת", "בגבעת", "בראש", "בבני", "בתל", "בכפר", "בהוד", "באור", "בנס", "בבת", "בגני",
    "שבשכונת", "בשכונת", "שכונת", "במתחם", "בפרויקט", "בפרוייקט", "פינת", "המבוקש", "המבוקשת",
  ]);
  const BAD_STREET_FIRST = new Set([
    "קומה", "קומת", "בניין", "בנין", "דירה", "דירת", "מחיר", "גודל", "שטח", "כניסה", "חדרים", "חדר",
    "מרפסת", "מגדל", "פרויקט", "אזור", "סביבת", "חודש", "תאריך", "שעה", "יום", "שנת", "שנה", "בית",
    "בניינים", "שכונה", "שכונת", "קבוצה", "שיפוץ", "מטבח", "מקלט", "חניה", "מעלית", "מחסן", "מ",
    // תארים שבאים אחרי שם הרחוב בפוסטים ("ברחוב הכרם המבוקש")
    "המבוקש", "המבוקשת", "השקט", "השקטה", "הירוק", "הירוקה", "היוקרתי", "היוקרתית", "המרכזי", "המרכזית", "הקטן", "הקטנה", "המדהים", "המדהימה", "הפסטורלי", "הפסטורלית",
    // "ברחוב פנימי ושקט", "רחוב קטן וסולידי ללא מוצא", "רחוב שקט וחד סיטרי" – תיאור, לא שם
    "פנימי", "שקט", "שקטה", "ושקט", "ושקטה", "קטן", "קטנה", "ללא", "ראשי", "צדדי", "מבוקש", "יוקרתי", "ירוק", "פסטורלי", "חד", "וסולידי", "ופסטורלי",
    // תוויות ומילים שאינן רחוב ("שכירות: 6,000", "למחיר: קישור", "נייד 054...", "רישיון 3145176")
    "שכירות", "שכ\"ד", "למחיר", "עדכון", "תקציב", "נייד", "וואטסאפ", "ווצאפ", "טלפון", "טל", "לסרטון", "לתמונות", "לפרטים", "ויש", "יש",
    "חדרי", "רישיון", "רשיון", "תיווך", "כירה", "ניין", "נוי", "מתחם", "במתחם", "בפרויקט", "סמוך", "כביש", "לכביש", "מספר", "מס'", "בתוך",
    "בנוי", "נטו", "ברוטו", "מגרש", "ועד", "דונם", "קומות", "עד",
  ]);
  // מספר בית: 1–400, לא מתחיל ב-0 (טלפון "054...") ולא חלק ממספר גדול (רישיון / מחיר)
  const validHouseNumber = (value) => {
    const number = Number(String(value).replace(/[א-ת]$/, ""));
    return /^[1-9]/.test(String(value)) && number >= 1 && number <= 400;
  };
  // אחרי מספר בית לא יבוא: ספרה נוספת, ‏",123" (חלק ממחיר) או יחידה (חדרים, מ"ר, ₪...)
  const NOT_AFTER_NUM = "(?!\\d|[,.]\\d|\\s*(?:חדר|חד'|קומה|קומות|מ\"ר|מר\\b|מטר|אלף|מיליון|₪|%|ש\"ח|שח|שקל))";

  function cleanStreetWords(words) {
    const parts = words.trim().split(/\s+/);
    const out = [];
    for (const p of parts) {
      if (STOP_AFTER.has(p) || BAD_STREET_FIRST.has(p)) break;
      out.push(p);
    }
    return out.join(" ");
  }

  function parseFreeAddress(text, ctxCity) {
    // השורות נשמרות: שם רחוב לא ממשיך לשורה הבאה ("ברח' רוטשילד" + שורה "יחידת דיור")
    const t = normQuotes(text).replace(/[^\S\n]+/g, " ").replace(/ ?\n[\s]*/g, "\n");
    const S = "[ \\t]"; // רווח בתוך שורה
    const cityHit = findCityHit(t.replace(/\n/g, " "), { streetAware: true });
    const city = cityHit ? cityHit.canon : null;
    const ctx = city || ctxCity || null;

    let street = null;

    // א) עם מילת "רחוב"/"שדרות" + מספר ("רחוב" לבד – לא "הרחובות")
    let m = new RegExp(
      `(?<![א-ת])(?:ברחוב|רחוב|ברח'|רח'|בשדרות|שדרות|בשד'|שד')(?![א-ת])${S}*:?${S}*(${W}(?:${S}${W}){0,2}?)${S}*,?${S}*(\\d{1,3})${NOT_AFTER_NUM}`
    ).exec(t);
    if (m && validHouseNumber(m[2])) {
      const name = cleanStreetWords(m[1]);
      if (name && name.length >= 2) street = `${name} ${m[2]}`;
    }
    // ב) "ברחוב" / "רחוב" בלי מספר
    if (!street) {
      m = new RegExp(`(?<![א-ת])(?:ברחוב|רחוב|ברח'|רח')(?![א-ת])${S}*:?${S}*(${W}(?:${S}${W}){0,2})`).exec(t);
      if (m) {
        const name = cleanStreetWords(m[1]);
        if (name && name.length >= 2) street = name;
      }
    }
    // ו) שורה (או חלק של שורה עד פסיק / מקף / קו) שכולה "שם רחוב + מספר": "יוסף ספיר 29",
    // "בר אילן 9,כפר אברהם", "חדש למכירה במרכז השקט - סלומון 9". לפני ג, כדי ש"בר אילן" לא ייקרא "ב+ר אילן"
    if (!street) {
      outer: for (const rawLine of normQuotes(text).split(/\n/)) {
        // פסיק בתוך מספר ("6,000") לא מפצל; חלק עם קישור הוא לא כתובת
        for (const part of rawLine.split(/,(?!\d)|\s[-–|]\s|\|/)) {
          if (/https?:|www\.|\.com|\.li\//i.test(part)) continue;
          const line = part.replace(/[^֐-׿\d\s'"\-]/g, " ").replace(/\s+/g, " ").trim()
            .replace(/^(?:(?:ויש|יש)\s+את\s+|את\s+)/, "");
          const lm = new RegExp(`^(${W}(?:\\s${W}){0,2})\\s+(\\d{1,3}[א-ת]?)$`).exec(line);
          if (!lm || !validHouseNumber(lm[2])) continue;
          const name = cleanStreetWords(lm[1]);
          const first = name.split(" ")[0];
          if (
            name === lm[1].trim() && name.length >= 3 && !BAD_STREET_FIRST.has(first) && !findCity(name) &&
            !/חדר|קומה|קומות|מ"ר|מטר|דירות|דיירים|שנים|שנה|דקות|חודש|כיוונ|מרפס|חניה|חניות|תמא|תמ"א|מחסן/.test(lm[0])
          ) {
            street = `${name} ${lm[2]}`;
            break outer;
          }
        }
      }
    }
    // ג) "בהרצל 12"
    if (!street) {
      const re = new RegExp(
        `(?:^|[\\s,.:;(\\-])ב(${W}(?:${S}${W}){0,2}?)${S}+(\\d{1,3})${NOT_AFTER_NUM}`,
        "g"
      );
      let mm;
      while ((mm = re.exec(t))) {
        // מילות מילוי בתחילת השם: "בבלעדיות אורלנסקי 5" → "אורלנסקי 5"
        const raw = mm[1].trim().replace(/^(?:(?:בלעדיות|בבלעדיות|בלעדי|ייצוג|ייצוג\s+בלעדי|למכירה|מכירה|חדש|חדשה)\s+)+/, "");
        const name = cleanStreetWords(raw);
        const first = name.split(" ")[0];
        // אם מילה כמו "קומה" חתכה את השם – המספר לא שייך לרחוב ("בנוי קומה 6")
        if (name.length >= 2 && name === raw && validHouseNumber(mm[2]) && !BAD_STREET_FIRST.has(first) && !findCity(name) && !/^נוי$|^ניין$/.test(name)) {
          street = `${name} ${mm[2]}`;
          break;
        }
      }
    }
    // ד) "הרצל 12 פתח תקווה" – שם רחוב ומספר ממש לפני העיר
    if (!street && cityHit) {
      const re = new RegExp(
        `(${W}(?:${S}${W}){0,1})${S}+(\\d{1,3})\\s*,?\\s*(?:ב-?)?(?:${cityHit.pat})`
      );
      const mm = re.exec(t);
      if (mm && validHouseNumber(mm[2]) && !BAD_STREET_FIRST.has(mm[1].split(" ")[0])) {
        const name = cleanStreetWords(mm[1]);
        if (name.length >= 2) street = `${name} ${mm[2]}`;
      }
    }

    // ה) "ברמת גן, ז'בוטינסקי 40" – רחוב ומספר ממש אחרי העיר
    if (!street && cityHit) {
      const after = t.replace(/\n/g, " ").slice(cityHit.end);
      const mm = new RegExp(
        `^\\s*[,.:\\-–]?\\s*(${W}(?:\\s${W}){0,1})\\s+(\\d{1,3})${NOT_AFTER_NUM}`
      ).exec(after);
      if (mm && validHouseNumber(mm[2])) {
        const name = cleanStreetWords(mm[1]);
        const first = name.split(" ")[0];
        if (name.length >= 2 && !BAD_STREET_FIRST.has(first)) street = `${name} ${mm[2]}`;
      }
    }

    // שכונה
    let hood = null;
    const hm = new RegExp(`(?:בשכונת|שכונת|בשכ'|שכ')\\s*(${W}(?:\\s${W}){0,1})`).exec(t);
    if (hm) {
      const name = cleanStreetWords(hm[1]);
      if (name.length >= 2) hood = name;
    }

    const queries = buildQueries({
      street,
      ctx,
      city: null,
      hood,
      allowCityOnly: false, // בפייסבוק מרחק ממרכז עיר חסר משמעות
    });
    return { queries, street, city, hood };
  }

  function extractPriceSqmFree(text) {
    let t = normQuotes(text);
    // סכומים חודשיים שלא אומרים שהמודעה להשכרה: דירה מושכרת שמוצעת למכירה, ועד בית, ארנונה
    const rentProbe = t.replace(
      /(?:מושכר(?:ת)?|מניב(?:ה)?|שכירות\s+קיימת|מקבלת\s+שכירות|תשואת\s+שכירות|ועד\s+(?:ה)?בית|ארנונה|הנכס\s+מושכר|כיום\s+מושכר(?:ת)?)(?:(?!מחיר)[^\n|]){0,70}/g,
      " "
    );
    const isRent =
      /להשכרה|לשכירות|השכרה|שכר\s*דירה|שכ"ד|דמי\s*שכירות|לחודש|\/\s*חודש|בחודש|סאבלט/.test(
        rentProbe
      ) && !/למכירה|מכירה\s+(?:ישירה|מפרטי|פרטית)|בבלעדיות|בייצוג\s+בלעדי|מחיר\s+(?:שיווק|מבוקש)|מוכר(?:ת|ים)?\s+את/.test(t);
    const cands = [];
    const push = (val, idx, len) => {
      // "בפחות מ-2 מיליון" / "עד 2.5 מיליון" – תקרה, לא המחיר
      if (/(?:בפחות\s+מ|פחות\s+מ|מתחת\s+ל|עד)\s*-?\s*$/.test(t.slice(Math.max(0, idx - 12), idx))) return;
      // מספר רישיון תיווך / טלפון / "בהשקעה של 2 מיליון" (שיפוץ) – לא מחיר הדירה
      const before = t.slice(Math.max(0, idx - 24), idx);
      if (/(?:רי?שיון|רשיון|ר\.ת\.?|ח\.פ\.?|ע\.מ\.?)[^\d\n]{0,12}$|השקעה\s+של\s+(?:מעל\s+|כ-?\s*)?$/.test(before)) return;
      const ctx = t.slice(Math.max(0, idx - 14), idx + len + 8);
      // "עדכון מחיר: 2,100,000" / "מחיר מעודכן" / "ירד ל-" גובר על "מחיר שיווק" שבאותו פוסט
      const updated = /(?:עי?דכון\s+מחיר|מחיר\s+(?:מעודכן|חדש|עדכני|אחרי\s+הורדה)|ירד(?:ה)?\s+ל|הורד(?:ה|נו|נו\s+את\s+המחיר)?\s+(?:מחיר\s+)?ל)\W{0,6}$/.test(
        t.slice(Math.max(0, idx - 30), idx)
      );
      const strong = updated ? 2 : /₪|ש"ח|שח\b|שקל|מחיר|מבוקש|מבקש|מיליון|אלף|ב-/.test(ctx) ? 1 : 0;
      cands.push({ val, idx, strong });
    };
    const mask = (m) => {
      t = t.slice(0, m.index) + " ".repeat(m[0].length) + t.slice(m.index + m[0].length);
    };

    let m;
    // מיליון + אלף: "2 מיליון ו300 אלף"
    const reMA = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:מיליון|מליון)\s*ו-?\s*(\d{2,3})\s*אלף/g;
    while ((m = reMA.exec(t))) {
      push(parseFloat(m[1].replace(",", ".")) * 1e6 + Number(m[2]) * 1e3, m.index, m[0].length);
    }
    for (const x of [...t.matchAll(reMA)]) mask(x);

    // "מיליון וחצי" / "2 מיליון וחצי"
    const reHalf = /(\d{1,2})?\s*(?:מיליון|מליון)\s*ו?חצי/g;
    for (const x of [...t.matchAll(reHalf)]) {
      push(((x[1] ? Number(x[1]) : 1) + 0.5) * 1e6, x.index, x[0].length);
      mask(x);
    }

    // "2.5 מיליון" / "2 מיליון" / "2.5M" / "2.5 מ'" (הצורות הקצרות רק עם נקודה עשרונית)
    // ("17.5 מ'ר" הוא שטח מרפסת, לא 17.5 מיליון – אחרי "מ" לא יבוא גרש ואז אות)
    const reMil = /(?<![\d.,])(\d{1,2}(?:[.,]\d{1,3})?)\s*(מיליון|מליון|מיל'|M|m|מ'(?![֐-׿])|מ)(?![֐-׿a-zA-Z0-9"'])/g;
    for (const x of [...t.matchAll(reMil)]) {
      const num = parseFloat(x[1].replace(",", "."));
      const short = ["M", "m", "מ'", "מ"].includes(x[2]);
      if (short && !/[.,]/.test(x[1])) continue;
      if (num >= 0.3 && num <= 50) push(num * 1e6, x.index, x[0].length);
    }

    // "950 אלף" / "950K" / "2,500 אלף"
    const reK = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})*|\d+)\s*(?:אלף|K|k)(?![֐-׿a-zA-Z])/g;
    for (const x of [...t.matchAll(reK)]) {
      const val = Number(x[1].replace(/[.,]/g, "")) * 1000;
      push(val, x.index, x[0].length);
    }

    // מספר מלא: 2,500,000 / 2.500.000 / 2500000 / 5,500
    const reFull = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3}){1,3}|\d{4,8})(?![\d]|[.,]\d)/g;
    for (const x of [...t.matchAll(reFull)]) {
      const before = t.slice(Math.max(0, x.index - 5), x.index);
      if (/0\d{1,2}[-\s.]$/.test(before)) continue; // חלק ממספר טלפון
      if (/^0/.test(x[1])) continue;
      push(Number(x[1].replace(/[.,]/g, "")), x.index, x[0].length);
    }
    // מספר עם פסיק במקום הלא נכון: "2100,000" = 2,100,000
    for (const x of t.matchAll(/(?<![\d.,])(\d{4})[.,](\d{3})(?![\d]|[.,]\d)/g)) {
      push(Number(x[1] + x[2]), x.index, x[0].length);
    }

    const lo = isRent ? 800 : 200000;
    const hi = isRent ? 40000 : 50000000;
    const valid = cands
      .filter((c) => c.val >= lo && c.val <= hi)
      // מחיר דירה הוא כמעט תמיד מספר עגול (אלפים). מספר "עקום" בלי ₪ / "מחיר" לידו הוא בדרך כלל
      // טלפון או רישיון ("0544-788644", "3145176")
      .filter((c) => c.strong > 0 || isRent || c.val % 1000 === 0)
      .sort((a, b) => b.strong - a.strong || a.idx - b.idx);
    const price = valid.length ? Math.round(valid[0].val) : null;

    // ---- שטח ----
    const sq = [];
    const addSq = (val, idx, strong) => {
      if (val >= 20 && val <= 1000) sq.push({ val, idx, strong });
    };
    // שטח של מה שאינו הדירה: מרפסת, גינה, מגרש... וגם סלון / חדר ("סלון בגודל של 40 מ"ר")
    const EXTRA_BEFORE = /(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|חני(?:ה|ות)|גג|מרתף|מגרש|מגרשים|קרקע|סלון|מטבח|(?<![א-ת])חדר(?![א-ת]))[^\n\d]{0,18}$/;
    // תווית ואחריה המספר – באותה שורה בלבד ("בנוי" בסוף שורה לא שייך למספר שבשורה הבאה)
    const labelRe = /(?:בגודל|גודל|בשטח|שטחה|שטח|ברוטו|נטו|בנוי)[ \t]*(?:בנוי)?[ \t]*[:\-–]?[ \t]*(?:של[ \t]+|כ-?[ \t]*)?(\d{2,4}(?:[.,]\d{1,2})?)(?![\d]|\s*(?:חדר|חד'|קומה|₪|מיליון|אלף))/g;
    for (const x of t.matchAll(labelRe)) {
      if (EXTRA_BEFORE.test(t.slice(Math.max(0, x.index - 26), x.index + 1))) continue;
      // "בית ... יושב על שטח של 220 מטר" – שטח המגרש, לא הבית
      if (/(?<![א-ת])על[ \t]*$/.test(t.slice(Math.max(0, x.index - 6), x.index))) continue;
      addSq(parseFloat(x[1].replace(",", ".")), x.index, 1);
    }

    const unitRe = /(?<![\d.,])(\d{2,4}(?:[.,]\d{1,2})?)\s*(מ"ר|מ'ר|מ['׳]|מר|מטר(?:ים)?(?:\s+(?:מרובעים|בנויים|בנוי|נטו|ברוטו))?|מ²|מ2|m²|m2|sqm|sq\.?\s?m)(?![֐-׿\w])/gi;
    for (const x of t.matchAll(unitRe)) {
      const unit = x[2];
      if (/^מטר/.test(unit) && !/מרובע|בנוי|נטו|ברוטו/.test(unit)) {
        // "200 מטר מהים" / "מרחק 100 מטר" – מרחק, לא שטח
        const after = t.slice(x.index + x[0].length, x.index + x[0].length + 14);
        const before = t.slice(Math.max(0, x.index - 12), x.index);
        if (/^\s*(?:מ[֐-׿]{2,}|ל[֐-׿]{2,}|עד\b|מהים|מהחוף)/.test(after)) continue;
        if (/(?:מרחק|עד|במרחק)\s*$/.test(before)) continue;
      }
      // "מרפסת 12 מ"ר" / "30 מ"ר מרפסות" / "גינה 50 מ"ר" – שטח של תוספת, לא של הדירה
      // לפני: עד כמה מילים באותה שורה ("מרפסת שמש גדולה 20 מ"ר"); אחרי: רק באותה שורה
      // ("149 מ"ר" ובשורה הבאה "מרפסת שמש 17 מ"ר" – 149 הוא שטח הדירה)
      const aroundBefore = t.slice(Math.max(0, x.index - 26), x.index);
      const aroundAfter = t.slice(x.index + x[0].length, x.index + x[0].length + 12);
      if (EXTRA_BEFORE.test(aroundBefore)) continue;
      // "מרפסת ענקית ומקורה בשטח של כ־20 מ"ר" – התווית מאריכה את המרחק מהמילה "מרפסת"
      if (/(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|גג|מגרש|סלון)[^\n\d]{0,24}(?:בשטח|בגודל)[ \t]*(?:של[ \t]*)?(?:כ[-־]?[ \t]*)?$/.test(t.slice(Math.max(0, x.index - 50), x.index))) continue;
      if (/^[ \t]*(?:של\s+)?(?:מרפס(?:ת|ות)|גינ(?:ה|ות)|חצר|מחסן|גג|מרתף|מגרש|קרקע)/.test(aroundAfter)) continue;
      // "109 מ"ר בנוי" גובר על "121 מ"ר" כללי (שכולל בדרך כלל מרפסת)
      addSq(parseFloat(x[1].replace(",", ".")), x.index, /^[ \t]*(?:בנוי|נטו)/.test(aroundAfter) || /בנוי|נטו/.test(unit) ? 1 : 0);
    }
    // "109+ 50 מ"ר מרפסת" – המספר הראשון (בלי יחידה) הוא שטח הדירה
    for (const x of t.matchAll(/(?<![\d.,])(\d{2,3})\s*\+\s*\d{1,3}\s*(?:מ"ר|מר|מטר)\s*(?:של\s+)?(?:מרפס|גינ|חצר|גג)/g)) {
      addSq(Number(x[1]), x.index, 0);
    }
    sq.sort((a, b) => b.strong - a.strong || a.idx - b.idx);
    const sqm = sq.length ? sq[0].val : null;

    let reason = null;
    if (!price && !sqm) reason = "לא זוהו מחיר ושטח";
    else if (!price) reason = "לא זוהה מחיר";
    else if (isRent) reason = "מודעת השכרה";
    else if (!sqm) reason = "לא זוהה שטח (מ״ר)";

    const ppsm = !reason ? Math.round(price / sqm) : null;
    return { price, sqm, ppsm, reason, rent: isRent };
  }

  // חדרים וקומה מטקסט חופשי: "4.5 חדרים", "5חד'", "3.5 חדרם", "ארבעה וחצי חדרים";
  // "קומה 4 מתוך 9", "קומה 4/9", "4 מתוך 6", "קומה ראשונה", "קומת קרקע", "קומה 6 ואחרונה"
  const WORD_NUMBERS = { אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, שישה: 6, שש: 6, שבעה: 7, שבע: 7 };
  const FLOOR_WORDS = { קרקע: 0, ראשונה: 1, שנייה: 2, שניה: 2, שלישית: 3, רביעית: 4, חמישית: 5, שישית: 6, שביעית: 7 };
  function extractRoomsFloorFree(text) {
    const t = normQuotes(text);
    let rooms = null;
    const digits = t.match(/(?<![\d.])(\d{1,2}(?:[.,]5)?)\s*(?:\+\s*חצי\s*)?(?:חדרים|חדרם|חדר(?![א-ת])|חד'|חד׳|חד(?![א-ת]|\s*[-־]?\s*(?:משפחתי|פעמי|כיווני|קומתי)))/);
    if (digits) {
      rooms = Number(digits[1].replace(",", ".")) + (/\+\s*חצי/.test(digits[0]) ? 0.5 : 0);
      // "6 חדרים שהפכה ל-4" / "6 חדרים במקור, כיום 5" – המצב של היום קובע
      const after = t.slice(digits.index + digits[0].length, digits.index + digits[0].length + 45);
      const now =
        after.match(/^[^\n]{0,25}?(?:שהפכ|הפכ|שהוסב|הוסב|שפוצל|פוצל|שאוחד|אוחד)[א-ת]*\s+(?:ל|אל)?\s*[-־]?\s*(\d(?:[.,]5)?)(?!\d)/) ||
        after.match(/^[^\n]{0,12}?במקור[^\n\d]{0,6}?(?:כיום|היום|כעת)\s*[-:]?\s*(\d(?:[.,]5)?)(?!\d)/);
      if (now) rooms = Number(now[1].replace(",", "."));
    }
    if (rooms === null) {
      const words = new RegExp(`(${Object.keys(WORD_NUMBERS).join("|")})(\\s+וחצי)?\\s+חדרים`).exec(t);
      if (words) rooms = WORD_NUMBERS[words[1]] + (words[2] ? 0.5 : 0);
    }
    if (rooms !== null && (rooms < 1 || rooms > 15)) rooms = null;
    let floor = null;
    let topFloor = null;
    const numeric = t.match(/קומה\s*:?\s*(-?\d{1,2})(?:\s*(?:מתוך|\/)\s*(\d{1,2}))?/) || t.match(/(?<!\d)(\d{1,2})\s*מתוך\s*(\d{1,2})(?:\s*קומות)?/);
    if (numeric) {
      floor = Number(numeric[1]);
      if (numeric[2]) topFloor = Number(numeric[2]);
    } else {
      const word = new RegExp(`(?:קומה|קומת)\\s+(${Object.keys(FLOOR_WORDS).join("|")})`).exec(t);
      if (word) floor = FLOOR_WORDS[word[1]];
    }
    if (floor !== null && /קומה\s*-?\d{1,2}\s*ואחרונה/.test(t) && topFloor === null) topFloor = floor;
    return { rooms, floor, topFloor };
  }

  function hasExplicitFacebookAddress(text, street) {
    const match = String(street || "").match(/^(.*\S)\s+(\d{1,4}[א-ת]?)$/);
    if (!match) return false;
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = escapeRegExp(match[1]).replace(/\s+/g, "\\s+");
    const number = escapeRegExp(match[2]);
    const normalized = normQuotes(text);
    const prefixed = new RegExp(
      `(?:רחוב|רח'|שדרות|שד')\\s*:?\\s*${name}\\s+${number}(?!\\d)`
    );
    if (prefixed.test(normalized)) return true;

    const city = findCity(normalized);
    if (!city) return false;
    const cityPattern = escapeRegExp(city).replace(/\s+/g, "[\\s-]+");
    return (
      new RegExp(`${name}\\s+${number}\\s*,?\\s*(?:ב-?)?${cityPattern}`).test(normalized) ||
      new RegExp(`${cityPattern}\\s*[,،]\\s*${name}\\s+${number}`).test(normalized)
    );
  }

  // מחיר למ"ר שנראה לא הגיוני כנראה נובע מקריאה שגויה – לא מציגים אותו כאילו הוא אמיתי.
  const PPSM_MIN = 4000;
  const PPSM_MAX = 250000;
  function sanity(r) {
    if (r && r.ppsm && (r.ppsm < PPSM_MIN || r.ppsm > PPSM_MAX)) {
      return {
        ...r,
        ppsm: null,
        reason: `מחיר למ״ר חריג (₪${r.ppsm.toLocaleString("he-IL")}) – כנראה זיהוי שגוי`,
      };
    }
    return r;
  }

  // כרטיס/דף מובנה: מנסה גם את הפרסור המובנה וגם את הפרסור החופשי ומאחד את השאילתות
  function parseAny(text, ctxCity) {
    const a = parseAddress(text, ctxCity);
    const b = parseFreeAddress(text, ctxCity);
    const seen = new Set();
    const queries = [];
    for (const q of [...a.queries, ...b.queries]) {
      if (seen.has(q.q)) continue;
      seen.add(q.q);
      queries.push(q);
    }
    return { queries: queries.slice(0, 7), street: a.street || b.street, city: a.city || b.city, hood: a.hood || b.hood };
  }

  return {
    parseAddress,
    parseAny,
    extractPriceSqm: (t) => sanity(extractPriceSqm(t)),
    parseFreeAddress,
    extractPriceSqmFree: (t) => sanity(extractPriceSqmFree(t)),
    hasExplicitFacebookAddress,
    extractRoomsFloorFree,
    findCity,
    findCities,
  };
})();

if (typeof module !== "undefined") module.exports = LR;
