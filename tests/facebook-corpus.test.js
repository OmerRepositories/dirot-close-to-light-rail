// Real-world style Facebook group posts (anonymized, collected 2026-11-12 from a Petah Tikva sale group):
// names, phones and links removed. Each case = what the extension should conclude.
const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.LR = require("../parse.js");
const classify = require("../facebook-classifier.js");
const LR = globalThis.LR;

const cases = [
  {
    name: "tenanted apartment for sale (rent amount in the text, no 'for sale' word)",
    type: "listing",
    text: `הזדמנות למשקיעים בלב פתח תקווה
דירת 3 חדרים ברחוב ברון הירש 8, בשטח של כ־61 מ"ר, בקומה 2.
הדירה מושכרת כיום ב־5,500 ₪ לחודש, ובמיקום מרכזי.
מחיר: 1,650,000 ₪`,
  },
  {
    name: "divided apartment that yields rent, 'exclusive' instead of 'for sale'",
    type: "listing",
    text: `חדש בבלעדיות! הזדמנות השקעה נדירה לפני פינוי בינוי
רחוב ההגנה 25, פתח תקווה
דירת 4 חדרים, קומה 2, 87 מ"ר בנוי
הנכס מושכר כיום ל-3 שותפים ומניב 7,800 ₪ בחודש מהרגע הראשון!
מחיר שיווק: 1,990,000 ₪`,
  },
  { name: "sold announcement", type: "other", text: `נמכר! נמכר! נמכר!\nדירת 4 חדרים ברחוב ברנר, פתח תקווה!\nתודה למוכרים ולקונים` },
  { name: "sold – off the shelf", type: "other", text: `טרומפלדור 24 – ירדה מהמדף!\nנמכרה לשביעות רצונם של שני הצדדים` },
  { name: "sold – spelled out", type: "other", text: `נ-מ-כ-ר\nגם דירת ה - 3 חדרים ברחוב צפת 96 עברה לסטטוס נ - מ - כ - ר` },
  {
    name: "offices are not apartments",
    type: "other",
    text: `למכירה במיקום הכי אסטרטגי בפתח תקווה.\n2משרדים נפרדים\nמשרד 1: 53מר פינתי\nמשרד2: 72מר עם נוף פתוח\nסהכ 125מר וחניה תת קרקעית`,
  },
  { name: "a shop is not an apartment", type: "other", text: `הזדמנות נדירה למשקיעים! חנות מניבה ברמת גן\nשטח: 35 מ"ר בנוי\nמחיר סופר אטרקטיבי` },
  {
    name: "rental in a sale group",
    type: "rent",
    text: `להשכרה בפתח תקווה ברח' קלויזנר\n4 חדרים\nמרפסת שמש ענקית של 60 מ"ר\n10500 ש"ח`,
  },
  { name: "football training ad", type: "other", text: `אימוני כדורגל למבוגרים\nבמגרשים מסודרים עם דשא ושערים\nרמת גן, ימי שני 19:00` },
  {
    name: "private seller selling her house (no 'for sale' word)",
    type: "listing",
    text: `מוכרת את הבית המיוחד שלי בקדימה. על מגרש של 750 מטר, בנוי בית קסום בן 230 מטר, 6 חדרים. מחיר 4,200,000 ₪`,
  },
  {
    name: "price in thousands with k",
    type: "listing",
    text: `נכס חדש על המדף\nיוסף ספיר 29\nתתקבל דירה 4 חדרים\nבקומה 3 מתוך 10\nעם מרפסת 12 מר\nמחיר שיווק 2,390k בלבד!`,
  },
];

for (const item of cases) {
  test(`facebook corpus: ${item.name}`, () => {
    assert.equal(classify(item.text).type, item.type);
  });
}

test("facebook corpus: area is the apartment, not the plot, yard or balcony", () => {
  const area = (text) => LR.extractPriceSqmFree(text).sqm;
  assert.equal(area(`בית פרטי 6 חדרים, 160 מטר בנוי על מגרש 270 מטר, עם חצר 80 מטר. מחיר 4,800,000 ₪`), 160);
  assert.equal(area(`בנוי 279 מ"ר על 1000 מ"ר של מגרש ענק`), 279);
  assert.equal(area(`5 חדרים | 112 מ"ר + מרפסת שמש 12 מ"ר (סה"כ 124 מ"ר)`), 112);
  assert.equal(area(`4 חדרים , 97 מ"ר+ כ40 מ"ר גינה`), 97);
  assert.equal(area(`מגרש כ-270 מ"ר\nבנוי כ-190 מ"ר על פני 4 מפלסים`), 190);
});

test("facebook corpus: prices in other formats", () => {
  const price = (text) => LR.extractPriceSqmFree(`למכירה דירה 4 חדרים 100 מ"ר ${text}`).price;
  assert.equal(price("מחיר שיווק 2,390k בלבד!"), 2_390_000);
  assert.equal(price(`מחיר מבוקש : 2.3 מ' ש"ח`), 2_300_000);
  assert.equal(price("מחיר :⁠3,550,000 ש\"ח"), 3_550_000);
});

test("facebook corpus: cities from the post, with abbreviations and misspellings", () => {
  const city = (text) => LR.parseFreeAddress(text, "פתח תקווה").city;
  assert.equal(city("חדשה בבלעדיות! ראש העין רחוב העצמאות 24"), "ראש העין");
  assert.equal(city("למכירה בשכונת אור ים המבוקשת באור עקיבא, ברחוב לבונה"), "אור עקיבא");
  assert.equal(city("רחוב סוקולוב המבוקש בבת ים"), "בת ים");
  assert.equal(city("למכירה ברחוב דגל ראובן 62 פ\"ת"), "פתח תקווה");
  assert.equal(city("במשתלה שבצפון ת\"א, ברחוב דוד אבידן 16"), "תל אביב יפו");
  assert.equal(city("למכירה בקרית מטלון פתח תיקוה וילה"), "פתח תקווה");
});

test("facebook corpus: streets", () => {
  const street = (text) => LR.parseFreeAddress(text, "פתח תקווה").street;
  assert.equal(street("‏אברבנאל 12, פתח תקווה\nדירת 4 חדרים"), "אברבנאל 12");
  assert.equal(street("שרגא רפאלי 18, אם המושבות החדשה, פתח תקווה\n5 חדרים"), "שרגא רפאלי 18");
  assert.equal(street("למכירה ברחוב דגל ראובן 62 פ\"ת"), "דגל ראובן 62");
  assert.equal(street("רחוב קהילת פינסק 5, קומה 2"), "קהילת פינסק 5");
});

// כל הקורפוס: סוג, מחיר, שטח, חדרים, קומה, רחוב ועיר – בדיוק כמו שהתוסף שומר (fb.js)
test("facebook corpus: every field of every collected post", () => {
  const corpus = require("./facebook-corpus-data.js");
  const wrong = [];
  corpus.forEach((item, index) => {
    const c = classify(item.t);
    const parsed = c.parsed || LR.extractPriceSqmFree(item.t);
    const address = LR.parseFreeAddress(item.t, "פתח תקווה");
    const rf = LR.extractRoomsFloorFree(item.t);
    const got = { type: c.type, price: parsed.price, sqm: parsed.sqm, rooms: rf.rooms ?? undefined, floor: rf.floor ?? undefined, street: address.street || undefined, city: address.city || undefined };
    for (const [field, want] of Object.entries(item.expect)) {
      const ok = field === "street" ? String(got[field] || "").startsWith(want) : got[field] === want;
      if (!ok) wrong.push(`#${index} ${field}: want ${want} got ${got[field]}`);
    }
  });
  // "דירת 6 חדרים במקור, כיום 5" נשאר דו-משמעי – מותרת טעות אחת
  assert.ok(wrong.length <= 1, wrong.join("\n"));
});
