const assert = require("node:assert/strict");
const test = require("node:test");

const CacheData = require("../cache-data.js");

const changes = (history) => {
  const points = CacheData.withoutPriceBounces(history).history;
  return points.slice(1).map((point, index) => [points[index].price, point.price]);
};

test("search-card noise (other listings' prices for minutes) is not a price change", () => {
  // מהקובץ שלך: שרגא רפאלי 25 – עמוד המודעה הראה 2.77 כל הזמן, הכרטיסים "קפצו" בין מחירים של מודעות אחרות
  const rafaeli25 = [
    { at: 1791461978000, price: 2770000, src: "site", baselineKnown: true },
    { at: 1794067807489, price: 2750000, src: "search" },
    { at: 1794067818489, price: 2940000, src: "search" },
    { at: 1794067826481, price: 2750000, src: "search" },
    { at: 1794067905498, price: 2990000, src: "search" },
    { at: 1794067932477, price: 2770000, src: "search" },
    { at: 1794121058546, price: 3150000, src: "search" },
    { at: 1794121131544, price: 2980000, src: "search" },
    { at: 1794121159551, price: 2770000, src: "search" },
    { at: 1794329166874, price: 2770000, src: "page" },
    { at: 1794389448168, price: 2750000, src: "search" },
    { at: 1794398470184, price: 2770000, src: "page" },
  ];
  assert.deepEqual(changes(rafaeli25), []);
  // בלוי 1 – 2.74 לפי האתר, באמצע "3.89" ו"3.45" מכרטיסים אחרים
  const blui1 = [
    { at: 1793180866000, price: 2740000, src: "site", baselineKnown: true },
    { at: 1794061375429, price: 2900000, src: "search" },
    { at: 1794061842942, price: 2740000, src: "search" },
    { at: 1794111798563, price: 3890000, src: "search" },
    { at: 1794111996557, price: 2740000, src: "search" },
    { at: 1794222636756, price: 3450000, src: "search" },
    { at: 1794233244716, price: 2740000, src: "search" },
  ];
  assert.deepEqual(changes(blui1), []);
});

test("real changes stay: site history, a page observation, and a confirmed search price", () => {
  const day = 86400000;
  const history = [
    { at: 0, price: 3150000, src: "site", baselineKnown: true },
    { at: 10 * day, price: 2900000, src: "site" },
    { at: 40 * day, price: 2850000, src: "search", confirmed: true },
    { at: 60 * day, price: 2800000, src: "page" },
  ];
  assert.deepEqual(changes(history), [[3150000, 2900000], [2900000, 2850000], [2850000, 2800000]]);
});

test("a search card with a different price is recorded only after it is seen again 20+ minutes later", () => {
  const minute = 60000;
  const base = { price: 2770000, observedPrice: 2770000, priceHistory: [{ price: 2770000, at: 0, src: "page", baselineKnown: true }] };
  const first = CacheData.recordPriceObservation(base, 2750000, 100 * minute, { source: "search", sqm: 98 });
  assert.equal(first.accepted, false);
  assert.equal(first.priceHistory, base.priceHistory);
  const s1 = { ...base, ...first };
  // מחיר אחר באמצע מאפס את ההמתנה
  const other = CacheData.recordPriceObservation(s1, 2940000, 105 * minute, { source: "search", sqm: 98 });
  assert.equal(other.accepted, false);
  assert.equal(other.searchPendingPrice, 2940000);
  const tooSoon = CacheData.recordPriceObservation(s1, 2750000, 110 * minute, { source: "search", sqm: 98 });
  assert.equal(tooSoon.accepted, false);
  const confirmed = CacheData.recordPriceObservation(s1, 2750000, 125 * minute, { source: "search", sqm: 98 });
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.priceHistory.at(-1).confirmed, true);
  assert.equal(confirmed.searchPendingPrice, undefined);
  // עמוד המודעה מתקבל מיד
  assert.equal(CacheData.recordPriceObservation(base, 2750000, 100 * minute, { source: "page", sqm: 98 }).accepted, true);
});
