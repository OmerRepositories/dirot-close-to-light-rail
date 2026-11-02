const assert = require("node:assert/strict");
const test = require("node:test");

const CacheData = require("../cache-data.js");

test("price history stores an initial price and each later change once", () => {
  const first = CacheData.recordPriceObservation({}, 2_500_000, 100);
  assert.deepEqual(first, {
    observedPrice: 2_500_000,
    priceHistory: [{ price: 2_500_000, at: 100 }],
  });

  const unchanged = CacheData.recordPriceObservation(first, 2_500_000, 200);
  assert.equal(unchanged.priceHistory, first.priceHistory);

  const reduced = CacheData.recordPriceObservation(unchanged, 2_400_000, 300);
  assert.deepEqual(reduced.priceHistory, [
    { price: 2_500_000, at: 100 },
    { price: 2_400_000, at: 300 },
  ]);
});

test("price history uses a prior saved price as its baseline", () => {
  const result = CacheData.recordPriceObservation(
    { price: 3_000_000, updatedAt: 50 },
    2_950_000,
    100
  );
  assert.deepEqual(result.priceHistory, [
    { price: 3_000_000, at: 50 },
    { price: 2_950_000, at: 100 },
  ]);
});

test("price history is bounded and ignores invalid observations", () => {
  const previous = {
    price: 100,
    priceHistory: Array.from({ length: 60 }, (_, index) => ({
      price: 200 - index,
      at: index + 1,
    })),
  };
  const result = CacheData.recordPriceObservation(previous, 100, 1000);
  assert.equal(result.priceHistory.length, 50);
  assert.equal(result.priceHistory.at(-1).price, 100);

  const invalid = CacheData.recordPriceObservation(previous, null, 1000);
  assert.equal(invalid.observedPrice, null);
  assert.equal(invalid.priceHistory, previous.priceHistory);
});

test("price per square meter is derived and listing value score rewards value and amenities", () => {
  const lowPrice = {
    price: 2_000_000,
    sqm: 100,
    railMeters: 400,
    amenities: { secureRoom: true, parking: true, balcony: false },
  };
  const highPrice = {
    ...lowPrice,
    price: 3_000_000,
    railMeters: 1200,
    brokerage: true,
  };

  assert.equal(CacheData.pricePerSqm(lowPrice), 20_000);
  assert.ok(CacheData.dealScore(lowPrice, 1) > CacheData.dealScore(highPrice, 0));
  assert.equal(CacheData.pricePerSqm({ price: 100, sqm: 0 }), null);
  assert.equal(CacheData.dealScore({ recordType: "project" }), null);
});
