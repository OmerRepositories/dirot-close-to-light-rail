const test = require("node:test");
const assert = require("node:assert/strict");

global.LRStreetFilter = require("../street-filter.js");
const LRStreetScan = require("../street-scan-core.js");

test("settings are off by default and clamped", () => {
  assert.deepEqual(LRStreetScan.normalizeSettings(undefined), { enabled: false, everyHours: 24, maxPages: 5, delaySeconds: 20 });
  assert.deepEqual(
    LRStreetScan.normalizeSettings({ enabled: true, everyHours: 0, maxPages: 99, delaySeconds: 2 }),
    { enabled: true, everyHours: 1, maxPages: 20, delaySeconds: 10 }
  );
  assert.equal(LRStreetScan.normalizeSettings({ enabled: "yes" }).enabled, false);
});

test("favorite street lines need a city; duplicates are dropped", () => {
  const { streets, skipped } = LRStreetScan.streetsToScan([
    "ההגנה, פתח תקווה",
    "רחוב ההגנה, פתח תקוה",
    "הרצל",
    "  ",
    "דיזנגוף, תל אביב יפו",
  ]);
  assert.deepEqual(streets.map((street) => street.label), ["ההגנה, פתח תקווה", "דיזנגוף, תל אביב יפו"]);
  assert.equal(streets[0].query, "ההגנה פתח תקווה");
  assert.deepEqual(skipped, ["הרצל"]);
});

const AUTOCOMPLETE = {
  streets: [
    { fullTitleText: "ההגנה, ראשון לציון", streetId: "0100", cityId: "8300", areaId: "9", regionId: "1" },
    { fullTitleText: "שדרות ההגנה, פתח תקווה", streetId: "0300", cityId: "7900", areaId: "4", regionId: "1" },
    { fullTitleText: "ההגנה, פתח תקווה", streetId: "0220", cityId: "7900", areaId: "4", regionId: "1" },
  ],
};

test("the autocomplete result must match the city and prefers the exact street", () => {
  assert.deepEqual(LRStreetScan.pickStreet(AUTOCOMPLETE, "ההגנה", "פתח תקוה"), {
    title: "ההגנה, פתח תקווה",
    region: "1",
    area: "4",
    city: "7900",
    street: "0220",
  });
  assert.equal(LRStreetScan.pickStreet(AUTOCOMPLETE, "ההגנה", "חולון"), null);
  assert.equal(LRStreetScan.pickStreet({ streets: [] }, "ההגנה", "פתח תקווה"), null);
  // אזור שאין לנו את השם שלו בכתובת – לא נסרק (יד2 הייתה מתעלמת מהרחוב)
  assert.equal(
    LRStreetScan.pickStreet({ streets: [{ ...AUTOCOMPLETE.streets[2], regionId: "99" }] }, "ההגנה", "פתח תקווה"),
    null
  );
});

test("street result URLs use the region slug and add page only after page 1", () => {
  const ids = { region: "3", area: "1", city: "5000", street: "0404" };
  assert.equal(
    LRStreetScan.streetUrl(ids),
    "https://www.yad2.co.il/realestate/forsale/tel-aviv-area?area=1&city=5000&street=0404"
  );
  assert.match(LRStreetScan.streetUrl(ids, 3), /&street=0404&page=3$/);
  assert.equal(LRStreetScan.streetUrl({ ...ids, region: "42" }), null);
});

test("pages to scan follow Yad2's page count up to the user's maximum", () => {
  assert.equal(LRStreetScan.pagesFor(4, 5), 4);
  assert.equal(LRStreetScan.pagesFor(12, 5), 5);
  assert.equal(LRStreetScan.pagesFor(0, 5), 1);
  assert.equal(LRStreetScan.pagesFor(null, 5), 1);
});

test("resolved street ids are cached for a month, including not-found streets", () => {
  const now = Date.UTC(2026, 10, 13);
  const cache = {
    a: { ids: { street: "1" }, at: now - 1000 },
    b: { ids: null, at: now - 1000 },
    c: { ids: { street: "2" }, at: now - 31 * 24 * 3600 * 1000 },
  };
  assert.deepEqual(LRStreetScan.cachedIds(cache, "a", now), { street: "1" });
  assert.equal(LRStreetScan.cachedIds(cache, "b", now), null);
  assert.equal(LRStreetScan.cachedIds(cache, "c", now), undefined);
  assert.equal(LRStreetScan.cachedIds(cache, "missing", now), undefined);
});

test("blocked/favorite street rules ignore full vs short spelling of the city", () => {
  const rules = LRStreetFilter.parseRules(["דוד מאיר גוטמן, פתח תקווה", "שטמפר, פתח תקוה"]);
  assert.ok(LRStreetFilter.match(rules, "דוד מאיר גוטמן 11", "פתח תקוה"));
  assert.ok(LRStreetFilter.match(rules, "שטמפר 5", "פתח תקווה"));
  assert.equal(LRStreetFilter.match(rules, "שטמפר 5", "חולון"), null);
  assert.equal(LRStreetFilter.match(rules, "גוטמן 3", "פתח תקווה"), null); // לא כל המילים של הכלל
});
