const assert = require("node:assert/strict");
const test = require("node:test");

const CacheData = require("../cache-data.js");

test("price history stores an initial price and each later change once", () => {
  const first = CacheData.recordPriceObservation({}, 2_500_000, 100);
  assert.equal(first.accepted, true);
  assert.equal(first.observedPrice, 2_500_000);
  assert.deepEqual(first.priceHistory, [{ price: 2_500_000, at: 100, src: "page", baselineKnown: true }]);

  const unchanged = CacheData.recordPriceObservation(first, 2_500_000, 200);
  assert.equal(unchanged.priceHistory, first.priceHistory);

  const reduced = CacheData.recordPriceObservation(unchanged, 2_400_000, 300);
  assert.deepEqual(reduced.priceHistory, [
    { price: 2_500_000, at: 100, src: "page", baselineKnown: true },
    { price: 2_400_000, at: 300, src: "page" },
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
    { price: 2_950_000, at: 100, src: "page" },
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

test("uncertain price baselines get an idempotent estimated date without changing their source timestamp", () => {
  const observedAt = Date.UTC(2026, 10, 3, 10);
  const cache = {
    "yad2:listing": {
      title: "מודעה",
      priceHistory: [
        { price: 1_800_000, at: null, baselineUnknown: true },
        { price: 1_999_999, at: observedAt },
      ],
    },
    "madlan:known": {
      priceHistory: [
        { price: 2_000_000, at: observedAt - 86_400_000, baselineKnown: true },
        { price: 2_100_000, at: observedAt },
      ],
    },
    "yad2:undated": {
      priceHistory: [
        { price: 1_500_000, at: null, baselineUnknown: true },
        { price: 1_600_000, at: null, baselineUnknown: true },
      ],
    },
  };

  const result = CacheData.addEstimatedBaselineDates(cache);
  assert.equal(result.updatedCount, 1);
  assert.deepEqual(result.cache["yad2:listing"].priceHistory[0], {
    price: 1_800_000,
    at: null,
    baselineUnknown: true,
    baselineEstimatedAt: observedAt - 86_400_000,
    baselineDateEstimated: true,
  });
  assert.equal(result.cache["yad2:listing"].priceHistory[1].at, observedAt);
  assert.deepEqual(result.cache["madlan:known"], cache["madlan:known"]);
  assert.deepEqual(result.cache["yad2:undated"], cache["yad2:undated"]);

  const repeated = CacheData.addEstimatedBaselineDates(result.cache);
  assert.equal(repeated.updatedCount, 0);
  assert.deepEqual(repeated.cache, result.cache);
});

test("a newly observed current price is recorded even when it returns to an old baseline price", () => {
  const yesterday = Date.UTC(2026, 10, 2, 10);
  const observedAt = Date.UTC(2026, 10, 3, 10);
  const previous = {
    observedPrice: 2_190_000,
    priceHistory: [
      { price: 2_090_000, at: null, baselineUnknown: true },
      { price: 2_190_000, at: yesterday },
    ],
  };

  const result = CacheData.recordPriceObservation(previous, 2_090_000, observedAt);
  assert.deepEqual(result.priceHistory, [
    { price: 2_090_000, at: null, baselineUnknown: true },
    { price: 2_190_000, at: yesterday },
    { price: 2_090_000, at: observedAt, src: "page" },
  ]);
});

test("clearing price histories preserves listing prices and every other cached field", () => {
  const cache = {
    "yad2:listing": {
      price: 2_090_000,
      observedPrice: 2_090_000,
      priceHistory: [
        { price: 2_190_000, at: 100 },
        { price: 2_090_000, at: 200 },
      ],
      title: "מודעת תיווך",
      brokerage: true,
    },
    "madlan:no-history": {
      price: 3_000_000,
      title: "ללא היסטוריה",
    },
  };

  const result = CacheData.clearPriceHistories(cache);
  assert.equal(result.clearedCount, 1);
  assert.deepEqual(result.cache["yad2:listing"], {
    price: 2_090_000,
    observedPrice: 2_090_000,
    title: "מודעת תיווך",
    brokerage: true,
  });
  assert.deepEqual(result.cache["madlan:no-history"], cache["madlan:no-history"]);
  assert.deepEqual(cache["yad2:listing"].priceHistory, [
    { price: 2_190_000, at: 100 },
    { price: 2_090_000, at: 200 },
  ]);
});

test("price history is bounded and ignores invalid observations", () => {
  const previous = {
    price: 2_000_000,
    priceHistory: Array.from({ length: 60 }, (_, index) => ({
      price: 2_100_000 - index * 1000,
      at: index + 1,
    })),
  };
  const result = CacheData.recordPriceObservation(previous, 2_000_000, 1000);
  assert.equal(result.priceHistory.length, 50);
  assert.equal(result.priceHistory.at(-1).price, 2_000_000);

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

test("bulk deletion matches only listings that meet every selected optional filter", () => {
  const cache = {
    "yad2:cheap": {
      title: "דירה למכירה",
      price: 1_800_000,
      sqm: 80,
      rooms: 3,
      railMeters: 500,
      brokerage: false,
      amenities: { secureRoom: false, storage: null },
    },
    "madlan:cheap": {
      title: "דירה בלי ממ״ד",
      price: 1_950_000,
      sqm: 90,
      rooms: 3.5,
      railMeters: 700,
      brokerage: false,
      amenities: { secureRoom: false, storage: true },
    },
    "yad2:unknown": {
      title: "מידע חלקי",
      price: 1_700_000,
      sqm: 75,
      rooms: 3,
      railMeters: 400,
      brokerage: false,
      amenities: { secureRoom: null },
    },
    "yad2:project": {
      recordType: "project",
      title: "פרויקט בלי ממ״ד",
      price: 1_500_000,
      amenities: { secureRoom: false },
    },
  };

  assert.equal(CacheData.hasListingDeletionFilters({}), false);
  assert.deepEqual(CacheData.filterListingsForDeletion(cache, {}), []);
  assert.deepEqual(
    CacheData.filterListingsForDeletion(cache, {
      site: "yad2",
      ranges: { price: { max: 1_900_000 }, railMeters: { max: 600 } },
      amenities: { secureRoom: "false" },
      brokerage: "false",
    }).map(([key]) => key),
    ["yad2:cheap"]
  );
  assert.deepEqual(
    CacheData.filterListingsForDeletion(cache, {
      amenities: { secureRoom: "unknown" },
    }).map(([key]) => key),
    ["yad2:unknown"]
  );
  assert.deepEqual(
    CacheData.filterListingsForDeletion(cache, {
      ranges: { price: { min: 1_850_000, max: 2_000_000 } },
    }).map(([key]) => key),
    ["madlan:cheap"]
  );
});

test("amenityRelevance marks a listing irrelevant at the chosen missing share", () => {
  const required = ["sunBoiler", "storage", "parking", "pool"];
  const record = {
    recordType: "listing",
    amenities: { sunBoiler: false, storage: false, parking: true, pool: null },
  };
  const half = CacheData.amenityRelevance(record, required, 50);
  assert.equal(half.irrelevant, true);
  assert.deepEqual(half.missing, ["sunBoiler", "storage"]);
  assert.equal(CacheData.amenityRelevance(record, required, 75).irrelevant, false);
  assert.equal(CacheData.amenityRelevance(record, required, 1).irrelevant, true);
  assert.equal(CacheData.amenityRelevance(record, required, 0).irrelevant, false);
});

test("amenityRelevance ignores unknown amenities, projects and empty requirements", () => {
  const unknown = { recordType: "listing", amenities: { parking: null } };
  assert.equal(CacheData.amenityRelevance(unknown, ["parking"], 1).irrelevant, false);
  assert.equal(CacheData.amenityRelevance({ recordType: "listing" }, ["parking"], 1).irrelevant, false);
  const project = { recordType: "project", amenities: { parking: false } };
  assert.equal(CacheData.amenityRelevance(project, ["parking"], 1).irrelevant, false);
  const listing = { recordType: "listing", amenities: { parking: false } };
  assert.equal(CacheData.amenityRelevance(listing, [], 1).irrelevant, false);
  assert.equal(CacheData.amenityRelevance(listing, ["parking"], 100).irrelevant, true);
});

test("deletion filter can select irrelevant listings on any site", () => {
  const cache = {
    "yad2:a": { recordType: "listing", amenities: { parking: false } },
    "madlan:b": { recordType: "listing", amenities: { parking: false } },
    "yad2:c": { recordType: "listing", amenities: { parking: true } },
  };
  const matches = CacheData.filterListingsForDeletion(cache, {
    status: "irrelevant",
    requiredAmenities: ["parking"],
    irrelevantMissingPct: 50,
  });
  assert.deepEqual(matches.map(([key]) => key).sort(), ["madlan:b", "yad2:a"]);
});

test("a missing deal-breaker amenity makes a listing irrelevant regardless of the threshold", () => {
  const record = {
    recordType: "listing",
    amenities: { secureRoom: false, parking: true, storage: true, elevator: true },
  };
  const required = ["parking", "storage", "elevator"];
  // ממ״ד הוא דיל ברייקר: חסר → לא רלוונטית, גם כשרק 1 מתוך 4 חסר וגם כשהסף כבוי
  const result = CacheData.amenityRelevance(record, required, 50, ["secureRoom"]);
  assert.equal(result.irrelevant, true);
  assert.deepEqual(result.dealBreakerMissing, ["secureRoom"]);
  assert.equal(result.requiredCount, 4);
  assert.equal(CacheData.amenityRelevance(record, required, 0, ["secureRoom"]).irrelevant, true);
  // ממ״ד לא ידוע → לא נחשב חסר
  const unknown = { recordType: "listing", amenities: { secureRoom: null } };
  assert.equal(CacheData.amenityRelevance(unknown, [], 50, ["secureRoom"]).irrelevant, false);
  // בלי דיל ברייקר: 1 מתוך 4 חסר < 50%
  assert.equal(CacheData.amenityRelevance(record, [...required, "secureRoom"], 50, []).irrelevant, false);
});

test("sellerPressure combines days on market with price drops into a 0-100 score", () => {
  const now = Date.UTC(2026, 10, 7);
  // 60 יום = 30 נק׳; ירידה של 5% מהשיא = 15 נק׳; 2 הורדות = 6.67 נק׳ → 52 → בינוני
  const medium = CacheData.sellerPressure({
    recordType: "listing",
    listingAgeDays: 60,
    priceHistory: [{ price: 2_000_000 }, { price: 1_950_000 }, { price: 1_900_000 }],
  }, now);
  assert.deepEqual(
    { score: medium.score, level: medium.level, drops: medium.drops },
    { score: 52, level: "medium", drops: 2 }
  );
  assert.ok(Math.abs(medium.dropPct - 0.05) < 1e-9);
  // 150 יום (מלא) + ירידה של 12% (מלא) + 3 הורדות (מלא) = 100 → גבוה
  const high = CacheData.sellerPressure({
    recordType: "listing",
    listingCreatedAt: new Date(now - 150 * 86400000).toISOString().slice(0, 10),
    priceHistory: [{ price: 1_000_000 }, { price: 960_000 }, { price: 920_000 }, { price: 880_000 }],
  }, now);
  assert.deepEqual({ score: high.score, level: high.level }, { score: 100, level: "high" });
  // עלייה במחיר אינה לחץ; מודעה חדשה = נמוך
  const fresh = CacheData.sellerPressure({
    recordType: "listing",
    listingAgeDays: 6,
    priceHistory: [{ price: 1_000_000 }, { price: 1_100_000 }],
  }, now);
  assert.deepEqual({ score: fresh.score, level: fresh.level, drops: fresh.drops }, { score: 3, level: "low", drops: 0 });
  // בלי גיל ובלי היסטוריה / פרויקט → אין מדד
  assert.equal(CacheData.sellerPressure({ recordType: "listing" }, now), null);
  assert.equal(CacheData.sellerPressure({ recordType: "project", listingAgeDays: 200 }, now), null);
});

test("a mis-parsed price is not recorded as a price change", () => {
  const previous = {
    price: 2_130_000,
    sqm: 100,
    priceHistory: [{ price: 2_235_000, at: 1 }, { price: 2_130_000, at: 2 }],
  };
  // ₪105,000 ל־100 מ״ר = 1,050 ₪ למ״ר – לא סביר; וגם ירידה של 95%
  const wrong = CacheData.recordPriceObservation(previous, 105_000, 3, { source: "search", sqm: 100 });
  assert.equal(wrong.accepted, false);
  assert.equal(wrong.priceHistory, previous.priceHistory);
  // ירידה רגילה של 4% מתקבלת
  const real = CacheData.recordPriceObservation(previous, 2_050_000, 3, { source: "page", sqm: 100 });
  assert.equal(real.accepted, true);
  assert.deepEqual(real.priceHistory.at(-1), { price: 2_050_000, at: 3, src: "page" });
});

test("a large real price change is accepted after the listing page confirms it three times", () => {
  let record = { price: 2_000_000, sqm: 100, priceHistory: [{ price: 2_000_000, at: 1 }] };
  const results = [];
  for (let visit = 0; visit < 3; visit++) {
    const result = CacheData.recordPriceObservation(record, 1_100_000, 10 + visit, { source: "page", sqm: 100 });
    results.push(result.accepted);
    record = { ...record, ...result };
  }
  assert.deepEqual(results, [false, false, true]);
  assert.equal(record.priceHistory.at(-1).price, 1_100_000);
  // כרטיס חיפוש לבד לעולם לא מאשר מחיר חשוד
  let fromSearch = { price: 2_000_000, sqm: 100, priceHistory: [{ price: 2_000_000, at: 1 }] };
  for (let visit = 0; visit < 5; visit++) {
    fromSearch = { ...fromSearch, ...CacheData.recordPriceObservation(fromSearch, 1_100_000, 10 + visit, { source: "search", sqm: 100 }) };
  }
  assert.equal(fromSearch.priceHistory.length, 1);
});

test("cleanPriceOutliers removes spikes and restores a wrong current price", () => {
  const cache = {
    // ירד ל־105,000 ועלה בחזרה – הקפיצה נמחקת ושתי התצפיות של 2,130,000 מתאחדות
    "yad2:spike": {
      recordType: "listing", price: 2_130_000, sqm: 90,
      priceHistory: [
        { price: 2_235_000, at: 1 }, { price: 2_130_000, at: 2 }, { price: 105_000, at: 3 }, { price: 2_130_000, at: 4 },
      ],
    },
    // המחיר הנוכחי עצמו שגוי (96,102) – חוזר ל־2,500,000
    "yad2:wrong-current": {
      recordType: "listing", price: 96_102, observedPrice: 96_102,
      priceHistory: [{ price: 2_500_000, at: 1 }, { price: 96_102, at: 2 }],
    },
    "yad2:fine": { recordType: "listing", price: 2_000_000, priceHistory: [{ price: 2_100_000, at: 1 }, { price: 2_000_000, at: 2 }] },
  };
  const result = CacheData.cleanPriceOutliers(cache);
  assert.equal(result.updatedCount, 2);
  assert.deepEqual(result.cache["yad2:spike"].priceHistory.map((p) => p.price), [2_235_000, 2_130_000]);
  assert.equal(result.cache["yad2:wrong-current"].price, 2_500_000);
  assert.equal(result.cache["yad2:wrong-current"].observedPrice, 2_500_000);
  assert.deepEqual(result.cache["yad2:wrong-current"].priceHistory.map((p) => p.price), [2_500_000]);
  assert.equal(result.cache["yad2:fine"], cache["yad2:fine"]);
  assert.equal(CacheData.cleanPriceOutliers(result.cache).updatedCount, 0, "cleaning is idempotent");
});
