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

test("deal search understands house numbers and ranges: 'בלוי 28-30', 'בלוי 28 עד 30', exact 28", () => {
  const make = (house) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, street: { text: "בלוי" }, houseNumber: house },
    saleDate: "2025-01-01", price: 2_000_000 + Number(String(house).replace(/\D/g, "")),
  });
  const store = Deals.mergeAll({}, [make(27), make(28), make("28א"), make(29), make(30), make(31), make(280), make(128)], 1).store;
  const houses = (query, extra = {}) => Deals.filterDeals(store, { query, ...extra }).map(([, deal]) => deal.house).sort();
  assert.deepEqual(houses("בלוי 28-30"), ["28", "28א", "29", "30"]);
  assert.deepEqual(houses("בלוי 28–30"), ["28", "28א", "29", "30"]);
  assert.deepEqual(houses("בלוי 28 עד 30"), ["28", "28א", "29", "30"]);
  assert.deepEqual(houses("בלוי 30-28"), ["28", "28א", "29", "30"], "reversed range");
  assert.deepEqual(houses("בלוי 28"), ["28", "28א"], "not 280 or 128");
  assert.deepEqual(houses("בלוי 28א"), ["28א"]);
  assert.deepEqual(houses("בלוי", { house: { min: 29, max: 31 } }), ["29", "30", "31"]);
  assert.equal(houses("בלוי").length, 8);
});

test("deal search filters by floor range, ground floor is 0, unknown floor is left out", () => {
  const make = (house, floor) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, houseNumber: house },
    floor, saleDate: "2025-01-01", price: 2_000_000 + house,
  });
  const store = Deals.mergeAll({}, [make(1, 0), make(2, 3), make(3, 7), make(4, 15), make(5, null)], 1).store;
  const floors = (range) => Deals.filterDeals(store, { floor: range }).map(([, deal]) => deal.floor).sort((a, b) => a - b);
  assert.deepEqual(floors({ min: 0, max: 0 }), [0]);
  assert.deepEqual(floors({ min: 3, max: 10 }), [3, 7]);
  assert.deepEqual(floors({ min: 8 }), [15]);
  assert.deepEqual(floors({ max: 3 }), [0, 3]);
  assert.equal(Deals.filterDeals(store, {}).length, 5);
});

test("deal search filters by neighborhood as its own field (spelling-insensitive, unknown neighborhood left out)", () => {
  const store = {
    a: { city: "פתח תקווה", street: "הרצל", house: "1", neighborhood: "עין גנים", price: 1, sqm: 1, date: "2025-01-01" },
    b: { city: "פתח תקווה", street: "בלוי", house: "2", neighborhood: "שכונת עין גנים", price: 1, sqm: 1, date: "2025-01-01" },
    c: { city: "פתח תקווה", street: "עין גנים", house: "3", price: 1, sqm: 1, date: "2025-01-01" },
    d: { city: "פתח תקווה", street: "הרצל", house: "4", neighborhood: "כפר גנים", price: 1, sqm: 1, date: "2025-01-01" },
  };
  const keys = (filters) => Deals.filterDeals(store, filters).map(([key]) => key).sort();
  assert.deepEqual(keys({ neighborhood: "עין גנים" }), ["a", "b"]);
  assert.deepEqual(keys({ neighborhood: "עין גנים", query: "הרצל" }), ["a"]);
  assert.deepEqual(keys({ neighborhood: "עין גנים", city: "פתח תקווה" }), ["a", "b"]);
});

test("deal analysis breaks down by city, neighborhood, street, size, type and quarter with yearly change", () => {
  const make = (city, hood, street, house, price, sqm, date, type) => Deals.fromYad2({
    ...yad2Result,
    address: { ...yad2Result.address, city: { text: city }, neighborhood: hood ? { text: hood } : undefined, street: { text: street }, houseNumber: house },
    price, buildingMR: sqm, saleDate: date, propertyType: type,
  });
  const items = [];
  // עין גנים: 3 עסקאות ב-2024 ב-20K למ״ר, 3 ב-2025 ב-22K – עלייה של 10%
  for (let i = 0; i < 3; i++) items.push(make("פתח תקווה", "עין גנים", "אמיר בנימיני", 10 + i, 2_000_000, 100, `2024-0${i + 1}-15`, "דירה"));
  for (let i = 0; i < 3; i++) items.push(make("פתח תקווה", "עין גנים", "אמיר בנימיני", 20 + i, 2_200_000, 100, `2025-0${i + 4}-15`, "דירה"));
  items.push(make("פתח תקווה", "כפר גנים", "הרצל", 1, 3_000_000, 140, "2025-08-01", "פנטהאוז"));
  items.push(make("רמת גן", "הבורסה", "ז'בוטינסקי", 5, 2_500_000, 70, "2025-09-01", "דירה"));
  const store = Deals.mergeAll({}, items, 1).store;
  const stats = Deals.analyzeDeals(Deals.filterDeals(store));
  assert.equal(stats.byCity.length, 2);
  assert.equal(stats.byCity[0].city, "פתח תקווה");
  const ein = stats.byNeighborhood.find((row) => row.neighborhood === "עין גנים");
  assert.equal(ein.count, 6);
  assert.deepEqual(ein.change, { fromYear: 2024, toYear: 2025, pct: 10 });
  assert.equal(stats.byStreet[0].street, "אמיר בנימיני");
  assert.deepEqual(stats.bySize.map((row) => [row.label, row.count]), [["61–80 מ״ר", 1], ["81–100 מ״ר", 6], ["131+ מ״ר", 1]]);
  assert.equal(stats.byType.find((row) => row.label === "פנטהאוז").count, 1);
  assert.deepEqual(stats.byQuarter.map((row) => row.key), ["2024-Q1", "2025-Q2", "2025-Q3"]);
  assert.equal(stats.withNeighborhood, 8);
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
  // ORDER BY sqm DESC, price ASC: שתי עסקאות של 100 מ"ר – הזולה קודם; בלי שטח – בסוף
  const multi = Deals.sortDeals(Deals.filterDeals(store), [
    { key: "sqm", direction: -1 },
    { key: "price", direction: 1 },
  ]).map(([, deal]) => deal.house);
  assert.deepEqual(multi, ["1", "2", "3"]);
  const multiDesc = Deals.sortDeals(Deals.filterDeals(store), [
    { key: "sqm", direction: -1 },
    { key: "price", direction: -1 },
  ]).map(([, deal]) => deal.house);
  assert.deepEqual(multiDesc, ["2", "1", "3"]);
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

test("neighborhood level: Madlan deals without a neighborhood get one from the building/street, names normalized", () => {
  const deal = (street, house, neighborhood, n) => ({
    city: "פתח תקווה", street, house, neighborhood, date: `2025-0${(n % 9) + 1}-01`, price: 2_000_000 + n * 1000, sqm: 100, rooms: 4,
  });
  const store = {};
  let n = 0;
  // יד2: 4 עסקאות ברחוב הרצל, בשכונה "שכונת שיפר"
  for (let i = 0; i < 4; i++) store[`y${i}`] = deal("הרצל", String(10 + i), "שכונת שיפר", n++);
  // מדלן: 4 עסקאות באותו רחוב, בלי שכונה
  for (let i = 0; i < 4; i++) store[`m${i}`] = deal("הרצל", String(20 + i), null, n++);
  // רחוב שחוצה שתי שכונות: לא משייכים
  store.a = deal("ז׳בוטינסקי", "1", "שיפר", n++);
  store.b = deal("ז׳בוטינסקי", "3", "כפר גנים", n++);
  store.c = deal("ז׳בוטינסקי", "5", "כפר גנים", n++);
  store.d = deal("ז׳בוטינסקי", "7", null, n++);
  const index = Deals.buildIndex(store, { now: Date.UTC(2026, 0, 1) });
  assert.equal(index.byHood.get("פתח תקווה|שיפר").length, 9);
  // מודעה ששם השכונה שלה "שיפר" (בלי "שכונת") מקבלת את כל 9
  const all = Deals.compareListingAll({ address: "הרצל 30, פתח תקווה", city: "פתח תקווה", neighborhood: "שיפר", sqm: 100, rooms: 4 }, index, 20000);
  assert.equal(all.neighborhood.count, 9);
  // מודעה עם שם שכונה אחר (כמו במדלן) – לפי הרחוב
  const other = Deals.compareListingAll({ address: "הרצל 30, פתח תקווה", city: "פתח תקווה", neighborhood: "מרכז העיר", sqm: 100, rooms: 4 }, index, 20000);
  assert.equal(other.neighborhood.count, 9);
});

// ---------- שמירה לפי עיר ----------
function fakeArea(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const pick = (keys) => {
    if (keys === null) return { ...data };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
  };
  return {
    data,
    writes: [],
    async get(keys) { return JSON.parse(JSON.stringify(pick(keys))); },
    async set(values) { this.writes.push(Object.keys(values)); Object.assign(data, JSON.parse(JSON.stringify(values))); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    async getKeys() { return Object.keys(data); },
  };
}

const dealIn = (city, street, price) => Deals.mergeAll({}, [{
  key: Deals.dealKey({ city, street, house: "3", date: "2025-01-01", price }),
  deal: { city, street, house: "3", date: "2025-01-01", price, sources: ["yad2"] },
}]).store;

test("saveItems writes each city to its own key and touches only those cities", async () => {
  const area = fakeArea({ [Deals.shardKey("חולון")]: dealIn("חולון", "סוקולוב", 1500000), other: 1 });
  const items = [
    { key: Deals.dealKey({ city: "בת ים", street: "הרצל", house: "3", date: "2025-01-01", price: 2000000 }),
      deal: { city: "בת ים", street: "הרצל", house: "3", date: "2025-01-01", price: 2000000, sources: ["yad2"] } },
  ];
  const result = await Deals.saveItems(area, items);
  assert.equal(result.added, 1);
  assert.deepEqual(area.writes, [[Deals.shardKey("בת ים")]]);
  assert.equal(Object.keys(area.data[Deals.shardKey("בת ים")]).length, 1);
  assert.equal(Object.keys(area.data[Deals.shardKey("חולון")]).length, 1);
  // שמירה חוזרת של אותה עסקה לא כותבת כלום
  const again = await Deals.saveItems(area, items);
  assert.equal(again.added + again.updated, 0);
  assert.equal(area.writes.length, 1);
  assert.equal(Object.keys(again.before).length, 1);
});

test("migrate splits the old single key by city without losing deals", async () => {
  const legacy = { ...dealIn("בת ים", "הרצל", 2000000), ...dealIn("בת ים", "בלפור", 2100000), ...dealIn("חולון", "סוקולוב", 1500000) };
  const area = fakeArea({
    lightrailDeals: legacy,
    [Deals.shardKey("חולון")]: dealIn("חולון", "ויצמן", 1600000),
  });
  assert.equal(await Deals.migrate(area), 3);
  assert.equal("lightrailDeals" in area.data, false);
  assert.equal(Object.keys(area.data[Deals.shardKey("בת ים")]).length, 2);
  assert.equal(Object.keys(area.data[Deals.shardKey("חולון")]).length, 2);
  assert.equal(Object.keys(await Deals.loadAll(area)).length, 4);
  assert.equal(await Deals.migrate(area), 0);
});

test("loadCity reads one city, including deals still in the old key", async () => {
  const area = fakeArea({
    lightrailDeals: dealIn("בת ים", "הרצל", 2000000),
    [Deals.shardKey("בת ים")]: dealIn("בת ים", "בלפור", 2100000),
    [Deals.shardKey("חולון")]: dealIn("חולון", "סוקולוב", 1500000),
  });
  const store = await Deals.loadCity(area, "בת ים");
  assert.equal(Object.keys(store).length, 2);
  assert.ok(Object.keys(store).every((key) => key.startsWith("בת ים|")));
  assert.equal(Object.keys(await Deals.loadAll(area)).length, 3);
  assert.equal(await Deals.hasAny(fakeArea({ other: 1 })), false);
  assert.ok(Deals.isDealsKey(Deals.shardKey("בת ים")) && Deals.isDealsKey("lightrailDeals") && !Deals.isDealsKey("lightrailDealsFetched"));
});

test("collapseDeals merges the same deal across sources (street spelling / one-day gap), keeps the richest", () => {
  const store = {
    // אותה עסקה: מדלן בלי "הרב", ללא קומות בבניין ושנה
    "madlan": { city: "פתח תקווה", street: "בלוי משה", house: "28", date: "2026-05-19", price: 2840000, sqm: 112, rooms: 5, floor: 8, sources: ["madlan"] },
    // נדל"ן ממשלתי + יד2: כתיב מלא, עם קומות בבניין ושנה
    "nadlan": { city: "פתח תקווה", street: "הרב משה בלוי", house: "28", date: "2026-05-19", price: 2840000, sqm: 112, rooms: 5, floor: 8, totalFloors: 10, buildYear: 2028, neighborhood: "שיפר", sources: ["nadlan", "yad2"] },
    // עסקה אחרת: אותו מחיר ויום סמוך אבל קומה ושטח שונים – לא ממזגים
    "other": { city: "פתח תקווה", street: "הרב משה בלוי", house: "28", date: "2026-05-18", price: 2840000, sqm: 106, rooms: 5, floor: 2, sources: ["nadlan"] },
    // מחיר שונה בכמה שקלים – עסקה נפרדת
    "cheaper": { city: "פתח תקווה", street: "הרב משה בלוי", house: "28", date: "2026-05-19", price: 2839960, sqm: 112, rooms: 5, floor: 8, sources: ["nadlan"] },
  };
  const { store: out, merged } = Deals.collapseDeals(store);
  assert.equal(merged, 1);
  assert.equal(Object.keys(out).length, 3);
  const rep = Object.values(out).find((d) => d.mergedFrom);
  assert.equal(rep.mergedFrom, 2);
  assert.deepEqual(rep.sources, ["madlan", "nadlan", "yad2"]);
  assert.equal(rep.totalFloors, 10); // נלקח מהרשומה העשירה
  assert.equal(rep.buildYear, 2028);
  assert.equal(rep.neighborhood, "שיפר");
  // העסקה בקומה אחרת והעסקה במחיר אחר נשארו בנפרד
  assert.ok(Object.values(out).some((d) => d.floor === 2 && !d.mergedFrom));
  assert.ok(Object.values(out).some((d) => d.price === 2839960));
});

test("collapseDeals needs sqm or floor to actually match, not just price and date", () => {
  const store = {
    a: { city: "חולון", street: "סוקולוב", house: "5", date: "2025-01-01", price: 2000000, sources: ["yad2"] },
    b: { city: "חולון", street: "סוקולוב", house: "5", date: "2025-01-01", price: 2000000, sources: ["madlan"] },
  };
  // לשתיהן אין קומה ואין שטח – אין עוגן, לא ממזגים
  assert.equal(Deals.collapseDeals(store).merged, 0);
});
