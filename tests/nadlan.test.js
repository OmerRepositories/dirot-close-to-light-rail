const assert = require("node:assert/strict");
const test = require("node:test");

const Deals = require("../deals-core.js");

const ROW = ["1", "הרב משה בלוי 28", "112", "19/05/2026", "2,840,000 ₪", "6355-657-19", "דירה בבית קומות", "5", "שמינית", "", ""];

test("a government-site row becomes a deal with the page's city and neighborhood", () => {
  const item = Deals.fromNadlan(ROW, { city: "פתח תקווה", neighborhood: "שיפר" });
  assert.equal(item.deal.street, "הרב משה בלוי");
  assert.equal(item.deal.house, "28");
  assert.equal(item.deal.date, "2026-05-19");
  assert.equal(item.deal.price, 2840000);
  assert.equal(item.deal.sqm, 112);
  assert.equal(item.deal.rooms, 5);
  assert.equal(item.deal.floor, 8);
  assert.equal(item.deal.neighborhood, "שיפר");
  assert.equal(item.deal.propertyType, "דירה בבית קומות");
  assert.deepEqual(item.deal.sources, ["nadlan"]);
  // אותה עסקה כמו ביד2/מדלן – אותו מפתח, ולכן תתמזג
  const fromYad2 = Deals.fromYad2({
    address: { city: { text: "פתח תקווה" }, street: { text: "הרב משה בלוי" }, houseNumber: 28 },
    saleDate: "2026-05-19T00:00:00Z",
    price: 2840000,
  });
  assert.equal(item.key, fromYad2.key);
});

test("rows without a city, a date or an address are skipped", () => {
  assert.equal(Deals.fromNadlan(ROW, null), null);
  assert.equal(Deals.fromNadlan(ROW, { city: "" }), null);
  assert.equal(Deals.fromNadlan(["1", "בלי מספר", "100", "19/05/2026", "2,000,000 ₪", "", "", "3", "ראשונה"], { city: "פתח תקווה" }), null);
  assert.equal(Deals.fromNadlan([...ROW.slice(0, 3), "תאריך שבור", ...ROW.slice(4)], { city: "פתח תקווה" }), null);
});

test("floors written in words become numbers; unknown words stay empty", () => {
  assert.equal(Deals.nadlanFloor("קרקע"), 0);
  assert.equal(Deals.nadlanFloor("שניה"), 2);
  assert.equal(Deals.nadlanFloor("שנייה"), 2);
  assert.equal(Deals.nadlanFloor("שתים עשרה"), 12);
  assert.equal(Deals.nadlanFloor("7"), 7);
  assert.equal(Deals.nadlanFloor("לא ידוע"), null);
  assert.equal(Deals.nadlanFloor(""), null);
});
