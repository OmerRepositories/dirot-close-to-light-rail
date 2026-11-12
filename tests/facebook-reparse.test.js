const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.LR = require("../parse.js");
require("../facebook-classifier.js");
const LR = globalThis.LR;
const { reparseRecord } = require("../facebook-reparse.js");

const base = (extra) => ({
  recordType: "listing",
  site: "facebook",
  city: "פתח תקווה",
  updatedAt: 1,
  ...extra,
});

test("facebook re-parse: fixes fields that the old parser got wrong, from the saved text", () => {
  const record = base({
    postText: `למכירה דירת 6 חדרים שהפכה ל-4 חדרים ברחוב הרצל 10 פתח תקווה, קומה 2\n103 מ"​ר נטו\nמחיר 1,900,000 ₪`,
    rooms: 6,
    floor: 2,
    price: 1_900_000,
    priceHistory: [{ price: 1_900_000, at: 1, src: "page" }],
    address: "הרצל 10, פתח תקווה",
    railMeters: 300,
  });
  const out = reparseRecord(record, LR, 5);
  assert.ok(out);
  assert.equal(out.record.rooms, 4);
  assert.equal(out.record.sqm, 103);
  assert.equal(out.record.pricePerSqm, Math.round(1_900_000 / 103));
  assert.equal(out.record.updatedAt, 5);
  assert.equal(out.addressChanged, false);
  assert.equal(out.record.railMeters, 300);
});

test("facebook re-parse: a wrong price is corrected in the history too, not added as a price change", () => {
  const record = base({
    postText: `למכירה דירת 4 חדרים ברחוב הרצל 10 פתח תקווה, קומה 2, 100 מ"ר\nכ־68 מ"ר לפי ארנונה | מחיר 2,100,000`,
    price: 680_000,
    priceHistory: [{ price: 680_000, at: 1, src: "page" }],
  });
  const out = reparseRecord(record, LR, 5);
  assert.equal(out.record.price, 2_100_000);
  assert.deepEqual(out.record.priceHistory.map((p) => p.price), [2_100_000]);
});

test("facebook re-parse: unchanged records, other sites and records without text are left alone", () => {
  const text = `למכירה דירת 4 חדרים ברחוב הרצל 10 פתח תקווה, קומה 2, 100 מ"ר, מחיר 2,000,000 ₪`;
  const first = reparseRecord(base({ postText: text }), LR, 5).record;
  assert.equal(reparseRecord(first, LR, 9), null);
  assert.equal(reparseRecord({ ...first, site: "yad2" }, LR, 9), null);
  assert.equal(reparseRecord(base({ price: 1 }), LR, 9), null);
});

test("facebook re-parse: posts that are not apartments are flagged, and a new address clears the rail distance", () => {
  const building = reparseRecord(base({ postText: `בניין 3 קומות מחולק ל 10 יחידות דיור, 400 מ"ר, מחיר 9,000,000 ₪` }), LR, 5);
  assert.equal(building.record.facebookNotListing, true);
  const moved = reparseRecord(
    base({ postText: `למכירה דירת 4 חדרים ברחוב הרצל 10 פתח תקווה, 100 מ"ר, מחיר 2,000,000 ₪`, address: "פתח תקווה", railMeters: 900 }),
    LR,
    5
  );
  assert.equal(moved.addressChanged, true);
  assert.equal(moved.record.railMeters, undefined);
  assert.ok(moved.queries.length);
});
