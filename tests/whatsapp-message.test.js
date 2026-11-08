const assert = require("node:assert/strict");
const test = require("node:test");

const LRWhatsAppMessage = require("../whatsapp-message.js");

test("WhatsApp message lists all requested property fields in Hebrew", () => {
  const message = LRWhatsAppMessage.format({
    address: "קלישר 10, פתח תקווה",
    price: "₪2,200,000",
    sqm: 87,
    rooms: 4,
    floor: "קומה 4",
    listingCreatedAt: "2026-10-20",
    pricePerSqm: "₪25,287",
    railDistance: "כ-450 מ׳ (מיקום משוער)",
    url: "https://www.madlan.co.il/listings/test-id",
    missingAmenities: ["ממ״ד", "דוד שמש"],
    brokerage: true,
  }, new Date(2026, 10, 8, 15).getTime());

  assert.equal(
    message,
    [
      "כתובת: קלישר 10, פתח תקווה",
      "מחיר: ₪2,200,000",
      'מ"ר: 87',
      "חדרים: 4",
      "קומה: 4",
      "תאריך פרסום: 20/10/2026",
      "גיל המודעה: 19 ימים",
      'מחיר למ"ר: ₪25,287',
      "מרחק בקו אווירי מהרכבת (המרחק בהליכה עשוי להיות גדול יותר): כ-450 מ׳ (מיקום משוער)",
      "קישור למודעה: https://www.madlan.co.il/listings/test-id",
      "שים לב חסר: ממ״ד, דוד שמש",
      "שים לב מדובר במודעת תיווך!",
    ].join("\n")
  );
});

test("WhatsApp message clearly marks unavailable listing fields", () => {
  const message = LRWhatsAppMessage.format({});
  assert.equal(message.split("\n").length, 10);
  assert.ok(message.split("\n").every((line) => line.endsWith("לא זוהה")));
});

test("WhatsApp message writes the floor label once and a readable listing age", () => {
  assert.ok(LRWhatsAppMessage.format({ floor: "קומה קרקע" }).includes("קומה: קרקע\n"));
  assert.ok(LRWhatsAppMessage.format({ floor: "3" }).includes("קומה: 3\n"));
  assert.ok(LRWhatsAppMessage.format({ floor: "קומה 4", buildingTopFloor: 6 }).includes("קומה: 4 מתוך 6\n"));
  assert.ok(LRWhatsAppMessage.format({ shelterMeters: 207 }).includes("מרחק למקלט ציבורי: 207 מ׳"));
  assert.equal(LRWhatsAppMessage.format({}).includes("מקלט"), false);
  assert.ok(LRWhatsAppMessage.format({ realDeals: "בניין −3% · עיר +10%" }).includes('מחיר למ"ר מול עסקאות אמת: בניין −3% · עיר +10%'));
  assert.equal(LRWhatsAppMessage.format({}).includes("עסקאות אמת"), false);
  const now = new Date(2026, 10, 8, 9).getTime();
  assert.equal(LRWhatsAppMessage.ageText("2026-11-08", now), "פורסמה היום");
  assert.equal(LRWhatsAppMessage.ageText("2026-11-07", now), "יום אחד");
  assert.equal(LRWhatsAppMessage.ageText("2026-11-06", now), "יומיים");
  assert.equal(LRWhatsAppMessage.ageText("2026-11-01T10:00:00.000Z", now), "7 ימים");
  assert.equal(LRWhatsAppMessage.ageText("", now), null);
  assert.equal(LRWhatsAppMessage.ageText("bad", now), null);
});

test("WhatsApp message lists only confirmed missing amenities", () => {
  const message = LRWhatsAppMessage.format({
    missingAmenities: ["ממ״ד", "דוד שמש", "ממ״ד", "", null],
  });
  assert.equal(message.endsWith("שים לב חסר: ממ״ד, דוד שמש"), true);
  assert.equal(
    LRWhatsAppMessage.format({ missingAmenities: [] }).includes("שים לב חסר:"),
    false
  );
  assert.equal(
    LRWhatsAppMessage.format({ missingAmenities: null }).includes("שים לב חסר:"),
    false
  );
});

test("WhatsApp message warns about brokerage only when positively identified", () => {
  const warning = "שים לב מדובר במודעת תיווך!";
  assert.equal(LRWhatsAppMessage.format({ brokerage: true }).endsWith(warning), true);
  assert.equal(LRWhatsAppMessage.format({ brokerage: false }).includes(warning), false);
  assert.equal(LRWhatsAppMessage.format({ brokerage: null }).includes(warning), false);
});

test("Floor labels are normalized from Madlan's value-first and label-first layouts", () => {
  assert.equal(LRWhatsAppMessage.normalizeFloor("3\nקומה"), "קומה 3");
  assert.equal(LRWhatsAppMessage.normalizeFloor("3 חדרים\n3\nקומה\n80 מ״ר"), "קומה 3");
  assert.equal(LRWhatsAppMessage.normalizeFloor("קומה 4"), "קומה 4");
  assert.equal(LRWhatsAppMessage.normalizeFloor("4", true), "קומה 4");
  assert.equal(LRWhatsAppMessage.normalizeFloor("4 חד׳"), null);
});

test("Madlan detail floor is preferred over unrelated floor fields elsewhere on the page", () => {
  const floorFields = {
    '[data-auto="Overview-block"] [data-auto="floor"]': { innerText: "3" },
    '[data-auto="floor"]': { innerText: "7\nקומה" },
    '[data-auto="Overview-block"]': { innerText: "3\nקומה" },
  };
  const root = {
    querySelector(selector) {
      return floorFields[selector] || null;
    },
  };
  assert.equal(
    LRWhatsAppMessage.readFloor(root, [
      '[data-auto="Overview-block"] [data-auto="floor"]',
      '[data-auto="floor"]',
    ], '[data-auto="Overview-block"]'),
    "קומה 3"
  );
});

test("Madlan floor can be recovered from its overview text when the field is not separately exposed", () => {
  const root = {
    querySelector(selector) {
      return selector === '[data-auto="Overview-block"]'
        ? { innerText: "3\nחדרים\n3\nקומה\n80\nמ״ר" }
        : null;
    },
  };
  assert.equal(
    LRWhatsAppMessage.readFloor(
      root,
      ['[data-auto="Overview-block"] [data-auto="floor"]'],
      '[data-auto="Overview-block"]'
    ),
    "קומה 3"
  );
});

test("Madlan overview reads the value child next to the explicit floor label", () => {
  const floorValue = { innerText: "16" };
  const floorLabel = { innerText: "קומה" };
  const overviewFloor = {
    firstElementChild: floorValue,
    children: [floorValue, floorLabel],
    innerText: "16\nקומה",
  };
  const overview = {
    querySelector(selector) {
      return selector === '[data-auto="floor"]' ? overviewFloor : null;
    },
  };
  const root = {
    querySelector(selector) {
      return selector === '[data-auto="Overview-block"]' ? overview : null;
    },
  };
  assert.equal(
    LRWhatsAppMessage.readFloor(
      root,
      ['[data-auto="Overview-block"] [data-auto="floor"]'],
      '[data-auto="Overview-block"]'
    ),
    "קומה 16"
  );
});
