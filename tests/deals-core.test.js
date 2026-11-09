const assert = require("node:assert/strict");
const test = require("node:test");

const Deals = require("../deals-core.js");

// מבנים כפי שנראו באתרים (נבדק 2026-11-09)
const yad2Result = {
  address: {
    addressMasterId: 5828588,
    city: { text: "פתח תקווה" },
    houseNumber: 2,
    neighborhood: { text: "עין גנים" },
    street: { text: "אמיר בנימיני" },
  },
  buildYear: 1970,
  buildingMR: 85,
  floor: 2,
  numberOfFloors: 3,
  price: 2025000,
  propertyType: "דירה בבית קומות",
  rooms: 4,
  saleDate: "2025-04-08T00:00:00.000Z",
};
const madlanRow = {
  action: "sale",
  address: "בנימיני אמיר 2",
  beds: 4,
  date: "2025-04-08T00:00:00Z",
  floor: 2,
  id: "sold_1",
  isFinal: true,
  price: 2025000,
  size: 84,
  totalFloors: null,
  year: 1970,
  seller: "פרטי",
  buyer: "פרטי",
};

test("the same deal from Yad2 and Madlan gets one key", () => {
  const fromYad2 = Deals.fromYad2(yad2Result);
  const fromMadlan = Deals.fromMadlan(madlanRow, "פתח תקווה");
  assert.ok(fromYad2 && fromMadlan);
  assert.equal(fromYad2.key, fromMadlan.key);
  assert.equal(fromYad2.key, "פתח תקווה|אמיר בנימיני|2|2025-04-08|2025000");
});

test("the key ignores punctuation, street prefixes and word order but not price, date or house", () => {
  const base = { city: "תל אביב - יפו", street: "רחוב בן-גוריון", house: "12", date: "2024-01-02T00:00:00Z", price: 3000000 };
  assert.equal(Deals.dealKey(base), Deals.dealKey({ ...base, city: "תל אביב יפו", street: "גוריון בן" }));
  assert.notEqual(Deals.dealKey(base), Deals.dealKey({ ...base, price: 3000001 }));
  assert.notEqual(Deals.dealKey(base), Deals.dealKey({ ...base, date: "2024-01-03" }));
  assert.notEqual(Deals.dealKey(base), Deals.dealKey({ ...base, house: "14" }));
  assert.equal(Deals.dealKey({ ...base, house: "" }), null);
  assert.equal(Deals.dealKey({ ...base, price: 0 }), null);
});

test("Madlan rows: only final sales, never seller or buyer, the listing itself is skipped", () => {
  assert.equal(Deals.fromMadlan({ ...madlanRow, action: "listed" }, "פתח תקווה"), null);
  assert.equal(Deals.fromMadlan({ ...madlanRow, isFinal: false }, "פתח תקווה"), null);
  const { deal } = Deals.fromMadlan(madlanRow, "פתח תקווה");
  assert.equal("seller" in deal || "buyer" in deal, false);
  assert.equal(deal.sqm, 84);
  assert.deepEqual(deal.sources, ["madlan"]);
});

test("merging keeps one record, unions sources and fills only missing fields", () => {
  const now = 1000;
  const first = Deals.mergeAll({}, [Deals.fromMadlan(madlanRow, "פתח תקווה")], now);
  assert.equal(first.added, 1);
  const second = Deals.mergeAll(first.store, [Deals.fromYad2(yad2Result)], now + 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  const [deal] = Object.values(second.store);
  assert.deepEqual(deal.sources, ["madlan", "yad2"]);
  assert.equal(deal.sqm, 84); // הערך הקיים לא נדרס
  assert.equal(deal.neighborhood, "עין גנים"); // שדה חסר הושלם
  assert.equal(deal.totalFloors, 3);
  assert.equal(deal.firstSeenAt, now);
  const third = Deals.mergeAll(second.store, [Deals.fromYad2(yad2Result)], now + 2);
  assert.equal(third.added + third.updated, 0);
  assert.equal(third.store[Object.keys(third.store)[0]], deal);
});

test("listings are compared with deals of a similar size first, all sizes only as a marked fallback", () => {
  const now = Date.UTC(2026, 10, 9);
  const deal = (house, price, sqm, rooms) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, houseNumber: house },
    price, buildingMR: sqm, rooms, saleDate: "2025-06-01",
  });
  const store = Deals.mergeAll({}, [
    deal(10, 2_000_000, 80, 3), deal(12, 2_100_000, 85, 3), deal(14, 2_050_000, 82, 3), // דירות רגילות
    deal(16, 5_000_000, 200, 6), deal(18, 5_400_000, 210, 6), deal(20, 5_200_000, 220, 6), // גדולות
  ], now).store;
  const index = Deals.buildIndex(store, { years: 4, now });
  const base = { address: "אמיר בנימיני 30, פתח תקווה", city: "פתח תקווה" };
  const big = Deals.compareListing({ ...base, sqm: 228, rooms: 6 }, index, 20_000);
  assert.equal(big.similar, true);
  assert.equal(big.count, 3);
  assert.equal(big.medianPpsm, 25_000);
  const small = Deals.compareListing({ ...base, sqm: 84, rooms: 3 }, index, 25_000);
  assert.equal(small.count, 3);
  assert.ok(small.medianPpsm < 26_000);
  // אין עסקאות בגודל דומה (40 מ״ר) – כל הגדלים, מסומן
  const tiny = Deals.compareListing({ ...base, sqm: 40, rooms: 1 }, index, 30_000);
  assert.equal(tiny.similar, false);
  assert.equal(tiny.count, 6);
});

test("a listing gets a separate comparison for building, street, neighborhood and city", () => {
  const now = Date.UTC(2026, 10, 9);
  const make = (street, house, hood, price) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, street: { text: street }, houseNumber: house, neighborhood: { text: hood } },
    price, buildingMR: 100, rooms: 4, saleDate: "2025-06-01",
  });
  const items = [
    make("אמיר בנימיני", 6, "עין גנים", 2_000_000), make("אמיר בנימיני", 6, "עין גנים", 2_100_000), make("אמיר בנימיני", 6, "עין גנים", 2_200_000),
    make("אמיר בנימיני", 8, "עין גנים", 2_600_000), make("אמיר בנימיני", 10, "עין גנים", 2_700_000),
    make("הרצל", 1, "מרכז", 3_000_000), make("הרצל", 2, "מרכז", 3_100_000), make("הרצל", 3, "מרכז", 3_200_000),
    make("הרצל", 4, "מרכז", 3_300_000), make("הרצל", 5, "מרכז", 3_400_000),
  ];
  const index = Deals.buildIndex(Deals.mergeAll({}, items, now).store, { years: 4, now });
  const record = { address: "אמיר בנימיני 6, פתח תקווה", city: "פתח תקווה", neighborhood: "עין גנים", sqm: 100, rooms: 4 };
  const all = Deals.compareListingAll(record, index, 22_000);
  assert.equal(all.building.count, 3);
  assert.equal(all.building.medianPpsm, 21_000);
  assert.equal(all.street.count, 5);
  assert.equal(all.street.medianPpsm, 22_000);
  assert.equal(all.street.diffPct, 0);
  assert.equal(all.neighborhood.count, 5);
  assert.equal(all.city.count, 10);
  assert.equal(all.city.medianPpsm, 28_500);
  assert.ok(all.city.diffPct < 0);
  // רמה בלי מספיק עסקאות – null
  const lonely = Deals.compareListingAll({ ...record, address: "אמיר בנימיני 40, פתח תקווה" }, index, 22_000);
  assert.equal(lonely.building, null);
  assert.equal(lonely.street.count, 5);
});

test("deals by city and neighborhood count only recent years and give medians", () => {
  const now = Date.UTC(2026, 10, 9);
  const make = (city, hood, house, price, date) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, city: { text: city }, neighborhood: hood ? { text: hood } : undefined, houseNumber: house },
    price, buildingMR: 100, saleDate: date,
  });
  const store = Deals.mergeAll({}, [
    make("פתח תקווה", "עין גנים", 1, 2_000_000, "2026-01-01"),
    make("פתח תקווה", "עין גנים", 2, 2_400_000, "2025-01-01"),
    make("פתח תקווה", "כפר גנים", 3, 3_000_000, "2024-05-01"),
    make("פתח תקווה", null, 4, 9_000_000, "2020-01-01"), // ישנה מדי
    make("רמת גן", "הבורסה", 5, 4_000_000, "2026-03-01"),
  ], now).store;
  const result = Deals.dealsByArea(store, { years: 3, now });
  assert.deepEqual(result.years, [2024, 2025, 2026]);
  assert.equal(result.cities[0].city, "פתח תקווה");
  assert.equal(result.cities[0].count, 3);
  assert.deepEqual(result.cities[0].byYear, { 2024: 1, 2025: 1, 2026: 1 });
  assert.equal(result.cities[0].medianPpsm, 24_000);
  assert.equal(result.neighborhoods[0].neighborhood, "עין גנים");
  assert.equal(result.neighborhoods[0].count, 2);
  assert.equal(result.cities.length, 2);
});

test("deal search filters by text, city, source and ranges, sorts with missing values last and summarizes", () => {
  const make = (house, price, sqm, date, rooms, source) => {
    const item = Deals.fromYad2({ ...yad2Result, address: { ...yad2Result.address, houseNumber: house }, price, buildingMR: sqm, saleDate: date, rooms });
    item.deal.sources = source;
    return item;
  };
  const store = Deals.mergeAll({}, [
    make(1, 2_000_000, 100, "2025-01-01", 4, ["yad2"]),
    make(2, 3_000_000, 100, "2026-01-01", 5, ["madlan", "yad2"]),
    make(3, 1_500_000, null, "2024-01-01", 3, ["madlan"]),
  ], 1).store;
  assert.equal(Deals.filterDeals(store, { query: "בנימיני" }).length, 3);
  assert.equal(Deals.filterDeals(store, { query: "הרצל" }).length, 0);
  assert.equal(Deals.filterDeals(store, { city: "פתח תקווה" }).length, 3);
  assert.equal(Deals.filterDeals(store, { source: "both" }).length, 1);
  assert.equal(Deals.filterDeals(store, { source: "madlan" }).length, 2);
  assert.equal(Deals.filterDeals(store, { rooms: { min: 4 } }).length, 2);
  assert.equal(Deals.filterDeals(store, { year: { min: 2025, max: 2025 } }).length, 1);
  assert.equal(Deals.filterDeals(store, { ppsm: { max: 25_000 } }).length, 1, "a deal without area has no price per m2");
  const byPpsm = Deals.sortDeals(Deals.filterDeals(store), "ppsm", -1).map(([, deal]) => deal.house);
  assert.deepEqual(byPpsm, ["2", "1", "3"]);
  const summary = Deals.summarizeDeals(Deals.filterDeals(store));
  assert.equal(summary.count, 3);
  assert.equal(summary.medianPpsm, 25_000);
  assert.equal(summary.medianPrice, 2_000_000);
  assert.equal(summary.fromDate, "2024-01-01");
  assert.equal(Deals.placeKey("פתח תקווה", "רחוב אמיר בנימיני", "2"), Deals.placeKey("פתח-תקווה", "בנימיני אמיר", "2"));
});

test("a listing is compared with the most specific level that has enough recent deals", () => {
  const now = Date.UTC(2026, 10, 9);
  const deal = (house, price, sqm, date = "2025-06-01") => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, houseNumber: house },
    price,
    buildingMR: sqm,
    saleDate: date,
  });
  const items = [
    deal(6, 2_000_000, 100),
    deal(6, 2_200_000, 100),
    deal(6, 2_400_000, 100),
    deal(8, 1_000_000, 100),
    deal(6, 9_000_000, 100, "2012-01-01"), // ישנה מדי
  ];
  const store = Deals.mergeAll({}, items, now).store;
  const index = Deals.buildIndex(store, { years: 4, now });
  const record = { address: "אמיר בנימיני 6, פתח תקווה", city: "פתח תקווה", neighborhood: "עין גנים" };
  const building = Deals.compareListing(record, index, 24_200);
  assert.equal(building.level, "building");
  assert.equal(building.count, 3);
  assert.equal(building.medianPpsm, 22_000);
  assert.equal(building.diffPct, 10);
  const street = Deals.compareListing({ ...record, address: "אמיר בנימיני 10, פתח תקווה" }, index, 20_000);
  assert.equal(street.level, "street");
  assert.equal(street.count, 4);
  assert.equal(Deals.compareListing({ ...record, address: "הרצל 1, פתח תקווה" }, index, 20_000), null);
});

test("analyzeDeals: yearly medians, trend, buckets and buildings", () => {
  const deal = (date, price, sqm, extra = {}) => [
    `k${date}${price}`,
    { city: "גני תקווה", street: "דרך אילות", house: "2", date, price, sqm, sources: ["madlan"], ...extra },
  ];
  const list = [
    deal("2022-03-01", 2000000, 100, { rooms: 4, floor: 2, buildYear: 1995 }),
    deal("2022-06-01", 2200000, 100, { rooms: 4, floor: 5, buildYear: 1995 }),
    deal("2022-09-01", 2400000, 100, { rooms: 4, floor: 0, buildYear: 1995 }),
    deal("2024-02-01", 2420000, 100, { rooms: 3, floor: 3 }),
    deal("2024-05-01", 2662000, 100, { rooms: 5, floor: 10, street: "המשי", house: "15" }),
    deal("2024-08-01", 2904000, 100, { rooms: 5.5, floor: 20, buildYear: 2018, street: "המשי", house: "15" }),
    deal("2025-01-01", 3000000, null),
  ];
  const stats = Deals.analyzeDeals(list);
  assert.equal(stats.overall.count, 7);
  assert.equal(stats.overall.ppsmCount, 6);
  assert.deepEqual(stats.byYear.map((row) => [row.year, row.count, row.medianPpsm]), [
    [2022, 3, 22000],
    [2024, 3, 26620],
    [2025, 1, null],
  ]);
  // 2025 has no price-per-sqm deals, so the trend compares 2022 → 2024
  assert.deepEqual(stats.lastChange, { fromYear: 2022, toYear: 2024, pct: 21 });
  assert.deepEqual(stats.annualChange, { fromYear: 2022, toYear: 2024, pct: 10 });
  assert.deepEqual(stats.byRooms.map((row) => [row.label, row.count]), [["2.5–3", 1], ["3.5–4", 3], ["4.5–5", 1], ["5.5+", 1]]);
  assert.deepEqual(stats.byFloor.map((row) => [row.label, row.count]), [["קרקע", 1], ["1–3", 2], ["4–8", 1], ["9–15", 1], ["16+", 1]]);
  assert.deepEqual(stats.byBuildYear.map((row) => [row.label, row.count]), [["1980–1999", 3], ["2015 ואילך", 1]]);
  assert.equal(stats.byBuilding[0].street, "דרך אילות");
  assert.equal(stats.byBuilding[0].count, 5);
  assert.equal(stats.byBuilding[0].lastDate, "2025-01-01");
  assert.equal(stats.streetCount, 2);
  assert.equal(stats.points.length, 6);
  assert.equal(stats.toDate, "2025-01-01");
  assert.equal(stats.fromDate, "2022-03-01");
});

test("analyzeDeals: empty input and quantile", () => {
  const stats = Deals.analyzeDeals([]);
  assert.equal(stats.overall.count, 0);
  assert.equal(stats.lastChange, null);
  assert.deepEqual(stats.byYear, []);
  assert.equal(Deals.quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(Deals.quantile([10, 20], 0.5), 15);
});
