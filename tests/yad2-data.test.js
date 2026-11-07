const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LR = require("../parse.js");

function loadYad2(nextData) {
  const document = {
    querySelector: (selector) =>
      selector === "script#__NEXT_DATA__" && nextData
        ? { textContent: JSON.stringify(nextData) }
        : null,
  };
  const sandbox = {
    LR,
    URL,
    console,
    document,
    location: { pathname: "/realestate/forsale", href: "https://www.yad2.co.il/realestate/forsale" },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"), sandbox);
  return { LRYad2: sandbox.LRYad2, document };
}

function card(token, text, price) {
  return {
    innerText: text,
    textContent: text,
    querySelector(selector) {
      if (selector === 'a[href*="/realestate/item/"]') {
        return { href: `https://www.yad2.co.il/realestate/item/center-and-sharon/${token}` };
      }
      if (selector.includes('[data-testid="price"]')) return { innerText: price, textContent: price };
      return null;
    },
  };
}

test("Yad2 previous price comes from priceBeforeTag in the page data", () => {
  const { LRYad2 } = loadYad2({
    props: { items: [{ token: "abc", address: { city: { text: "פתח תקווה" } }, price: 2_620_000, priceBeforeTag: 2_690_000 }] },
  });
  const data = LRYad2.listingExportData(card("abc", "ירד ב-70,000 ₪\n₪ 2,620,000", "₪ 2,620,000"));
  assert.equal(data.previousPrice, 2_690_000);
});

test("without page data (results page opened without reload) it is the card price plus the drop", () => {
  const { LRYad2 } = loadYad2(null);
  const dropped = LRYad2.listingExportData(card("xyz", "ירד ב-100,000 ₪\n‏₪ 2,490,000", "‏₪ 2,490,000"));
  assert.equal(dropped.previousPrice, 2_590_000);
  const unchanged = LRYad2.listingExportData(card("xyz", "₪ 2,490,000", "₪ 2,490,000"));
  assert.equal(unchanged.previousPrice, null);
});
