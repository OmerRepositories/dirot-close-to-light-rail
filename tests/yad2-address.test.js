const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LR = require("../parse.js");
const context = {
  LR,
  URL,
  document: { querySelector: () => null },
  location: {
    pathname: "/realestate/item/center-and-sharon/v3y00p91",
    href: "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91?source=test",
  },
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
  context
);

function readCardAddress(address, text) {
  const root = {
    querySelector(selector) {
      if (selector === 'a[href*="/realestate/item/"]') {
        return { href: "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91" };
      }
      if (selector.includes('data-testid="ad-card-address"')) {
        return { innerText: address };
      }
      return null;
    },
  };
  return context.LRYad2.readAddress(root, text, null, false);
}

test("Yad2 search cards use locality shown outside the address line", () => {
  const text = [
    "2,310,000 ₪",
    "ביאליק 2",
    "דירה, מחנה יהודה, פתח תקווה",
    "4 חדרים • קומה 1 • 103 מ״ר",
  ].join("\n");
  const parsed = readCardAddress("ביאליק 2", text);

  assert.equal(parsed.street, "ביאליק 2");
  assert.equal(parsed.city, "פתח תקווה");
  assert.equal(parsed.hood, "מחנה יהודה");
  assert.deepEqual(parsed.queries[0], {
    q: "ביאליק 2, פתח תקווה",
    approx: false,
    bias: false,
  });
});

test("Yad2 listing price extraction prefers the current price over the previous tagged price", () => {
  const root = {
    querySelector(selector) {
      assert.equal(
        selector,
        '[data-testid="current-price"] [data-testid="price"]'
      );
      return { innerText: "2,090,000 ₪" };
    },
  };
  const stats = context.LRYad2.extractPriceSqm(
    root,
    "2,190,000 ₪ 2,090,000 ₪ 100 מ״ר"
  );

  assert.equal(stats.price, 2_090_000);
  assert.equal(stats.sqm, 100);
  assert.equal(stats.ppsm, 20_900);
});

test("Yad2 does not replace a focused address with a conflicting house number", () => {
  const text = [
    "ביאליק 3",
    "דירה, מחנה יהודה, פתח תקווה",
  ].join("\n");
  const parsed = readCardAddress("ביאליק 2", text);

  assert.equal(parsed.street, "ביאליק 2");
  assert.equal(parsed.queries.some((query) => query.q === "ביאליק 3, פתח תקווה"), false);
});

test("Yad2 search cards preserve the displayed house number when structured data omits it", () => {
  const parsed = readCardAddress(
    "מיכל לייב כץ 64",
    [
      "₪ 2,650,000",
      "מיכל לייב כץ 64",
      "דירה, כפר גנים ב, פתח תקווה",
      "4.5 חדרים • קומה 2 • 110 מ״ר",
    ].join("\n")
  );

  assert.equal(parsed.street, "מיכל לייב כץ 64");
  assert.equal(parsed.city, "פתח תקווה");
  assert.ok(parsed.queries.some((query) => query.q === "מיכל לייב כץ 64, פתח תקווה"));
});

test("Yad2 multi-neighborhood cards use each listing's street and city", () => {
  const listingData = {
    token: "listing-multi",
    address: {
      street: { text: "רחוב שגוי" },
      house: { number: "9" },
      city: { text: "עיר שגויה" },
      coords: { lat: 32.09, lon: 34.89 },
    },
  };
  const cardContext = {
    LR,
    URL,
    document: {
      querySelector: () => ({
        textContent: JSON.stringify({
          props: { pageProps: { listings: [listingData] } },
        }),
      }),
    },
    location: {
      pathname: "/realestate/forsale/center-and-sharon",
      href: "https://www.yad2.co.il/realestate/forsale/center-and-sharon?multiNeighborhood=777%2C766%2C761",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    cardContext
  );
  const card = {
    querySelector(selector) {
      if (selector === 'a[href*="/realestate/item/"]') {
        return { href: "https://www.yad2.co.il/realestate/item/center-and-sharon/listing-multi" };
      }
      if (selector === '[data-testid="street-name"]') {
        return { innerText: "יהושע שטמפפר " };
      }
      if (selector === '[data-testid="item-info-line-1st"]') {
        return { innerText: "דירה, שיפר, פתח תקווה" };
      }
      return null;
    },
  };

  const address = cardContext.LRYad2.readAddress(card, "", null, false);
  assert.equal(address.street, "יהושע שטמפפר");
  assert.equal(address.city, "פתח תקווה");
  assert.equal(address.hood, "שיפר");
  assert.equal(address.coordinates.lat, 32.09);
  assert.equal(address.coordinates.lon, 34.89);
  assert.equal(address.queries[0].q, "יהושע שטמפפר, פתח תקווה");
});

test("Yad2 listing export reads rooms and published/updated dates", () => {
  const listingData = {
    token: "v3y00p91",
    address: {
      street: { text: "ביאליק" },
      city: { text: "פתח תקווה" },
    },
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
  context.document.querySelector = (selector) =>
    selector === 'script#__NEXT_DATA__'
      ? {
          textContent: JSON.stringify({
            props: { pageProps: { listing: listingData } },
          }),
        }
      : null;
  const root = {
    querySelector(selector) {
      if (selector === 'a[href*="/realestate/item/"]') {
        return { href: "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91" };
      }
      if (selector === '[data-testid="building-text"]') return { innerText: "4" };
      if (selector === '[data-testid="report-ad-label"]') {
        return { innerText: "פורסם ב ‏14/10/26" };
      }
      return null;
    },
  };

  const metadata = context.LRYad2.listingExportData(root);
  assert.equal(metadata.rooms, 4);
  assert.equal(metadata.listingCreatedAt, "14/10/26");
  assert.equal(metadata.listingUpdatedAt, "2026-10-20T12:00:00.000Z");
  context.document.querySelector = () => null;
});

test("Yad2 listing status detects an explicitly removed listing", () => {
  const removedContext = {
    LR,
    URL,
    document: {
      body: { innerText: "חיפשנו בכל מקום אבל אין לנו עמוד כזה" },
      querySelector: () => null,
    },
    location: {
      pathname: "/realestate/item/center-and-sharon/6huup2do",
      href: "https://www.yad2.co.il/realestate/item/center-and-sharon/6huup2do",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    removedContext
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(removedContext.LRYad2.listingPageStatus())),
    { id: "6huup2do", status: "removed" }
  );
});

test("Yad2 listing status marks a listing active only with matching listing data", () => {
  const activeContext = {
    LR,
    URL,
    document: {
      body: { innerText: "מודעה למכירה" },
      querySelector: (selector) =>
        selector === "script#__NEXT_DATA__"
          ? {
              textContent: JSON.stringify({
                props: {
                  pageProps: {
                    listing: {
                      token: "6huup2do",
                      address: { city: { text: "פתח תקווה" } },
                    },
                  },
                },
              }),
            }
          : null,
    },
    location: {
      pathname: "/realestate/item/center-and-sharon/6huup2do",
      href: "https://www.yad2.co.il/realestate/item/center-and-sharon/6huup2do",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    activeContext
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(activeContext.LRYad2.listingPageStatus())),
    { id: "6huup2do", status: "active" }
  );
});

test("Yad2 listing status stays unknown without explicit removal or listing data", () => {
  const unknownContext = {
    LR,
    URL,
    document: { body: { innerText: "העמוד נטען" }, querySelector: () => null },
    location: {
      pathname: "/realestate/item/center-and-sharon/6huup2do",
      href: "https://www.yad2.co.il/realestate/item/center-and-sharon/6huup2do",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    unknownContext
  );

  assert.equal(unknownContext.LRYad2.listingPageStatus(), null);
});

test("city-only geocoding queries are explicitly marked as not being an address", () => {
  const parsed = LR.parseAddress("", "פתח תקווה");

  assert.equal(parsed.queries.length, 1);
  assert.deepEqual(parsed.queries[0], {
    q: "פתח תקווה",
    approx: true,
    bias: false,
    cityOnly: true,
  });
});

test("Yad2 first-hand project detail pages are recognized", () => {
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636"), true);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/18636/"), true);
  assert.equal(context.LRYad2.isProjectPage("/realestate/item/center-and-sharon/v3y00p91"), false);
  assert.equal(context.LRYad2.isProjectPage("/yad1/project/"), false);
  assert.equal(context.LRYad2.isProjectListingPage("/yad1"), true);
  assert.equal(context.LRYad2.isProjectListingPage("/yad1/"), true);
  assert.equal(context.LRYad2.isProjectListingPage("/yad1/project/18636"), false);
  assert.equal(
    context.LRYad2.listingUrl(context.document),
    "https://www.yad2.co.il/realestate/item/center-and-sharon/v3y00p91?source=test"
  );
});

test("Yad2 project pages use the project address and exact coordinates", () => {
  const project = {
    id: 18636,
    street: { name: "יהושע שטמפפר" },
    city: { name: "פתח תקווה" },
    houseNumber: "81",
    x: 34.89127731323242,
    y: 32.09439468383789,
  };
  const projectAddress = { innerText: "יהושע שטמפפר 81, פתח תקווה" };
  const projectContext = {
    LR,
    URL,
    location: {
      pathname: "/yad1/project/18636",
      href: "https://www.yad2.co.il/yad1/project/18636",
    },
    document: {
      querySelector(selector) {
        if (selector === 'script#__NEXT_DATA__') {
          return {
            textContent: JSON.stringify({
              props: {
                pageProps: {
                  grayProject: project,
                  project: {
                    token: "18636",
                    projectName: "שטמפפר 81",
                    address: {
                      display: "יהושע שטמפפר 81, פתח תקווה",
                      city: { text: "פתח תקווה" },
                      neighborhood: { text: "שיפר" },
                      coords: { lat: 32.094394, lon: 34.891279 },
                    },
                    additionalDetails: {
                      minPrice: 1790000,
                      maxPrice: 1790000,
                      minSquaremeter: 47,
                      maxSquaremeter: 120,
                      roomsCount: 5,
                    },
                  },
                },
              },
            }),
          };
        }
        return null;
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "yad2.js"), "utf8"),
    projectContext
  );
  const root = {
    querySelector(selector) {
      return selector === '[data-testid="project-address"]' ? projectAddress : null;
    },
  };
  root.querySelector = (selector) => {
    if (selector === '[data-testid="project-address"]') return projectAddress;
    if (selector === '[data-testid="project-title"], h1') {
      return { innerText: "פרויקט שטמפפר 81 פתח תקווה" };
    }
    return null;
  };

  const parsed = projectContext.LRYad2.readAddress(
    root,
    "פרויקט שטמפפר 81 פתח תקווה | פרויקטים חדשים",
    null,
    true
  );
  assert.equal(parsed.street, "יהושע שטמפפר 81");
  assert.equal(parsed.city, "פתח תקווה");
  assert.deepEqual(parsed.queries[0], {
    q: "יהושע שטמפפר 81, פתח תקווה",
    approx: false,
    bias: false,
  });
  assert.equal(parsed.coordinates.lat, 32.09439468383789);
  assert.equal(parsed.coordinates.lon, 34.89127731323242);
  assert.equal(
    parsed.queries.some((query) => query.q.includes("פרויקטים חדשים")),
    false
  );
  const projectExport = projectContext.LRYad2.projectExportData(root, "text");
  assert.equal(projectExport.id, "18636");
  assert.equal(projectExport.recordType, "project");
  assert.equal(projectExport.price, 1790000);
  assert.equal(projectExport.maxPrice, 1790000);
  assert.equal(projectExport.sqm, 47);
  assert.equal(projectExport.maxSqm, 120);
  assert.equal(projectExport.pricePerSqm, Math.round(1790000 / 47));
  assert.equal(projectExport.rooms, 5);
});

test("Madlan project detail pages are recognized", () => {
  const projectAddress = {
    innerText: "יהושע שטמפפר 81, פתח תקווה",
  };
  let hasProjectAddress = false;
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector(selector) {
        return hasProjectAddress && selector === '[data-testid="project-address"]'
          ? projectAddress
          : null;
      },
    },
    URL,
    location: {
      pathname: "/listings/ad-456",
      href: "https://www.madlan.co.il/listings/ad-456",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );

  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/example_project"), true);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/example_project/"), true);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/listing-id"), false);
  assert.equal(madlanContext.LRMadlan.isProjectPage("/projects/"), false);
  assert.equal(
    madlanContext.LRMadlan.isProjectListingPage("/projects-for-sale/ישראל"),
    true
  );
  assert.equal(
    madlanContext.LRMadlan.isProjectListingPage("/projects-for-rent/ישראל"),
    true
  );
  assert.equal(
    madlanContext.LRMadlan.isProjectListingPage("/projects/example_project"),
    false
  );
  assert.equal(
    madlanContext.LRMadlan.listingUrl(madlanContext.document),
    "https://www.madlan.co.il/listings/ad-456"
  );
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/ad-456"), false);
  hasProjectAddress = true;
  assert.equal(madlanContext.LRMadlan.isProjectPage("/listings/ad-456"), true);
  madlanContext.location.pathname = "/projects/example_project";
  madlanContext.location.href = "https://www.madlan.co.il/projects/example_project";
  const address = madlanContext.LRMadlan.readAddress(
    madlanContext.document,
    "",
    null,
    true
  );
  assert.equal(address.street, "יהושע שטמפפר 81");
  assert.equal(address.city, "פתח תקווה");
  assert.ok(address.queries.some((query) => query.q === "יהושע שטמפפר 81, פתח תקווה"));
});

test("Madlan listing export reads room count and releaseDate from its listing payload", () => {
  const script = {
    textContent: JSON.stringify({
      listing: {
        id: "madlan-123",
        releaseDate: "2026-10-14T08:30:00.000Z",
        updatedAt: "2026-10-20T12:00:00.000Z",
      },
    }),
  };
  const madlanContext = {
    LR,
    document: {
      scripts: [script],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/listings/madlan-123",
      href: "https://www.madlan.co.il/listings/madlan-123",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="beds-count"]') return null;
      return selector === '[data-auto="property-rooms"]'
        ? { innerText: "4 חד׳" }
        : null;
    },
  };

  const metadata = madlanContext.LRMadlan.listingExportData(root);
  assert.equal(metadata.rooms, 4);
  assert.equal(metadata.listingCreatedAt, "2026-10-14T08:30:00.000Z");
  assert.equal(metadata.listingUpdatedAt, "2026-10-20T12:00:00.000Z");
  madlanContext.document.querySelector = (selector) =>
    selector === '[data-auto="property-rooms"]' ? { innerText: "8 חד׳" } : null;
  assert.equal(madlanContext.LRMadlan.listingExportData(madlanContext.document).rooms, null);
});

test("Madlan search context uses a single city and ignores combined-area searches", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
      href: "https://www.madlan.co.il/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );

  assert.equal(
    madlanContext.LRMadlan.searchCityContext(
      "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
      "דירות למכירה בשיפר, פתח תקווה - 86 דירות"
    ),
    "פתח תקווה"
  );
  assert.equal(
    madlanContext.LRMadlan.searchCityContext(
      "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל,בת-ים-ישראל",
      "דירות למכירה בשיפר, פתח תקווה ובת ים"
    ),
    null
  );
  assert.equal(
    madlanContext.LRMadlan.searchCityContext(
      "/for-sale/רפאלי-שרגא-פתח-תקווה-ישראל",
      "דירות למכירה ברחוב רפאלי שרגא, פתח תקווה"
    ),
    "פתח תקווה"
  );
});

test("Madlan listing cards use the image alt address instead of promotional badges", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/realestate/for-sale",
      href: "https://www.madlan.co.il/realestate/for-sale",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const addressImage = { alt: "הירקונים 5, פתח תקווה" };
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="universal-card-image"][alt]') return addressImage;
      if (selector === '[data-auto="property-address"]') {
        return { innerText: "דופלקס, הירקונים, שיפר" };
      }
      return null;
    },
  };

  const address = madlanContext.LRMadlan.readAddress(
    root,
    "Top10 במדד המתווכים",
    null,
    false
  );

  assert.equal(address.street, "הירקונים 5");
  assert.equal(address.city, "פתח תקווה");
  assert.ok(address.queries.some((query) => query.q === "הירקונים 5, פתח תקווה"));
});

test("Madlan card falls back from an empty image alt to its structured address", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
      href: "https://www.madlan.co.il/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="universal-card-image"][alt]') {
        return { alt: "" };
      }
      if (selector === '[data-auto="property-address"]') {
        return { innerText: "דירה, הירקונים 11, שיפר" };
      }
      return null;
    },
  };

  const address = madlanContext.LRMadlan.readAddress(
    root,
    "Top10 במדד המתווכים",
    "פתח תקווה",
    false
  );
  assert.equal(address.street, "הירקונים 11");
  assert.equal(address.city, "פתח תקווה");
  assert.equal(address.hood, "שיפר");
  assert.ok(address.queries.some((query) => query.q === "הירקונים 11, פתח תקווה"));
});

test("Madlan combined-area cards without a city or exact coordinates are not geocoded", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל,בת-ים-ישראל",
      href: "https://www.madlan.co.il/for-sale/שכונה-שיפר-פתח-תקווה-ישראל,בת-ים-ישראל",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="universal-card-image"][alt]') {
        return { alt: "" };
      }
      if (selector === '[data-auto="property-address"]') {
        return { innerText: "דירה, רחוב לדוגמה 12, שכונה לדוגמה" };
      }
      return null;
    },
  };

  const address = madlanContext.LRMadlan.readAddress(
    root,
    "דירה, רחוב לדוגמה 12, שכונה לדוגמה",
    null,
    false
  );
  assert.equal(address.street, "לדוגמה 12");
  assert.equal(address.city, null);
  assert.equal(address.queries.length, 0);
});

test("Madlan listing card fallback ignores the Top10 broker index label", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/realestate/for-sale",
      href: "https://www.madlan.co.il/realestate/for-sale",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = { querySelector: () => null };
  const address = madlanContext.LRMadlan.readAddress(
    root,
    "Top10 במדד המתווכים",
    null,
    false
  );
  assert.equal(address.street, null);
  assert.deepEqual(address.queries, []);
});

test("Madlan detail area extraction accepts a value followed by its unit label", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/listings/BhAQrcw3hLo",
      href: "https://www.madlan.co.il/listings/BhAQrcw3hLo",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="area"]') {
        return { innerText: '100\nמ"ר' };
      }
      if (selector === '[data-auto="current-price"]') {
        return { innerText: "‏2,000,000 ‏₪" };
      }
      return null;
    },
  };

  const stats = madlanContext.LRMadlan.extractPriceSqm(root, "");
  assert.equal(stats.price, 2000000);
  assert.equal(stats.sqm, 100);
  assert.equal(stats.ppsm, 20000);
});

test("Madlan listing cards use structured price and area fields", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
      href: "https://www.madlan.co.il/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const root = {
    querySelector(selector) {
      if (selector === '[data-auto="property-size"]') return { innerText: '138 מ"ר' };
      if (selector === '[data-auto="property-price"]') return { innerText: "‏2,950,000 ‏₪" };
      return null;
    },
  };

  const stats = madlanContext.LRMadlan.extractPriceSqm(
    root,
    "Top10 במדד המתווכים"
  );
  assert.equal(stats.price, 2950000);
  assert.equal(stats.sqm, 138);
  assert.equal(stats.ppsm, Math.round(2950000 / 138));

  madlanContext.document.querySelector = (selector) => {
    if (selector === '[data-auto="area"]') return { innerText: '100 מ"ר' };
    if (selector === '[data-auto="property-size"]') return { innerText: '90 מ"ר' };
    if (selector === '[data-auto="current-price"]') return { innerText: "‏2,000,000 ‏₪" };
    if (selector === '[data-auto="property-price"]') return { innerText: "‏1,000,000 ‏₪" };
    return null;
  };
  const detailStats = madlanContext.LRMadlan.extractPriceSqm(
    madlanContext.document,
    ""
  );
  assert.equal(detailStats.price, 2000000);
  assert.equal(detailStats.sqm, 100);
});

test("Madlan listing cards prefer structured coordinates and address from hydrated listing data", () => {
  const listingId = "listing-with-exact-address";
  const madlanContext = {
    LR,
    document: {
      scripts: [
        {
          textContent: JSON.stringify({
            id: listingId,
            locationPoint: { lat: 32.09826820371908, lng: 34.89619280439136 },
            addressDetails: {
              city: "פתח תקווה",
              streetName: "הירקונים",
              streetNumber: "9",
            },
          }),
        },
      ],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
      href: "https://www.madlan.co.il/for-sale/שכונה-שיפר-פתח-תקווה-ישראל",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );
  const link = {
    href: `https://www.madlan.co.il/listings/${listingId}`,
  };
  const root = {
    querySelector(selector) {
      return selector.includes("listed-bulletin-clickable") ? link : null;
    },
    querySelectorAll: () => [],
  };

  const address = madlanContext.LRMadlan.readAddress(
    root,
    "דירה, הירקונים 9, שיפר",
    null,
    false
  );
  assert.equal(address.street, "הירקונים 9");
  assert.equal(address.city, "פתח תקווה");
  assert.deepEqual(
    JSON.parse(JSON.stringify(address.coordinates)),
    { lat: 32.09826820371908, lon: 34.89619280439136 }
  );
});

test("Madlan project pages never geocode the full page text as an address", () => {
  const madlanContext = {
    LR,
    document: {
      scripts: [],
      querySelector: () => null,
    },
    URL,
    location: {
      pathname: "/projects/example_project",
      href: "https://www.madlan.co.il/projects/example_project",
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "madlan.js"), "utf8"),
    madlanContext
  );

  const address = madlanContext.LRMadlan.readAddress(
    madlanContext.document,
    "פרויקטים חדשים יהודה | פרויקט שטמפפר 81 פתח תקווה ועוד טקסטים",
    null,
    true
  );
  assert.deepEqual(address.queries, []);
});
