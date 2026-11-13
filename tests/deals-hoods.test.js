const assert = require("node:assert/strict");
const test = require("node:test");

const Deals = require("../deals-core.js");

const deal = (city, neighborhood, date, price, sqm) => ({ city, neighborhood, date, price, sqm, street: "הרחוב", house: "1" });
const store = {
  a: deal("פתח תקווה", "כפר גנים", "2024-03-01", 2000000, 100),
  b: deal("פתח תקווה", "כפר גנים", "2024-07-01", 2400000, 100),
  c: deal("פתח תקווה", "כפר גנים", "2025-02-01", 2600000, 100),
  d: deal("פתח תקווה", "כפר גנים", "2025-05-01", 2800000, 100),
  e: deal("פתח תקוה", "מרכז העיר", "2024-04-01", 1800000, 100),
  f: deal("פתח תקווה", "מרכז העיר", "2024-09-01", 2000000, 100),
  g: deal("פתח תקווה", "מרכז העיר", "2025-01-01", 2100000, 100),
  h: deal("חולון", "מרכז העיר", "2024-01-01", 1500000, 100),
  i: deal("פתח תקווה", "", "2024-01-01", 1500000, 100),
};

test("several neighborhoods filter by city and neighborhood together", () => {
  const keys = Deals.filterDeals(store, { neighborhoods: ["פתח תקווה|כפר גנים", "פתח תקווה|מרכז העיר"] })
    .map((item) => item.key || item)
    .length;
  assert.equal(keys, 7); // לא כולל "מרכז העיר" בחולון ולא עסקה בלי שכונה
  assert.equal(Deals.filterDeals(store, { neighborhoods: [] }).length, Object.keys(store).length);
});

test("hood ids ignore spelling differences in the city name", () => {
  assert.equal(Deals.hoodId("פתח תקוה|מרכז העיר"), Deals.hoodId("פתח תקווה|מרכז העיר"));
  assert.equal(Deals.hoodId("בלי שכונה"), "");
});

test("hood series: median price per sqm by year, years with too few deals dropped", () => {
  const list = Object.values(store);
  const [kfar, center] = Deals.hoodSeries(list, ["פתח תקווה|כפר גנים", "פתח תקווה|מרכז העיר"]);
  assert.equal(kfar.neighborhood, "כפר גנים");
  assert.deepEqual(kfar.years, [
    { year: 2024, medianPpsm: 22000, count: 2 },
    { year: 2025, medianPpsm: 27000, count: 2 },
  ]);
  // 2025 במרכז העיר: עסקה אחת בלבד – לא נחשבת למגמה
  assert.deepEqual(center.years, [{ year: 2024, medianPpsm: 19000, count: 2 }]);
  assert.equal(center.count, 3);
  assert.equal(Deals.hoodSeries(list, ["פתח תקווה|כפר גנים"], { minCount: 1 })[0].years.length, 2);
});

test("hood series accepts the [key, deal] pairs that filterDeals returns", () => {
  const picked = ["פתח תקווה|כפר גנים"];
  const pairs = Deals.filterDeals(store, { neighborhoods: picked });
  assert.ok(Array.isArray(pairs[0]));
  const [series] = Deals.hoodSeries(pairs, picked);
  assert.equal(series.count, 4);
  assert.equal(series.years.length, 2);
});

test("missing neighborhoods are filled only from a majority at the exact same address", () => {
  const at = (city, street, house, neighborhood) => ({ city, street, house, neighborhood, date: "2024-01-01", price: 2000000, sqm: 100 });
  const input = {
    a: at("פתח תקווה", "בלוי", "28", "כפר גנים"),
    b: at("פתח תקווה", "בלוי", "28", "כפר גנים"),
    c: at("פתח תקווה", "בלוי", "28", "מרכז העיר"),
    d: at("פתח תקוה", "בלוי", "28", null), // אותה כתובת, כתיב אחר של העיר
    e: at("פתח תקווה", "בלוי", "30", null), // מספר בית אחר – לא משלימים
    f: at("רמת גן", "בלוי", "28", null), // עיר אחרת – לא משלימים
    g: at("פתח תקווה", "בלוי", "", null), // בלי מספר בית – לא משלימים
    h: at("חולון", "סוקולוב", "5", "א"),
    i: at("חולון", "סוקולוב", "5", "ב"),
    j: at("חולון", "סוקולוב", "5", null), // תיקו – אין רוב, לא משלימים
  };
  const out = Deals.withInferredHoods(input);
  assert.equal(out.d.neighborhood, "כפר גנים");
  assert.equal(out.d.neighborhoodInferred, true);
  for (const key of ["e", "f", "g", "j"]) assert.equal(out[key].neighborhood, null, key);
  assert.equal(out.a, input.a); // עסקאות עם שכונה לא משתנות
  assert.equal(input.d.neighborhood, null); // המאגר המקורי לא משתנה
});
