const assert = require("node:assert/strict");
const test = require("node:test");

const LRLocation = require("../location.js");

test("Google Maps directions use the listing address and station name", () => {
  const url = new URL(
    LRLocation.mapsDirectionsUrl("ביאליק 2, פתח תקווה", "תחנת הרכבת הקלה בילינסון")
  );

  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/maps/dir/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("origin"), "ביאליק 2, פתח תקווה");
  assert.equal(url.searchParams.get("destination"), "תחנת הרכבת הקלה בילינסון");
});

test("Google Maps directions retain coordinate fallback for listings without address text", () => {
  const url = new URL(
    LRLocation.mapsDirectionsUrl({ lat: 32.08, lon: 34.78 }, {
      name: "תחנת הרכבת הקלה בילינסון",
      lat: 32.09,
      lon: 34.79,
    })
  );

  assert.equal(url.searchParams.get("origin"), "32.08,34.78");
  assert.equal(url.searchParams.get("destination"), "תחנת הרכבת הקלה בילינסון");
});

test("Google Maps origin uses the listing city instead of unrelated search context", () => {
  const origin = LRLocation.listingMapsOrigin(
    { street: "הרב פינטו מסעוד אשר 4", city: "פתח תקווה" },
    [
      { q: "הרב פינטו מסעוד אשר 4, מיקומים שנבחרו עד 2" },
      { q: "הרב פינטו מסעוד אשר 4, פתח תקווה" },
    ]
  );
  const url = new URL(
    LRLocation.mapsDirectionsUrl(origin, "תחנת הרכבת הקלה בילינסון")
  );

  assert.equal(origin, "הרב פינטו מסעוד אשר 4, פתח תקווה");
  assert.equal(url.searchParams.get("origin"), "הרב פינטו מסעוד אשר 4, פתח תקווה");
});

test("Google Maps origin rejects Yad2 location-filter text and uses page city", () => {
  const origin = LRLocation.listingMapsOrigin(
    { street: "חיים צבי גרינשטיין", city: "מיקומים שנבחרו עד 2" },
    [{ q: "חיים צבי גרינשטיין, מיקומים שנבחרו עד 2" }],
    "פתח תקווה"
  );
  const url = new URL(
    LRLocation.mapsDirectionsUrl(origin, "תחנת הרכבת הקלה בילינסון")
  );

  assert.equal(origin, "חיים צבי גרינשטיין, פתח תקווה");
  assert.equal(url.searchParams.get("origin"), "חיים צבי גרינשטיין, פתח תקווה");
});

test("Google Maps origin drops filter text when no valid city is available", () => {
  assert.equal(
    LRLocation.listingMapsOrigin(
      { street: "חיים צבי גרינשטיין", city: "מיקומים שנבחרו עד 2" },
      [{ q: "חיים צבי גרינשטיין, מיקומים שנבחרו עד 2" }]
    ),
    "חיים צבי גרינשטיין"
  );
});

test("Google Maps can open from a known street and city even without a house number", () => {
  const address = { street: "גד מכנס", city: "פתח תקווה" };
  const origin = LRLocation.listingMapsOrigin(address);

  assert.equal(origin, "גד מכנס, פתח תקווה");
  assert.equal(LRLocation.hasListingMapsAddress(address), true);
});

test("Google Maps can open from a street-and-city query when parsed address fields are missing", () => {
  const queries = [
    { q: "בעל שם טוב, פתח תקווה", approx: true, bias: false },
  ];
  const origin = LRLocation.listingMapsOrigin(null, queries);
  const url = new URL(
    LRLocation.mapsDirectionsUrl(origin, "תחנה מרכזית פתח תקווה")
  );

  assert.equal(origin, "בעל שם טוב, פתח תקווה");
  assert.equal(LRLocation.hasListingMapsAddress(null, queries), true);
  assert.equal(url.searchParams.get("origin"), "בעל שם טוב, פתח תקווה");
});

test("Google Maps does not open when a listing address is unavailable", () => {
  assert.equal(LRLocation.hasListingMapsAddress(null, [], "פתח תקווה"), false);
  assert.equal(
    LRLocation.hasListingMapsAddress(
      { street: null, city: "פתח תקווה" },
      [{ q: "פתח תקווה", cityOnly: true }]
    ),
    false
  );
  assert.equal(
    LRLocation.hasListingMapsAddress(
      { street: "גד מכנס", city: null },
      [{ q: "גד מכנס" }]
    ),
    false
  );
});

test("Google Maps station queries do not duplicate an existing station label", () => {
  assert.equal(
    LRLocation.stationMapsQuery("תחנת בילינסון"),
    "תחנת בילינסון"
  );
  assert.equal(
    LRLocation.stationMapsQuery("Bilinson"),
    "תחנת הרכבת הקלה Bilinson"
  );
});
