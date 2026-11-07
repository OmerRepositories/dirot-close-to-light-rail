const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LR = require("../parse.js");
const CacheData = require("../cache-data.js");

// דף מדלן מצומצם: האובייקט __SSR_HYDRATED_CONTEXT__ הוא JavaScript (יש בו undefined), לא JSON
function madlanPage(listings, pathname = "/listings/AbC123") {
  const context = {
    reduxInitialState: {
      domainData: {
        searchList: { data: { searchPoiV2: { poi: listings } } },
      },
    },
  };
  const source = `window.__SSR_HYDRATED_CONTEXT__=${JSON.stringify(context).replace(
    '"isCodeFrozen":null',
    '"isCodeFrozen":undefined'
  )};`;
  const document = { scripts: [{ textContent: source }], querySelector: () => null };
  const sandbox = {
    LR,
    URL,
    document,
    location: { pathname, href: `https://www.madlan.co.il${pathname}` },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"), sandbox);
  return { LRMadlan: sandbox.LRMadlan, document };
}

const LISTING = {
  id: "AbC123",
  locationPoint: { lat: 32.09, lng: 34.87 },
  firstTimeSeen: "2024-08-06T07:07:00.000Z",
  lastUpdated: "Fri Oct 30 09:47:37 GMT 2026",
  isCodeFrozen: null,
  eventsHistory: [
    { eventType: "priceDrop", price: 3_150_000, date: "2024-08-18T08:38:50Z" },
    { eventType: "new", price: 3_230_000, date: "2024-08-06T07:07:51Z" },
    { eventType: "priceDrop", price: 3_000_000, date: "2026-04-09T02:48:37Z" },
  ],
};

test("Madlan listing age comes from firstTimeSeen and price history from eventsHistory", () => {
  const { LRMadlan, document } = madlanPage([{ id: "Other", locationPoint: { lat: 1, lng: 1 } }, LISTING]);
  const data = LRMadlan.listingExportData(document);
  assert.equal(data.listingCreatedAt, "2024-08-06T07:07:00.000Z");
  assert.equal(data.listingUpdatedAt, "Fri Oct 30 09:47:37 GMT 2026");
  assert.deepEqual(
    Array.from(data.priceEvents, (event) => event.price),
    [3_230_000, 3_150_000, 3_000_000],
    "sorted by date"
  );
});

test("a Madlan listing missing from the page data (page changed without reload) has no site history", () => {
  const { LRMadlan, document } = madlanPage([LISTING], "/listings/NotOnPage");
  const data = LRMadlan.listingExportData(document);
  assert.equal(data.priceEvents, null);
  assert.equal(data.listingCreatedAt, null);
});

test("site history replaces older own observations and keeps newer ones", () => {
  const events = [
    { price: 3_230_000, at: 100 },
    { price: 3_150_000, at: 200 },
    { price: 3_000_000, at: 300 },
  ];
  const stored = [
    { price: 3_150_000, at: 250, src: "page", baselineKnown: true },
    { price: 3_000_000, at: 350, src: "search" },
    { price: 2_950_000, at: 400, src: "page" },
  ];
  const merged = CacheData.mergeSiteHistory(stored, events);
  assert.deepEqual(merged, [
    { price: 3_230_000, at: 100, src: "site", baselineKnown: true },
    { price: 3_150_000, at: 200, src: "site" },
    { price: 3_000_000, at: 300, src: "site" },
    { price: 2_950_000, at: 400, src: "page" },
  ]);
  assert.equal(CacheData.mergeSiteHistory(merged, events), null, "idempotent");
  assert.equal(CacheData.mergeSiteHistory(stored, []), null);
  const pressure = CacheData.sellerPressure({ listingAgeDays: 400, priceHistory: merged });
  assert.equal(pressure.drops, 3);
  assert.equal(pressure.level, "high");
});

test("the crossed-out previous price on a Madlan card is added to the price history once", () => {
  const record = CacheData.withCardPreviousPrice({}, 3_700_000, 3_590_000);
  const observed = CacheData.recordPriceObservation(record, 3_590_000, 1000, { source: "search", sqm: 100 });
  assert.equal(observed.accepted, true);
  assert.deepEqual(observed.priceHistory, [
    { price: 3_700_000, at: null, baselineUnknown: true, src: "card" },
    { price: 3_590_000, at: 1000, src: "search" },
  ]);
  const again = CacheData.withCardPreviousPrice({ ...record, ...observed }, 3_700_000, 3_590_000);
  assert.equal(again.priceHistory, observed.priceHistory, "not added twice");
  assert.equal(CacheData.sellerPressure({ priceHistory: observed.priceHistory }).drops, 1);
  // לא נוסף: מחיר קודם נמוך מהנוכחי, ירידה לא סבירה, או היסטוריה שכבר באה מהאתר
  const base = { priceHistory: [] };
  assert.equal(CacheData.withCardPreviousPrice(base, 2_000_000, 2_100_000), base);
  assert.equal(CacheData.withCardPreviousPrice(base, 5_000_000, 2_000_000), base);
  const fromSite = { priceHistory: [{ price: 3_590_000, at: 5, src: "site" }] };
  assert.equal(CacheData.withCardPreviousPrice(fromSite, 3_700_000, 3_590_000), fromSite);
});

test("the previous price on a Madlan card is read separately and not taken as the price", () => {
  const { LRMadlan } = madlanPage([]);
  const element = (text) => ({ textContent: text, innerText: text });
  const card = {
    closest: () => null,
    querySelector(selector) {
      if (selector === '[data-auto="property-prevous-price"]') return element("\u200F3,700,000 \u200F₪");
      return null;
    },
    querySelectorAll: () => [],
  };
  assert.equal(LRMadlan.listingExportData(card).previousPrice, 3_700_000);
  const stats = LRMadlan.extractPriceSqm(card, "\u200F3,700,000 \u200F₪\n\u200F3,590,000 \u200F₪\n4 חד׳\n95 מ״ר");
  assert.equal(stats.price, 3_590_000);
});
