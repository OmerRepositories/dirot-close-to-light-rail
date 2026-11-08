var LRCacheData = (() => {
  function hasUncertainInitialPriceBaseline(history) {
    if (!Array.isArray(history) || history.length < 1) return false;
    const first = history[0];
    if (!first) return false;
    if (first.baselineUnknown === true) return true;
    if (first.baselineKnown === true) return false;
    const second = history[1];
    if (
      !second ||
      !Number.isFinite(first.at) ||
      !Number.isFinite(second.at) ||
      first.price === second.price
    ) {
      return false;
    }
    const firstDate = new Date(first.at);
    const secondDate = new Date(second.at);
    return (
      firstDate.getFullYear() === secondDate.getFullYear() &&
      firstDate.getMonth() === secondDate.getMonth() &&
      firstDate.getDate() === secondDate.getDate()
    );
  }

  function inferredPriceHistoryTimestamp(history, index) {
    if (!Array.isArray(history) || !history[index]) return null;
    const point = history[index];
    if (Number.isFinite(point.baselineEstimatedAt)) return point.baselineEstimatedAt;
    const uncertainInitialBaseline =
      index === 0 && hasUncertainInitialPriceBaseline(history);
    if (
      !uncertainInitialBaseline &&
      point.baselineUnknown !== true &&
      Number.isFinite(point.at)
    ) {
      return null;
    }
    for (let nextIndex = index + 1; nextIndex < history.length; nextIndex++) {
      if (Number.isFinite(history[nextIndex] && history[nextIndex].at)) {
        return history[nextIndex].at - 24 * 60 * 60 * 1000;
      }
    }
    return null;
  }

  function addEstimatedBaselineDates(cache) {
    const upgraded = { ...(cache && typeof cache === "object" ? cache : {}) };
    let updatedCount = 0;
    for (const [key, record] of Object.entries(upgraded)) {
      const history = record && Array.isArray(record.priceHistory)
        ? record.priceHistory
        : [];
      if (
        history.length < 2 ||
        !history[0] ||
        history[0].baselineDateEstimated === true ||
        !hasUncertainInitialPriceBaseline(history)
      ) {
        continue;
      }
      const estimatedAt = inferredPriceHistoryTimestamp(history, 0);
      if (!Number.isFinite(estimatedAt)) continue;
      const updatedHistory = [...history];
      updatedHistory[0] = {
        ...history[0],
        baselineEstimatedAt: estimatedAt,
        baselineDateEstimated: true,
      };
      upgraded[key] = { ...record, priceHistory: updatedHistory };
      updatedCount++;
    }
    return { cache: upgraded, updatedCount };
  }

  function clearPriceHistories(cache) {
    const cleared = { ...(cache && typeof cache === "object" ? cache : {}) };
    let clearedCount = 0;
    for (const [key, record] of Object.entries(cleared)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (!Object.prototype.hasOwnProperty.call(record, "priceHistory")) continue;
      const updatedRecord = { ...record };
      delete updatedRecord.priceHistory;
      cleared[key] = updatedRecord;
      if (Array.isArray(record.priceHistory) && record.priceHistory.length) {
        clearedCount++;
      }
    }
    return { cache: cleared, clearedCount };
  }

  // ---- הגנה מפני מחירים שפוענחו לא נכון (למשל ₪105,000 במקום ₪2,130,000) ----
  // מחיר דירה למכירה בישראל: 4,000–150,000 ₪ למ״ר. מחוץ לטווח – כמעט תמיד מספר אחר מהעמוד.
  const MIN_PLAUSIBLE_PPSM = 4000;
  const MAX_PLAUSIBLE_PPSM = 150000;
  // שינוי מחיר אמיתי הוא אחוזים בודדים; ירידה של יותר מ־40% או עלייה של יותר מ־60% = חשוד
  const MIN_PRICE_RATIO = 0.6;
  const MAX_PRICE_RATIO = 1.6;
  // מחיר חשוד מתקבל רק אם עמוד המודעה עצמו מראה אותו שוב ושוב
  const SUSPECT_CONFIRMATIONS = 3;

  function plausiblePriceForArea(price, sqm) {
    if (!Number.isFinite(price) || price <= 0) return false;
    if (!Number.isFinite(sqm) || sqm <= 0) return true;
    const ppsm = price / sqm;
    return ppsm >= MIN_PLAUSIBLE_PPSM && ppsm <= MAX_PLAUSIBLE_PPSM;
  }

  function medianPrice(prices) {
    const sorted = [...prices].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // מחיר ייחוס יציב: חציון של עד 5 התצפיות האחרונות (תצפית שגויה בודדת לא מזיזה אותו)
  function referencePrice(previous) {
    const history = (Array.isArray(previous && previous.priceHistory) ? previous.priceHistory : [])
      .map((point) => point && point.price)
      .filter((price) => Number.isFinite(price) && price > 0)
      .slice(-5);
    if (history.length) return medianPrice(history);
    if (Number.isFinite(previous && previous.price) && previous.price > 0) return previous.price;
    return null;
  }

  function isSuspiciousPrice(previous, price, sqm) {
    if (!plausiblePriceForArea(price, sqm)) return true;
    const reference = referencePrice(previous);
    if (!reference) return false;
    const ratio = price / reference;
    return ratio < MIN_PRICE_RATIO || ratio > MAX_PRICE_RATIO;
  }

  // מנקה היסטוריית מחירים מתצפיות שגויות. מחזיר null אם אין מה לשנות.
  function cleanPriceHistory(record) {
    if (!record || record.recordType === "project" || !Array.isArray(record.priceHistory)) return null;
    const original = record.priceHistory;
    let points = original.filter((point) => point && Number.isFinite(point.price) && point.price > 0);
    // 1. מחיר שלא מתאים לשטח (מחיר למ״ר בלתי אפשרי)
    points = points.filter((point) => plausiblePriceForArea(point.price, record.sqm));
    // 2. עם 3 תצפיות ומעלה: מה שרחוק מאוד מהחציון
    if (points.length >= 3) {
      const median = medianPrice(points.map((point) => point.price));
      points = points.filter((point) => point.price / median >= 0.5 && point.price / median <= 2);
    }
    // 3. שתי תצפיות שאחת מהן פחות מרבע מהשנייה – הנמוכה היא כמעט תמיד מספר אחר מהעמוד
    if (points.length === 2) {
      const [a, b] = points;
      if (Math.min(a.price, b.price) / Math.max(a.price, b.price) < 0.25) {
        points = [a.price > b.price ? a : b];
      }
    }
    // 4. איחוד תצפיות רצופות עם אותו מחיר (נשארו אחרי הסרת ה"קפיצה")
    points = points.filter((point, index) => index === 0 || point.price !== points[index - 1].price);
    const removed = original.length - points.length;
    const last = points.length ? points[points.length - 1].price : null;
    const priceWrong =
      Number.isFinite(last) &&
      Number.isFinite(record.price) &&
      record.price !== last &&
      !points.some((point) => point.price === record.price);
    if (!removed && !priceWrong) return null;
    const cleaned = { ...record, priceHistory: points };
    if (priceWrong) cleaned.price = last;
    if (Number.isFinite(cleaned.observedPrice) && !points.some((point) => point.price === cleaned.observedPrice)) {
      cleaned.observedPrice = last;
    }
    if (priceWrong && Number.isFinite(cleaned.sqm) && cleaned.sqm > 0) {
      cleaned.pricePerSqm = Math.round(last / cleaned.sqm);
    }
    return { record: cleaned, removed };
  }

  function cleanPriceOutliers(cache) {
    const cleanedCache = { ...(cache && typeof cache === "object" ? cache : {}) };
    let updatedCount = 0;
    let removedPoints = 0;
    for (const [key, record] of Object.entries(cleanedCache)) {
      const result = cleanPriceHistory(record);
      if (!result) continue;
      cleanedCache[key] = result.record;
      updatedCount++;
      removedPoints += result.removed;
    }
    return { cache: cleanedCache, updatedCount, removedPoints };
  }

  // כרטיס פרויקט בתוצאות החיפוש של מדלן ("החל מ־₪2,290,000") נשמר בעבר כמודעה רגילה.
  // רשומה כזו (קישור ‎/projects/‎) מסומנת כפרויקט: לא נכנסת לרענון ולסטטיסטיקה של מודעות,
  // והיסטוריית "המחיר" שלה (מחיר התחלתי של פרויקט) נמחקת.
  function isMadlanProjectUrl(url) {
    try {
      const parsed = new URL(url);
      return /(^|\.)madlan\.co\.il$/i.test(parsed.hostname) && /^\/projects\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function fixMisfiledProjects(cache) {
    const fixed = { ...(cache && typeof cache === "object" ? cache : {}) };
    let updatedCount = 0;
    for (const [key, record] of Object.entries(fixed)) {
      if (!key.startsWith("madlan:") || !record || record.recordType === "project") continue;
      if (!isMadlanProjectUrl(record.url)) continue;
      const project = { ...record, recordType: "project" };
      delete project.priceHistory;
      delete project.observedPrice;
      delete project.suspectPrice;
      delete project.suspectCount;
      fixed[key] = project;
      updatedCount++;
    }
    return { cache: fixed, updatedCount };
  }

  // מחזיר גם accepted: false כשהמחיר נראה שגוי – אז לא מעדכנים את מחיר המודעה.
  // options.source: "page" (עמוד המודעה) או "search" (כרטיס בתוצאות חיפוש); options.sqm לבדיקת סבירות.
  function recordPriceObservation(previous, price, timestamp = Date.now(), options = {}) {
    const source = options.source === "search" ? "search" : "page";
    if (Number.isFinite(price) && isSuspiciousPrice(previous, price, options.sqm)) {
      const sameSuspect = previous && previous.suspectPrice === price;
      const confirmations = sameSuspect ? (previous.suspectCount || 0) + 1 : 1;
      const confirmedByPage =
        source === "page" &&
        confirmations >= SUSPECT_CONFIRMATIONS &&
        plausiblePriceForArea(price, options.sqm);
      if (!confirmedByPage) {
        return {
          accepted: false,
          observedPrice: Number.isFinite(previous && previous.observedPrice) ? previous.observedPrice : null,
          priceHistory: Array.isArray(previous && previous.priceHistory) ? previous.priceHistory : [],
          // עמוד המודעה שמראה שוב ושוב את אותו מחיר "חשוד" יאושר אחרי 3 פעמים (שינוי מחיר חריג אמיתי)
          suspectPrice: source === "page" ? price : previous && previous.suspectPrice,
          suspectCount: source === "page" ? confirmations : previous && previous.suspectCount,
        };
      }
    }
    const result = recordPriceObservationUnchecked(previous, price, timestamp, source);
    return { accepted: true, ...result, suspectPrice: undefined, suspectCount: undefined };
  }

  function recordPriceObservationUnchecked(previous, price, timestamp, source) {
    if (!Number.isFinite(price)) {
      return {
        observedPrice: Number.isFinite(previous && previous.observedPrice)
          ? previous.observedPrice
          : null,
        priceHistory: Array.isArray(previous && previous.priceHistory)
          ? previous.priceHistory
          : [],
      };
    }

    const storedHistory = Array.isArray(previous && previous.priceHistory)
      ? previous.priceHistory
      : [];
    const history = storedHistory.filter(
      (item) =>
        item &&
        Number.isFinite(item.price) &&
        (Number.isFinite(item.at) || item.baselineUnknown === true)
    );
    const lastPrice = history.length
      ? history[history.length - 1].price
      : Number.isFinite(previous && previous.observedPrice)
        ? previous.observedPrice
        : Number.isFinite(previous && previous.price)
          ? previous.price
          : null;

    const hasUnrecordedPrice = !history.length && Number.isFinite(lastPrice);
    const priceChangedSinceCache = hasUnrecordedPrice && lastPrice !== price;
    if (priceChangedSinceCache) {
      history.push({ price: lastPrice, at: null, baselineUnknown: true });
    }
    if (!history.length || priceChangedSinceCache || lastPrice !== price) {
      history.push({
        price,
        at: timestamp,
        src: source, // מאיפה הגיע המחיר: עמוד המודעה או כרטיס חיפוש (לאבחון תקלות)
        ...(!history.length ? { baselineKnown: true } : {}),
      });
    }

    const boundedHistory = history.slice(-50);
    const historyUnchanged =
      boundedHistory.length === storedHistory.length &&
      boundedHistory.every((item, index) => item === storedHistory[index]);
    return {
      observedPrice: price,
      priceHistory: historyUnchanged ? storedHistory : boundedHistory,
    };
  }

  // היסטוריית מחירים מהאתר עצמו (מדלן: eventsHistory) – מקור אמין יותר מהתצפיות שלנו.
  // התוצאה: נקודות האתר (src: "site") ואחריהן רק תצפיות שלנו מאוחרות מהאירוע האחרון באתר.
  // מחזיר null כשאין מה לשנות.
  function mergeSiteHistory(storedHistory, events) {
    const site = (Array.isArray(events) ? events : [])
      .filter((event) => event && Number.isFinite(event.price) && event.price > 0 && Number.isFinite(event.at))
      .sort((a, b) => a.at - b.at);
    if (!site.length) return null;
    const stored = Array.isArray(storedHistory) ? storedHistory : [];
    const lastSiteAt = site[site.length - 1].at;
    const points = site.map((event, index) => ({
      price: event.price,
      at: event.at,
      src: "site",
      ...(index === 0 ? { baselineKnown: true } : {}),
    }));
    for (const point of stored) {
      if (point && point.src !== "site" && Number.isFinite(point.price) && Number.isFinite(point.at) && point.at > lastSiteAt) {
        points.push(point);
      }
    }
    const merged = points
      .filter((point, index) => index === 0 || point.price !== points[index - 1].price)
      .slice(-50);
    const unchanged =
      merged.length === stored.length &&
      merged.every((point, index) => stored[index] && stored[index].price === point.price && stored[index].at === point.at);
    return unchanged ? null : merged;
  }

  // מחיר קודם שמוצג בכרטיס חיפוש (מחוק, לפני הורדת המחיר האחרונה). כשאין לנו אותו בהיסטוריה
  // הוא נוסף בתחילתה כנקודה בלי תאריך, כך שהירידה נספרת. רק ירידה סבירה (עד 40%),
  // ולא כשההיסטוריה כבר באה מהאתר עצמו. מחזיר את הרשומה (אותו אובייקט אם אין שינוי).
  function withCardPreviousPrice(record, previousPrice, currentPrice) {
    const base = record && typeof record === "object" ? record : {};
    if (!Number.isFinite(previousPrice) || !Number.isFinite(currentPrice)) return base;
    if (!(previousPrice > currentPrice) || currentPrice / previousPrice < MIN_PRICE_RATIO) return base;
    const history = Array.isArray(base.priceHistory) ? base.priceHistory : [];
    if (history.some((point) => point && (point.src === "site" || point.price === previousPrice))) return base;
    return {
      ...base,
      priceHistory: [{ price: previousPrice, at: null, baselineUnknown: true, src: "card" }, ...history],
    };
  }

  function pricePerSqm(record) {
    return Number.isFinite(record && record.price) &&
      Number.isFinite(record && record.sqm) &&
      record.sqm > 0
      ? Math.round(record.price / record.sqm)
      : Number.isFinite(record && record.pricePerSqm)
        ? record.pricePerSqm
        : Number.isFinite(record && record.ppsm)
          ? record.ppsm
          : null;
  }

  function matchesNumericRange(value, min, max) {
    const range =
      typeof value === "number"
        ? { min: value, max: value }
        : value && typeof value === "object"
          ? value
          : null;
    if (!range || !Number.isFinite(range.min)) return false;
    const rangeMax = Number.isFinite(range.max) ? range.max : range.min;
    return (
      (!Number.isFinite(min) || rangeMax >= min) &&
      (!Number.isFinite(max) || range.min <= max)
    );
  }

  // סטטוס אחד לכל מודעה, כמו שמוצג בעמודת "סטטוס מודעה": הוסרה > לא רלוונטית > פעילה/לא נבדקה.
  // כך "פעילה" לא כוללת מודעות לא רלוונטיות. "" = אין סטטוס (פרויקט, או מודעת מדלן רלוונטית).
  function listingStatusKey(site, record, irrelevant) {
    if (!record || record.recordType === "project") return "";
    if (site === "yad2" && record.listingStatus === "removed") return "removed";
    if (irrelevant) return "irrelevant";
    if (site !== "yad2") return "";
    return record.listingStatus === "active" ? "active" : "unchecked";
  }

  function normalizeStatusFilter(status) {
    const list = Array.isArray(status) ? status : status ? [status] : [];
    return list.filter((value) => typeof value === "string" && value);
  }

  function hasListingDeletionFilters(filters) {
    if (!filters || typeof filters !== "object") return false;
    return Boolean(
      (typeof filters.query === "string" && filters.query.trim()) ||
      filters.site ||
      normalizeStatusFilter(filters.status).length ||
      filters.brokerage ||
      filters.railApprox ||
      Object.values(filters.ranges || {}).some(
        (range) => range && (Number.isFinite(range.min) || Number.isFinite(range.max))
      ) ||
      Object.values(filters.amenities || {}).some(Boolean)
    );
  }

  function filterListingsForDeletion(cache, filters) {
    if (!cache || typeof cache !== "object" || !hasListingDeletionFilters(filters)) return [];
    const query = String(filters.query || "").trim().toLocaleLowerCase("he");
    const ranges = filters.ranges || {};
    const amenities = filters.amenities || {};
    return Object.entries(cache).filter(([key, record]) => {
      if (!record || typeof record !== "object" || Array.isArray(record) || record.recordType === "project") {
        return false;
      }
      const separator = key.indexOf(":");
      const site = separator < 0 ? "" : key.slice(0, separator);
      if (filters.site && site !== filters.site) return false;
      const statuses = normalizeStatusFilter(filters.status);
      if (statuses.length) {
        const irrelevant = amenityRelevance(
          record,
          filters.requiredAmenities,
          filters.irrelevantMissingPct,
          filters.dealBreakerAmenities
        ).irrelevant;
        if (!statuses.includes(listingStatusKey(site, record, irrelevant))) return false;
      }

      const priceRange = Number.isFinite(record.price)
        ? {
            min: Math.min(record.price, Number.isFinite(record.maxPrice) ? record.maxPrice : record.price),
            max: Math.max(record.price, Number.isFinite(record.maxPrice) ? record.maxPrice : record.price),
          }
        : null;
      const areaRange = Number.isFinite(record.sqm)
        ? {
            min: Math.min(record.sqm, Number.isFinite(record.maxSqm) ? record.maxSqm : record.sqm),
            max: Math.max(record.sqm, Number.isFinite(record.maxSqm) ? record.maxSqm : record.sqm),
          }
        : null;
      let ppsmRange = pricePerSqm(record);
      if (
        Number.isFinite(record.price) &&
        Number.isFinite(record.maxPrice) &&
        Number.isFinite(record.sqm) &&
        Number.isFinite(record.maxSqm) &&
        record.sqm > 0 &&
        record.maxSqm > 0
      ) {
        ppsmRange = {
          min: Math.min(record.price, record.maxPrice) / Math.max(record.sqm, record.maxSqm),
          max: Math.max(record.price, record.maxPrice) / Math.min(record.sqm, record.maxSqm),
        };
      }
      const numericValues = {
        price: priceRange,
        sqm: areaRange,
        rooms: record.rooms,
        railMeters: record.railMeters,
        pricePerSqm: ppsmRange,
      };
      for (const [field, range] of Object.entries(ranges)) {
        if (!matchesNumericRange(numericValues[field], range.min, range.max)) return false;
      }

      for (const [field, value] of Object.entries(amenities)) {
        if (!value) continue;
        const actual = record.amenities && record.amenities[field];
        if (value === "unknown" ? typeof actual === "boolean" : String(actual) !== value) return false;
      }
      for (const field of ["brokerage", "railApprox"]) {
        const expected = filters[field];
        if (!expected) continue;
        const actual = record[field];
        if (expected === "unknown" ? typeof actual === "boolean" : String(actual) !== expected) {
          return false;
        }
      }

      if (query && !`${key} ${JSON.stringify(record)}`.toLocaleLowerCase("he").includes(query)) {
        return false;
      }
      return true;
    });
  }

  // realDealsDiffPct: כמה אחוז המחיר למ״ר של המודעה מעל (חיובי) או מתחת (שלילי) לחציון עסקאות אמת באזור.
  // כשהוא ידוע, רכיב המחיר (עד 30 נק׳) נקבע לפיו ולא לפי הדירוג בין המודעות השמורות:
  // 20% מתחת לעסקאות ומטה = 30, כמו העסקאות ≈ 13, 15% מעליהן ומעלה = 0.
  function dealScore(record, ppsmRank = 0.5, realDealsDiffPct = null) {
    if (!record || record.recordType === "project") return null;
    const amenities = record.amenities && typeof record.amenities === "object"
      ? Object.values(record.amenities)
      : [];
    const positives = amenities.filter((value) => value === true).length;
    const railBonus =
      Number.isFinite(record.railMeters) && record.railMeters >= 0
        ? Math.max(0, 20 - (record.railMeters / 1000) * 5)
        : 0;
    const brokeragePenalty = record.brokerage === true ? 10 : 0;
    const priceBonus = Number.isFinite(realDealsDiffPct)
      ? Math.max(0, Math.min(1, (15 - realDealsDiffPct) / 35)) * 30
      : Math.max(0, Math.min(1, ppsmRank)) * 30;
    return Math.round(positives * 10 + railBonus + priceBonus - brokeragePenalty);
  }

  // מודעה "לא רלוונטית": חסרים בה (בוודאות, לא "לא ידוע") לפחות missingPct אחוזים מהמאפיינים שהמשתמש סימן כחובה.
  // missingPct = 0 מכבה את הסימון; 1 = מספיק שחסר מאפיין חובה אחד; 100 = כל מאפייני החובה חסרים.
  // dealBreakers: מאפיינים ש"שוברים את העסקה" – אם אחד מהם חסר בוודאות, המודעה לא רלוונטית מיד,
  // בלי קשר לסף האחוזים (גם כשהסף כבוי).
  function amenityRelevance(record, requiredAmenities, missingPct, dealBreakers = []) {
    const breakers = Array.isArray(dealBreakers) ? dealBreakers : [];
    const required = [
      ...new Set([...(Array.isArray(requiredAmenities) ? requiredAmenities : []), ...breakers]),
    ];
    const amenities = record && record.amenities && typeof record.amenities === "object"
      ? record.amenities
      : {};
    const missing = required.filter((amenity) => amenities[amenity] === false);
    const dealBreakerMissing = breakers.filter((amenity) => amenities[amenity] === false);
    const threshold = Math.max(0, Math.min(100, Number(missingPct) || 0));
    const isListing = Boolean(record && record.recordType !== "project");
    const overThreshold =
      threshold > 0 &&
      required.length > 0 &&
      missing.length > 0 &&
      (missing.length / required.length) * 100 >= threshold;
    const irrelevant = isListing && (dealBreakerMissing.length > 0 || overThreshold);
    return { irrelevant, missing, dealBreakerMissing, requiredCount: required.length };
  }

  // מדד לחץ למכור (0–100): כמה זמן המודעה באוויר + כמה ובכמה פעמים המחיר ירד.
  //   ימים באוויר  – עד 60 נק׳ (לינארי, מלא ב־120 יום)
  //   ירידת מחיר   – עד 30 נק׳ (מהמחיר הגבוה שנצפה למחיר הנוכחי, מלא בירידה של 10%)
  //   מספר הורדות  – עד 10 נק׳ (מלא ב־3 הורדות)
  // רמה: גבוה ≥ 60, בינוני ≥ 30, אחרת נמוך. null כשאין גיל וגם אין היסטוריית מחירים.
  const PRESSURE_FULL_AGE_DAYS = 120;
  const PRESSURE_FULL_DROP = 0.1;
  const PRESSURE_FULL_DROPS = 3;
  function sellerPressure(record, now = Date.now()) {
    if (!record || record.recordType === "project") return null;
    let ageDays = Number.isFinite(record.listingAgeDays) ? record.listingAgeDays : null;
    if (ageDays === null && record.listingCreatedAt) {
      const created = Date.parse(record.listingCreatedAt);
      if (Number.isFinite(created)) ageDays = Math.max(0, Math.floor((now - created) / 86400000));
    }
    const prices = (Array.isArray(record.priceHistory) ? record.priceHistory : [])
      .map((point) => point && point.price)
      .filter((price) => Number.isFinite(price) && price > 0);
    if (ageDays === null && prices.length < 2) return null;
    let drops = 0;
    for (let index = 1; index < prices.length; index++) {
      if (prices[index] < prices[index - 1]) drops++;
    }
    const peak = prices.length ? Math.max(...prices) : 0;
    const current = prices.length ? prices[prices.length - 1] : 0;
    const dropPct = peak > 0 && current < peak ? (peak - current) / peak : 0;
    const ageScore = ageDays === null ? 0 : Math.min(ageDays / PRESSURE_FULL_AGE_DAYS, 1) * 60;
    const dropScore = Math.min(dropPct / PRESSURE_FULL_DROP, 1) * 30;
    const countScore = Math.min(drops / PRESSURE_FULL_DROPS, 1) * 10;
    const score = Math.round(ageScore + dropScore + countScore);
    const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
    return { score, level, ageDays, dropPct, drops };
  }

  const PRESSURE_LABELS = { high: "גבוה", medium: "בינוני", low: "נמוך" };

  return {
    cleanPriceHistory,
    cleanPriceOutliers,
    isSuspiciousPrice,
    sellerPressure,
    PRESSURE_LABELS,
    amenityRelevance,
    hasUncertainInitialPriceBaseline,
    inferredPriceHistoryTimestamp,
    addEstimatedBaselineDates,
    clearPriceHistories,
    recordPriceObservation,
    mergeSiteHistory,
    withCardPreviousPrice,
    isMadlanProjectUrl,
    fixMisfiledProjects,
    pricePerSqm,
    matchesNumericRange,
    hasListingDeletionFilters,
    filterListingsForDeletion,
    listingStatusKey,
    normalizeStatusFilter,
    dealScore,
  };
})();

if (typeof module !== "undefined") module.exports = LRCacheData;
