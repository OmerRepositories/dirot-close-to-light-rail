const assert = require("node:assert/strict");
const test = require("node:test");

const LRCacheData = require("../cache-data.js");

test("purchase tax is progressive: each bracket taxes only the part of the price inside it", () => {
  assert.equal(LRCacheData.purchaseTax(1_900_000).tax, 0);
  assert.equal(LRCacheData.purchaseTax(1_978_745).tax, 0);
  // (2,347,040 − 1,978,745) × 3.5% + (2,500,000 − 2,347,040) × 5%
  const mid = LRCacheData.purchaseTax(2_500_000);
  assert.equal(mid.tax, 20538);
  assert.equal(mid.total, 2_520_538);
  assert.equal(mid.effectivePct, 0.8);
  assert.equal(mid.parts.length, 2);
  // כל המדרגות, כולל המדרגה הפתוחה (10% מעל 20,183,565)
  assert.equal(LRCacheData.purchaseTax(25_000_000).tax, 1_810_215);
  assert.equal(LRCacheData.purchaseTax(0), null);
  assert.equal(LRCacheData.purchaseTax(undefined), null);
});

test("buyer tracks match the published examples (1.8M / 2M / 2.5M / 3M)", () => {
  const tracks = LRCacheData.purchaseTaxTracksFrom({});
  const tax = (track, price) => LRCacheData.purchaseTax(price, tracks[track]).tax;
  assert.deepEqual([1_800_000, 2_000_000, 2_500_000, 3_000_000].map((p) => tax("single", p)), [0, 744, 20538, 45538]);
  assert.deepEqual([1_800_000, 2_000_000, 2_500_000, 3_000_000].map((p) => tax("disabled", p)), [0, 106, 2606, 15000]);
  assert.deepEqual([1_800_000, 2_000_000, 2_500_000, 3_000_000].map((p) => tax("oleh", p)), [0, 106, 2606, 5106]);
  assert.deepEqual([1_800_000, 2_000_000, 2_500_000, 3_000_000].map((p) => tax("additional", p)), [144000, 160000, 200000, 240000]);
});

test("the selected track is read from settings; 1.31.0 single-apartment settings still apply", () => {
  const legacy = { purchaseTaxExemptUpTo: 2_000_000, purchaseTaxBrackets: [{ upTo: null, rate: 5 }] };
  assert.equal(LRCacheData.purchaseTaxSettingsFrom(legacy).exemptUpTo, 2_000_000);
  assert.equal(LRCacheData.purchaseTaxSettingsFrom(legacy).track, "single");
  const investor = LRCacheData.purchaseTaxSettingsFrom({ purchaseTaxTrack: "additional" });
  assert.equal(LRCacheData.purchaseTax(1_000_000, investor).tax, 80_000);
  const edited = LRCacheData.purchaseTaxSettingsFrom({
    purchaseTaxTrack: "disabled",
    purchaseTaxTracks: { disabled: { exemptUpTo: 1_978_745, brackets: [{ upTo: null, rate: 0.5 }], flatAbove: { threshold: 3_000_000, rate: 0.5 } } },
  });
  assert.equal(LRCacheData.purchaseTax(2_800_000, edited).tax, 4106);
  assert.equal(LRCacheData.purchaseTaxSettingsFrom({ purchaseTaxTrack: "nope" }).track, "single");
});

test("edited brackets and exemption are used, out-of-order or broken rows are cleaned up", () => {
  const settings = { exemptUpTo: 2_000_000, brackets: [{ upTo: null, rate: 10 }, { upTo: 3_000_000, rate: 5 }] };
  // 1,000,000 × 5% + 500,000 × 10%
  assert.equal(LRCacheData.purchaseTax(3_500_000, settings).tax, 100_000);
  const normalized = LRCacheData.normalizePurchaseTax(2_000_000, [{ upTo: 1_500_000, rate: 3 }, { upTo: "", rate: 7 }]);
  assert.deepEqual(normalized.brackets, [{ upTo: null, rate: 7 }], "a bracket below the exemption is dropped");
  // הגדרות חסרות או שבורות → ערכי ברירת המחדל
  assert.equal(LRCacheData.normalizePurchaseTax(null, null).exemptUpTo, 1_978_745);
  assert.equal(LRCacheData.normalizePurchaseTax(-5, []).brackets.length, 4);
});
