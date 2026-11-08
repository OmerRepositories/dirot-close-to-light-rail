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
