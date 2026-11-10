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
