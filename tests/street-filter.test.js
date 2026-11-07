const assert = require("node:assert/strict");
const test = require("node:test");

const F = require("../street-filter.js");

test("a blocked street matches the full street name and house number", () => {
  const rules = F.parseRules(["שטמפר"]);
  assert.ok(F.match(rules, "יהושע שטמפר 12", "פתח תקווה"));
  assert.ok(F.match(rules, "שטמפר", "פתח תקווה"));
  assert.ok(F.match(rules, "רחוב שטמפר 5א", ""));
});

test("matching uses whole words only", () => {
  const rules = F.parseRules(["הרצל"]);
  assert.equal(F.match(rules, "הרצליה", "תל אביב"), null);
  assert.ok(F.match(rules, "הרצל 3", "ראשון לציון"));
});

test("quotes, gershayim and hyphens are ignored", () => {
  const rules = F.parseRules(["בן-גוריון"]);
  assert.ok(F.match(rules, "בן גוריון 7", "רמת גן"));
  assert.ok(F.match(F.parseRules(["ז'בוטינסקי"]), "זבוטינסקי 40", "פתח תקווה"));
  assert.ok(F.match(F.parseRules(["רש״י"]), 'רש"י 2', "ירושלים"));
});

test("a city after a comma limits the rule to that city", () => {
  const rules = F.parseRules(["ז'בוטינסקי, פתח תקווה"]);
  assert.ok(F.match(rules, "ז'בוטינסקי 40", "פתח תקווה"));
  assert.equal(F.match(rules, "ז'בוטינסקי 40", "רמת גן"), null);
});

test("an empty street or an empty rule list never blocks", () => {
  assert.equal(F.match(F.parseRules(["שטמפר"]), "", "פתח תקווה"), null);
  assert.equal(F.match(F.parseRules([]), "שטמפר 1", "פתח תקווה"), null);
  assert.deepEqual(F.parseRules(["", "  ", ","]), []);
});

test("settings input is split into unique lines", () => {
  assert.deepEqual(F.parseInput("שטמפר\n\n  הרצל  \nשטמפר\r\nבן גוריון, רמת גן"), [
    "שטמפר",
    "הרצל",
    "בן גוריון, רמת גן",
  ]);
});

test("cityAllowed accepts every city when the list is empty", () => {
  assert.equal(F.cityAllowed([], "חיפה"), true);
  assert.equal(F.cityAllowed(undefined, ""), true);
});

test("cityAllowed matches listed cities and ignores spelling variants", () => {
  const cities = ["פתח תקווה", "רמת גן"];
  assert.equal(F.cityAllowed(cities, "פתח תקוה"), true);
  assert.equal(F.cityAllowed(cities, "רמת-גן"), true);
  assert.equal(F.cityAllowed(cities, "גבעתיים"), false);
  assert.equal(F.cityAllowed(cities, "רמת השרון"), false);
  assert.equal(F.cityAllowed(cities, ""), false);
  assert.equal(F.cityAllowed(["תל אביב"], "תל אביב יפו"), true);
  assert.equal(F.cityAllowed(["תל אביב יפו"], "תל אביב"), true);
});
