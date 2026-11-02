const assert = require("node:assert/strict");
const test = require("node:test");

const CacheData = require("../cache-data.js");

test("price history stores an initial price and each later change once", () => {
  const first = CacheData.recordPriceObservation({}, 2_500_000, 100);
  assert.deepEqual(first, {
    observedPrice: 2_500_000,
    priceHistory: [{ price: 2_500_000, at: 100, baselineKnown: true }],
  });

  const unchanged = CacheData.recordPriceObservation(first, 2_500_000, 200);
  assert.equal(unchanged.priceHistory, first.priceHistory);

  const reduced = CacheData.recordPriceObservation(unchanged, 2_400_000, 300);
  assert.deepEqual(reduced.priceHistory, [
    { price: 2_500_000, at: 100, baselineKnown: true },
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
    { price: 3_000_000, at: null, baselineUnknown: true },
    { price: 2_950_000, at: 100 },
  ]);
  assert.equal(CacheData.hasUncertainInitialPriceBaseline(result.priceHistory), true);

  const laterReduction = CacheData.recordPriceObservation(
    result,
    2_900_000,
    200
  );
  assert.equal(laterReduction.priceHistory.length, 3);
  assert.deepEqual(laterReduction.priceHistory[0], {
    price: 3_000_000,
    at: null,
    baselineUnknown: true,
  });
});

test("legacy same-day bootstrap history is not treated as a dated price change", () => {
  const timestamp = Date.UTC(2026, 10, 2, 10);
  const oldHistory = [
    { price: 2_680_000, at: timestamp - 60_000 },
    { price: 2_850_000, at: timestamp },
  ];
  assert.equal(CacheData.hasUncertainInitialPriceBaseline(oldHistory), true);
  assert.equal(
    CacheData.hasUncertainInitialPriceBaseline([
      { price: 2_680_000, at: timestamp, baselineKnown: true },
      { price: 2_850_000, at: timestamp + 60_000 },
    ]),
    false
  );
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

test("numeric filters support ranges and match overlapping project price or area ranges", () => {
  assert.equal(CacheData.matchesNumericRange(2_500_000, 2_000_000, 3_000_000), true);
  assert.equal(CacheData.matchesNumericRange(2_500_000, 2_600_000, null), false);
  assert.equal(
    CacheData.matchesNumericRange({ min: 2_000_000, max: 2_800_000 }, 2_500_000, 3_000_000),
    true
  );
  assert.equal(
    CacheData.matchesNumericRange({ min: 1_000_000, max: 2_200_000 }, 2_500_000, null),
    false
  );
  assert.equal(CacheData.matchesNumericRange(null, null, 3_000_000), false);
});
