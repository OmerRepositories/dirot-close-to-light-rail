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
    // כרטיס חיפוש שמראה מחיר אחר מהשמור: נרשם רק אחרי שאותו מחיר נראה שוב בכרטיס (אחרי 20 דקות לפחות,
    // בלי מחיר אחר באמצע). כרטיסים מתחלפים בגלילה, ותצפית בודדת הייתה לפעמים המחיר של מודעה אחרת.
    // עמוד המודעה עצמו מתקבל מיד.
    let confirmed = false;
    if (source === "search" && Number.isFinite(price)) {
      const last = lastKnownPrice(previous);
      // המחיר הקודם המחוק באותו כרטיס (src: "card") הוא מהאתר עצמו – המחיר החדש לצידו אמין
      const storedHistory = Array.isArray(previous && previous.priceHistory) ? previous.priceHistory : [];
      const vouchedByCard = storedHistory.length > 0 && storedHistory[storedHistory.length - 1].src === "card";
      if (Number.isFinite(last) && last !== price && !vouchedByCard) {
        const samePending = previous && previous.searchPendingPrice === price && Number.isFinite(previous.searchPendingAt);
        if (!samePending || timestamp - previous.searchPendingAt < SEARCH_CONFIRM_MS) {
          return {
            accepted: false,
            observedPrice: Number.isFinite(previous && previous.observedPrice) ? previous.observedPrice : null,
            priceHistory: Array.isArray(previous && previous.priceHistory) ? previous.priceHistory : [],
            suspectPrice: previous && previous.suspectPrice,
            suspectCount: previous && previous.suspectCount,
            searchPendingPrice: price,
            searchPendingAt: samePending ? previous.searchPendingAt : timestamp,
          };
        }
        confirmed = true;
      }
    }
    const result = recordPriceObservationUnchecked(previous, price, timestamp, source, confirmed);
    return {
      accepted: true,
      ...result,
      suspectPrice: undefined,
      suspectCount: undefined,
      searchPendingPrice: undefined,
      searchPendingAt: undefined,
    };
  }

  const SEARCH_CONFIRM_MS = 20 * 60 * 1000;
  function lastKnownPrice(previous) {
    const history = Array.isArray(previous && previous.priceHistory)
      ? previous.priceHistory.filter((item) => item && Number.isFinite(item.price))
      : [];
    if (history.length) return history[history.length - 1].price;
    if (Number.isFinite(previous && previous.observedPrice)) return previous.observedPrice;
    return Number.isFinite(previous && previous.price) ? previous.price : null;
  }

  function recordPriceObservationUnchecked(previous, price, timestamp, source, confirmed = false) {
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
        ...(confirmed ? { confirmed: true } : {}),
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

  // האתרים שהתוסף שומר מהם מודעות (מפתח במטמון: "<אתר>:<מזהה>") ושמם להצגה
  const LISTING_SITES = ["yad2", "madlan", "homeless", "komo"];
  const SITE_LABELS = { yad2: "יד2", madlan: "מדלן", homeless: "הומלס", komo: "קומו", facebook: "פייסבוק" };
  const siteLabel = (site) => SITE_LABELS[site] || site || "";

  // סטטוס אחד לכל מודעה, כמו שמוצג בעמודת "סטטוס מודעה": הוסרה > לא רלוונטית > פעילה/לא נבדקה.
  // כך "פעילה" לא כוללת מודעות לא רלוונטיות. "" = אין סטטוס (פרויקט, או מודעת מדלן רלוונטית).
  function listingStatusKey(site, record, irrelevant) {
    if (!record || record.recordType === "project") return "";
    const checkable = LISTING_SITES.includes(site);
    if (checkable && record.listingStatus === "removed") return "removed";
    // פוסט פייסבוק שבפענוח מחדש התברר שהוא לא דירה (בניין שלם, "נמכר", חוג...)
    if (irrelevant || record.facebookNotListing) return "irrelevant";
    if (!checkable) return "";
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
        // קומה (קרקע = 0). מודעה בלי קומה ידועה לא עוברת סינון קומה – כלומר לא תימחק בגללו
        floor: record.floor,
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
  // "משחק מחירים": מוכרים מורידים מחיר ומחזירים אותו כדי לקפוץ למעלה בתוצאות. מחיר B שהופיע בין שני
  // מחירים זהים A → B → A והחזיק עד maxDays ימים הוא לא שינוי אמיתי – B והחזרה ל-A מוסרים.
  // ההיסטוריה השמורה לא משתנה; זה רק לניתוח ולתצוגה. חוזר עד שאין עוד קפיצות כאלה.
  const PRICE_BOUNCE_MAX_DAYS = 14;
  // "רעש" מכרטיסי חיפוש: מחיר מכרטיס שעמוד המודעה (או האתר עצמו) סותר בתוך יומיים, או שהתחלף שוב
  // בתוך יומיים, הוא לא שינוי מחיר אמיתי. כך נראו למשל 2.77 → 3.15 → 2.75 → 2.94 תוך דקות, כשעמוד
  // המודעה הראה כל הזמן 2.77. תצפית חיפוש שאושרה פעמיים (confirmed) לא נחשבת רעש.
  const SEARCH_NOISE_MS = 2 * 86400000;
  function withoutSearchNoise(points) {
    const trusted = points.filter((point) => point.src !== "search" && Number.isFinite(point.at));
    let removed = 0;
    const kept = points.filter((point, index) => {
      if (point.src !== "search" || point.confirmed || !Number.isFinite(point.at)) return true;
      const contradictedByPage = trusted.some(
        (other) => other.price !== point.price && Math.abs(other.at - point.at) <= SEARCH_NOISE_MS
      );
      const next = points[index + 1];
      const flippedQuickly = Boolean(
        next && Number.isFinite(next.at) && next.price !== point.price && next.at - point.at <= SEARCH_NOISE_MS
      );
      if (contradictedByPage || flippedQuickly) {
        removed++;
        return false;
      }
      return true;
    });
    // אחרי ההסרה: אותו מחיר פעמיים ברצף = לא שינוי
    const merged = kept.filter((point, index) => index === 0 || point.price !== kept[index - 1].price);
    return { points: merged, removed };
  }

  function withoutPriceBounces(history, maxDays = PRICE_BOUNCE_MAX_DAYS) {
    const finite = Array.isArray(history) ? history.filter((point) => point && Number.isFinite(point.price)) : [];
    const noise = withoutSearchNoise(finite);
    let points = noise.points;
    let removed = noise.removed;
    for (let changed = true; changed;) {
      changed = false;
      for (let index = 1; index + 1 < points.length; index++) {
        const before = points[index - 1];
        const bounce = points[index];
        const after = points[index + 1];
        if (
          before.price === after.price &&
          bounce.price !== before.price &&
          Number.isFinite(bounce.at) &&
          Number.isFinite(after.at) &&
          after.at - bounce.at <= maxDays * 86400000
        ) {
          points = [...points.slice(0, index), ...points.slice(index + 2)];
          removed++;
          changed = true;
          break;
        }
      }
    }
    return { history: points, removed };
  }

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
    // הורדה זמנית שחזרה למחיר הקודם לא נספרת כהורדה ולא כירידה מהשיא
    const prices = withoutPriceBounces(record.priceHistory).history
      .map((point) => point.price)
      .filter((price) => price > 0);
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

  // ---- אותה דירה ביד2 ובמדלן ("תאומה"): לקישור בין שתי המודעות. שתיהן ממשיכות להתרענן בנפרד.
  const TWIN_SITES = ["yad2", "madlan"];
  const TWIN_MAX_METERS = 40;

  function normalizePlace(text) {
    return String(text || "")
      .replace(/^\s*(?:רחוב|רח['׳]?)\s+/, "")
      .replace(/[^0-9א-תa-z]/gi, "")
      .replace(/וו/g, "ו")
      .replace(/יי/g, "י")
      .toLowerCase();
  }

  // "המשי 15, גני תקווה" → { street: "המשי", house: "15", city: "גני תקווה" }
  function twinAddress(record) {
    const parts = String(record.address || "").split(",").map((part) => part.trim()).filter(Boolean);
    const match = (parts[0] || "").match(/^(.*?\S)\s+(\d{1,4})\s*[א-ת]?$/);
    const city = normalizePlace(record.city || parts[parts.length - 1] || "");
    if (!match || !city) return null;
    const street = normalizePlace(match[1]);
    return street ? `${city}|${street}|${match[2]}` : null;
  }

  function metersBetween(a, b) {
    const rad = Math.PI / 180;
    const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    const y = (b.lat - a.lat) * rad;
    return Math.sqrt(x * x + y * y) * 6371000;
  }

  // ציון התאמה, או null כשמשהו לא מתאים. אותה קומה חובה, ועוד לפחות אחד מחדרים / שטח ידוע בשתיהן.
  function twinScore(a, b) {
    let known = 0;
    if (Number.isFinite(a.rooms) && Number.isFinite(b.rooms)) {
      if (a.rooms !== b.rooms) return null;
      known++;
    }
    // קומה חובה: בלעדיה דירות זהות בקומות שונות של אותו בניין היו מקושרות בטעות
    if (!Number.isFinite(a.floor) || !Number.isFinite(b.floor) || a.floor !== b.floor) return null;
    let sqmGap = 0;
    if (a.sqm > 0 && b.sqm > 0) {
      sqmGap = Math.abs(a.sqm - b.sqm);
      if (sqmGap > Math.max(6, Math.max(a.sqm, b.sqm) * 0.08)) return null;
      known++;
    }
    return known >= 1 ? known * 100 - sqmGap : null;
  }

  // מחזיר Map: מפתח מודעה → מפתח המודעה התאומה באתר השני. רק התאמה חד־משמעית בשני הכיוונים.
  function findTwins(cache) {
    const listings = [];
    for (const [key, record] of Object.entries(cache && typeof cache === "object" ? cache : {})) {
      if (!record || typeof record !== "object" || record.recordType === "project") continue;
      const site = key.slice(0, key.indexOf(":"));
      if (!TWIN_SITES.includes(site)) continue;
      const coords = record.coordinates;
      listings.push({
        key, site, record,
        address: twinAddress(record),
        coords: coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon) && !record.railApprox ? coords : null,
      });
    }
    const byAddress = new Map();
    const byCell = new Map();
    const cellOf = (coords, dLat = 0, dLon = 0) => `${Math.floor(coords.lat / 0.0005) + dLat}|${Math.floor(coords.lon / 0.0005) + dLon}`;
    for (const item of listings) {
      if (item.site !== "madlan") continue;
      if (item.address) {
        if (!byAddress.has(item.address)) byAddress.set(item.address, []);
        byAddress.get(item.address).push(item);
      }
      if (item.coords) {
        const cell = cellOf(item.coords);
        if (!byCell.has(cell)) byCell.set(cell, []);
        byCell.get(cell).push(item);
      }
    }
    // לכל מודעת יד2: המועמדת הטובה ביותר במדלן (באותה כתובת, או במרחק של עד 40 מ׳)
    const best = (item) => {
      const candidates = new Set(item.address ? byAddress.get(item.address) || [] : []);
      if (item.coords) {
        for (let dLat = -1; dLat <= 1; dLat++) {
          for (let dLon = -1; dLon <= 1; dLon++) {
            for (const other of byCell.get(cellOf(item.coords, dLat, dLon)) || []) {
              if (other.coords && metersBetween(item.coords, other.coords) <= TWIN_MAX_METERS) candidates.add(other);
            }
          }
        }
      }
      let top = null;
      let topScore = -Infinity;
      let tie = false;
      for (const other of candidates) {
        const score = twinScore(item.record, other.record);
        if (score === null) continue;
        if (score > topScore) {
          top = other;
          topScore = score;
          tie = false;
        } else if (score === topScore) {
          tie = true;
        }
      }
      return tie ? null : top;
    };
    const pairs = new Map();
    const claimed = new Map();
    for (const item of listings) {
      if (item.site !== "yad2") continue;
      const other = best(item);
      if (!other) continue;
      // שתי מודעות יד2 שמצביעות על אותה מודעת מדלן: לא מקשרים אף אחת (לא ברור מי התאומה)
      if (claimed.has(other.key)) {
        pairs.delete(claimed.get(other.key));
        claimed.set(other.key, null);
        continue;
      }
      claimed.set(other.key, item.key);
      pairs.set(item.key, other.key);
    }
    const twins = new Map();
    for (const [yad2Key, madlanKey] of pairs) {
      twins.set(yad2Key, madlanKey);
      twins.set(madlanKey, yad2Key);
    }
    return twins;
  }

  function findTwin(cache, key) {
    return findTwins(cache).get(key) || null;
  }

  // ---------- מס רכישה (מדרגות, ניתן לעריכה בהגדרות) ----------
  // פטור עד purchaseTaxExemptUpTo; מעליו כל מדרגה ממוסה בשיעור שלה על החלק שבתוכה.
  // upTo: null במדרגה האחרונה = "ומעלה". ברירת מחדל: דירה יחידה, נכון לנובמבר 2026 (לפי הנתונים שהמשתמש הזין).
  const DEFAULT_PURCHASE_TAX = Object.freeze({
    exemptUpTo: 1978745,
    brackets: Object.freeze([
      Object.freeze({ upTo: 2347040, rate: 3.5 }),
      Object.freeze({ upTo: 6055070, rate: 5 }),
      Object.freeze({ upTo: 20183565, rate: 8 }),
      Object.freeze({ upTo: null, rate: 10 }),
    ]),
  });

  function normalizePurchaseTax(exemptUpTo, brackets) {
    const exempt = Number(exemptUpTo);
    const list = Array.isArray(brackets) ? brackets : null;
    if (!(exempt >= 0) || !list || !list.length) {
      return { exemptUpTo: DEFAULT_PURCHASE_TAX.exemptUpTo, brackets: DEFAULT_PURCHASE_TAX.brackets.map((b) => ({ ...b })) };
    }
    const clean = list
      .map((bracket) => ({
        upTo: bracket && bracket.upTo !== null && bracket.upTo !== "" && Number(bracket.upTo) > 0 ? Number(bracket.upTo) : null,
        rate: Math.max(0, Math.min(100, Number(bracket && bracket.rate) || 0)),
      }));
    // מדרגות עם גבול – לפי הסדר, רק גבולות שעולים; המדרגה הפתוחה ("ומעלה") תמיד אחרונה
    const bounded = clean.filter((bracket) => bracket.upTo !== null).sort((a, b) => a.upTo - b.upTo)
      .filter((bracket, index, all) => bracket.upTo > exempt && (index === 0 || bracket.upTo > all[index - 1].upTo));
    const open = clean.find((bracket) => bracket.upTo === null);
    return { exemptUpTo: exempt, brackets: [...bounded, { upTo: null, rate: open ? open.rate : (bounded.length ? bounded[bounded.length - 1].rate : 0) }] };
  }

  // מסלולי מס לפי סוג הרוכש (לפי חוק מיסוי מקרקעין, המדרגות מוקפאות עד 15.1.2028). כולם ניתנים לעריכה.
  // flatAbove: מעל הסכום הזה המס מחושב בשיעור אחד מהשקל הראשון (תקנה 11: מעל 2.5 מיליון – 0.5% על כל השווי)
  const PURCHASE_TAX_TRACKS = Object.freeze({
    single: { label: "דירה יחידה (כולל משפרי דיור)", exemptUpTo: 1978745, brackets: DEFAULT_PURCHASE_TAX.brackets, flatAbove: null },
    additional: {
      label: "דירה נוספת / משקיע",
      exemptUpTo: 0,
      brackets: [{ upTo: 6055070, rate: 8 }, { upTo: null, rate: 10 }],
      flatAbove: null,
    },
    oleh: {
      label: "עולה חדש (תקנה 12א)",
      exemptUpTo: 1978745,
      brackets: [{ upTo: 6055070, rate: 0.5 }, { upTo: 20183565, rate: 8 }, { upTo: null, rate: 10 }],
      flatAbove: null,
    },
    disabled: {
      label: "נכה / עיוור / נפגע איבה / משפחה שכולה (תקנה 11)",
      exemptUpTo: 1978745,
      brackets: [{ upTo: null, rate: 0.5 }],
      flatAbove: { threshold: 2500000, rate: 0.5 },
    },
  });
  const PURCHASE_TAX_TRACK_KEYS = Object.keys(PURCHASE_TAX_TRACKS);

  function cloneTrack(track) {
    return {
      label: track.label,
      exemptUpTo: track.exemptUpTo,
      brackets: track.brackets.map((bracket) => ({ ...bracket })),
      flatAbove: track.flatAbove ? { ...track.flatAbove } : null,
    };
  }

  function normalizeFlatAbove(flat) {
    const threshold = Number(flat && flat.threshold);
    const rate = Number(flat && flat.rate);
    return threshold > 0 && rate >= 0 ? { threshold, rate: Math.min(100, rate) } : null;
  }

  // כל המסלולים מתוך ההגדרות השמורות; מה שחסר – ברירת מחדל. גרסה 1.31.0 שמרה רק את "דירה יחידה"
  // (purchaseTaxExemptUpTo / purchaseTaxBrackets) – הערכים האלה ממשיכים לשמש למסלול הזה.
  function purchaseTaxTracksFrom(settings = {}) {
    const saved = settings.purchaseTaxTracks && typeof settings.purchaseTaxTracks === "object" ? settings.purchaseTaxTracks : {};
    const tracks = {};
    for (const key of PURCHASE_TAX_TRACK_KEYS) {
      const base = cloneTrack(PURCHASE_TAX_TRACKS[key]);
      let source = saved[key];
      if (!source && key === "single" && Array.isArray(settings.purchaseTaxBrackets)) {
        source = { exemptUpTo: settings.purchaseTaxExemptUpTo, brackets: settings.purchaseTaxBrackets };
      }
      if (source && typeof source === "object") {
        const tax = normalizePurchaseTax(source.exemptUpTo, source.brackets);
        tracks[key] = { label: base.label, ...tax, flatAbove: normalizeFlatAbove(source.flatAbove) };
      } else {
        tracks[key] = base;
      }
    }
    return tracks;
  }

  // המסלול הנבחר בהגדרות, מוכן לחישוב
  function purchaseTaxSettingsFrom(settings = {}) {
    const tracks = purchaseTaxTracksFrom(settings);
    const key = PURCHASE_TAX_TRACK_KEYS.includes(settings.purchaseTaxTrack) ? settings.purchaseTaxTrack : "single";
    return { track: key, ...tracks[key] };
  }

  // { tax, total, effectivePct, parts: [{ from, to, rate, tax }] } או null כשאין מחיר
  function purchaseTax(price, settings = DEFAULT_PURCHASE_TAX) {
    const value = Number(price);
    if (!(value > 0)) return null;
    const flat = normalizeFlatAbove(settings.flatAbove);
    if (flat && value > flat.threshold) {
      const flatTax = Math.round((value * flat.rate) / 100);
      return {
        tax: flatTax,
        total: value + flatTax,
        effectivePct: Math.round((flatTax / value) * 1000) / 10,
        parts: [{ from: 0, to: value, rate: flat.rate, tax: flatTax }],
      };
    }
    const { exemptUpTo, brackets } = normalizePurchaseTax(settings.exemptUpTo, settings.brackets);
    let from = exemptUpTo;
    let tax = 0;
    const parts = [];
    for (const bracket of brackets) {
      if (value <= from) break;
      const to = bracket.upTo === null ? value : Math.min(value, bracket.upTo);
      const part = ((to - from) * bracket.rate) / 100;
      if (to > from) parts.push({ from, to, rate: bracket.rate, tax: Math.round(part) });
      tax += part;
      if (bracket.upTo === null) break;
      from = bracket.upTo;
    }
    tax = Math.round(tax);
    return { tax, total: value + tax, effectivePct: Math.round((tax / value) * 1000) / 10, parts };
  }

  return {
    DEFAULT_PURCHASE_TAX,
    PURCHASE_TAX_TRACKS,
    PURCHASE_TAX_TRACK_KEYS,
    normalizePurchaseTax,
    purchaseTaxTracksFrom,
    purchaseTaxSettingsFrom,
    purchaseTax,
    findTwins,
    findTwin,
    cleanPriceHistory,
    cleanPriceOutliers,
    isSuspiciousPrice,
    sellerPressure,
    withoutPriceBounces,
    PRICE_BOUNCE_MAX_DAYS,
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
    LISTING_SITES,
    SITE_LABELS,
    siteLabel,
    normalizeStatusFilter,
    dealScore,
  };
})();

if (typeof module !== "undefined") module.exports = LRCacheData;
