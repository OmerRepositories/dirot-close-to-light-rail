var LRCacheData = (() => {
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
        Number.isFinite(item.at)
    );
    const lastPrice = history.length
      ? history[history.length - 1].price
      : Number.isFinite(previous && previous.observedPrice)
        ? previous.observedPrice
        : Number.isFinite(previous && previous.price)
          ? previous.price
          : null;

    if (!history.length && Number.isFinite(lastPrice)) {
      history.push({
        price: lastPrice,
        at: Number.isFinite(previous.updatedAt) ? previous.updatedAt : timestamp,
      });
    }
    if (!history.length || lastPrice !== price) {
      history.push({ price, at: timestamp });
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

  return { recordPriceObservation, pricePerSqm, dealScore };
})();

if (typeof module !== "undefined") module.exports = LRCacheData;
