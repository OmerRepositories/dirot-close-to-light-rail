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

  function recordPriceObservation(previous, price, timestamp = Date.now()) {
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

  function dealScore(record, ppsmRank = 0.5) {
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
    const priceBonus = Math.max(0, Math.min(1, ppsmRank)) * 30;
    return Math.round(positives * 10 + railBonus + priceBonus - brokeragePenalty);
  }

  return {
    hasUncertainInitialPriceBaseline,
    inferredPriceHistoryTimestamp,
    addEstimatedBaselineDates,
    clearPriceHistories,
    recordPriceObservation,
    pricePerSqm,
    matchesNumericRange,
    dealScore,
  };
})();

if (typeof module !== "undefined") module.exports = LRCacheData;
