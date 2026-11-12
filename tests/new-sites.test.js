const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(file, location) {
  const sandbox = { URL, URLSearchParams, location, document: { querySelector: () => null, querySelectorAll: () => [] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), sandbox);
  return sandbox;
}

test("Komo: each listing gets its own path (the id is in modaaNum), and relative update dates", () => {
  const { LRKomo } = load("komo.js", { href: "https://www.komo.co.il/code/nadlan/apartments-for-sale.asp?cityName=x", search: "?nehes=1&cityName=%D7%A4%D7%AA%D7%97+%D7%AA%D7%A7%D7%95%D7%95%D7%94", pathname: "/code/nadlan/apartments-for-sale.asp" });
  assert.equal(LRKomo.listingPathFromUrl("https://www.komo.co.il/code/nadlan/details/?modaaNum=4960999"), "/code/nadlan/details/modaaNum=4960999");
  assert.ok(LRKomo.LISTING_HREF.test(LRKomo.listingPathFromUrl("/code/nadlan/details/?modaaNum=1")));
  assert.equal(LRKomo.LISTING_HREF.test(LRKomo.listingPathFromUrl("/code/nadlan/apartments-for-sale.asp?nehes=1")), false);
  assert.equal(LRKomo.searchCityContext(), "פתח תקווה");
  const now = new Date("2026-11-12T10:00:00Z");
  assert.equal(LRKomo.relativeUpdatedDate("עודכן לפני: 1 ימים", now), "2026-11-11");
  assert.equal(LRKomo.relativeUpdatedDate("עודכן לפני: 3 שעות", now), "2026-11-12");
  assert.equal(LRKomo.relativeUpdatedDate("עודכן לפני: 2 חודשים", now), "2026-09-12");
  assert.equal(LRKomo.relativeUpdatedDate("עודכן לפני שנה", now), "2025-11-12");
  assert.equal(LRKomo.relativeUpdatedDate("ללא תאריך", now), null);
});

test("Homeless: listing links and the city from the search URL", () => {
  const { LRHomeless } = load("homeless.js", { href: "https://www.homeless.co.il/sale/city=%D7%A4%D7%AA%D7%97%20%D7%AA%D7%A7%D7%95%D7%95%D7%94", pathname: "/sale/city=%D7%A4%D7%AA%D7%97%20%D7%AA%D7%A7%D7%95%D7%95%D7%94" });
  assert.ok(LRHomeless.LISTING_HREF.test("/sale/viewad,263976.aspx"));
  assert.equal(LRHomeless.LISTING_HREF.test("/sale/city=x"), false);
  assert.equal(LRHomeless.searchCityContext("/sale/city=%D7%A4%D7%AA%D7%97%20%D7%AA%D7%A7%D7%95%D7%95%D7%94"), "פתח תקווה");
});

test("all four sites are listing sites with labels", () => {
  const CacheData = require("../cache-data.js");
  assert.deepEqual([...CacheData.LISTING_SITES], ["yad2", "madlan", "homeless", "komo"]);
  assert.equal(CacheData.siteLabel("homeless"), "הומלס");
  assert.equal(CacheData.siteLabel("komo"), "קומו");
  assert.equal(CacheData.listingStatusKey("komo", {}, false), "unchecked");
  const Export = require("../cache-export.js");
  assert.equal(Export.recordUrl("homeless", "263976", {}), "https://www.homeless.co.il/sale/viewad,263976.aspx");
  assert.equal(Export.recordUrl("komo", "4960999", {}), "https://www.komo.co.il/code/nadlan/details/?modaaNum=4960999");
});
