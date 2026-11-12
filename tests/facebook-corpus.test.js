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

test("facebook corpus (sweep 2): odd area, rooms and price formats", () => {
  const base = "למכירה דירת 4 חדרים ברחוב הרצל 10 פתח תקווה, קומה 2, ";
  const parsed = (text) => {
    const c = classify(base + text);
    return c.parsed || LR.extractPriceSqmFree(base + text);
  };
  assert.equal(parsed(`103 מ"​ר נטו. מחיר 1,900,000`).sqm, 103);
  assert.equal(parsed(`109+ 50 מ"ר מרפסת. מחיר 1,900,000`).sqm, 109);
  assert.equal(parsed(`כ־68 מ״ר לפי ארנונה | כ־56 מ״ר בטאבו. מחיר 1,900,000`).price, 1_900_000);
  assert.equal(parsed(`100 מ"ר. מחיר 2.950k ש"ח`).price, 2_950_000);
  assert.equal(parsed(`100 מ"ר. מחיר 1.980,000 ש"ח`).price, 1_980_000);
  assert.equal(parsed(`100 מ"ר. עדכון מחיר של -90000₪ !! מחיר 1,900,000 ₪`).price, 1_900_000);
  const rooms = (text) => LR.extractRoomsFloorFree(text).rooms;
  assert.equal(rooms("5 חד מהממת בקומה 3"), 5);
  assert.equal(rooms("בית חד משפחתי, 6 חדרים"), 6);
  assert.equal(rooms("דירת 6 חדרים שהפכה ל-4 חדרים"), 4);
  assert.equal(LR.parseFreeAddress("למכירה בחריש דירת 4 חדרים", "פתח תקווה").city, "חריש");
});

test("facebook corpus (sweep 2): post types", () => {
  assert.equal(classify(`בניין 3 קומות מחולק ל 10 יחידות דיור, 400 מ"ר, מחיר 9,000,000 ₪`).type, "other");
  assert.equal(classify(`אימוני ריצה לנשים בפארק, 3 פעמים בשבוע, 150 ש"ח לחודש`).type, "other");
  assert.equal(classify(`תתרגל להגיד נמכר! דירת 4 חדרים 100 מ"ר בקומה 2, 2,100,000 ₪`).type, "listing");
  assert.equal(classify(`נמכר! דירת 4 חדרים ברחוב ברנר`).type, "other");
});

// סבב 3: 336 פוסטים מ-4 קבוצות (פתח תקווה, קריית אונו/יהוד/אור יהודה, פיד הקבוצות)
test("facebook corpus (sweep 3): license numbers and phones are not prices", () => {
  const price = (text) => LR.extractPriceSqmFree(`למכירה דירת 4 חדרים 100 מ"ר\n${text}`).price;
  assert.equal(price("לפרטים: יועץ נדל\"ן | רישיון 3145176"), null);
  assert.equal(price("רישיון תיווך: 3141685"), null);
  assert.equal(price("לפרטים: 0544-788644"), null);
  assert.equal(price("עיצוב בהשקעה של מעל 2 מיליון שקל"), null);
  assert.equal(price("מרפסת\n17.5 מ'ר"), null);
  assert.equal(price("מחיר שיווק 5.99 מ' , לתיאום"), 5_990_000);
  assert.equal(price("מחיר מעודכן וחדש - 1,850,000 ש\"ח\nרישיון 0000000"), 1_850_000);
});

test("facebook corpus (sweep 3): apartment area, not the living room, balcony or plot", () => {
  const area = (text) => LR.extractPriceSqmFree(`למכירה 4 חדרים\n${text}`).sqm;
  assert.equal(area(`118מ"ר\nסלון בגודל של 40 מ"ר!!`), 118);
  assert.equal(area(`מגרש בגודל כ- 972 מ"ר\nבית בנוי כ-200 מ"ר (במפלסים)`), 200);
  assert.equal(area(`קוטג' 6 חדרים על מגרש בשטח 320 מ"ר\nכ220 מ"ר בנוי`), 220);
  assert.equal(area(`משופצת! כ90 מ"ר בנוי\nכ75 מ"ר גג מוצמד בטאבו`), 90);
  assert.equal(area(`דירה עם מרפסת ענקית ומקורה בשטח של כ־20 מ"ר!`), null);
  assert.equal(area(`כ 121 מ"ר מעוצבת\nכ- 109 מ"ר בנוי\nכ- 12 מ"ר מרפסת`), 109);
  assert.equal(area(`בית טורי. יושב על שטח של 220 מטר.\n3.5 חדרים (108 מטר בנוי כעת)`), 108);
  assert.equal(classify(`למכירה דירת 4 חדרים, מחיר 1,890,000 ₪\nממוקמת 50 מטר מהרכבת הקלה`).parsed.sqm, null);
});

test("facebook corpus (sweep 3): streets", () => {
  const street = (text) => LR.parseFreeAddress(text, "פתח תקווה").street;
  assert.equal(street(`חדש למכירה בבורוכוב 5, גבעתיים\nבורוכוב הוא אחד הרחובות המבוקשים`), "בורוכוב 5");
  assert.equal(street(`רחוב שקט וחד סיטרי.\nהאר"י הקדוש 4, מחנה יהודה, פתח תקווה`), `האר"י הקדוש 4`);
  assert.equal(street(`אמיר בנימיני 6 | קומה 4 עם מעלית\nרחוב ללא מוצא`), "אמיר בנימיני 6");
  assert.equal(street(`דירת 4.5 חד ענקית ברחוב רמבם בפתח תקווה`), "רמבם");
  assert.equal(street(`ברחוב גלמן הקטן\nמגרש של 500 מ"ר`), "גלמן הקטן".split(" ")[0]);
  assert.equal(street(`ברח' רוטשילד\nיחידת דיור עם חדר גדול`), "רוטשילד");
  assert.equal(street(`למכירה בכנען 2 בבית בפארק\nועד בית 238 ₪`), "כנען 2");
  for (const text of [
    "שכירות: 6,000 ₪ לחודש",
    "עדכון מחיר- 1,990,000 ללא תיווך",
    "לפרטים בנייד 0540000000",
    "למחיר : https://example.com/x2",
    "ברחוב פנימי ושקט ללא מוצא",
    "מגרש 360 מ\"ר , בנוי 300 , מחיר",
  ]) assert.equal(street(text), null, text);
});

test("facebook corpus (sweep 3): post types", () => {
  assert.equal(classify(`מחפשים דירת 4 חדרים מרווחת בפתח תקווה? בשישי הקרוב אני פותח את הדלת לדירה משופצת, כ־105 מ״ר, ברחוב שקט. מחיר 2,100,000 ₪`).type, "listing");
  assert.equal(classify(`שלום, אנחנו זוג צעיר מחפשים את הפינה הבאה שלנו.\nגודל: 2.5 או 3 חדרים.\nתקציב: עד 3,800 ש"ח`).type, "seeking");
  assert.equal(classify(`דרושה דירה מרווחת 5 או 6 חדרים קומה נמוכה לקניה מיידית`).type, "seeking");
  assert.equal(classify(`רכישת מגרש בשכונה הפופולרית, עם היתרי בניה!\nמגרש בגודל 230 מ"ר\nמחיר 3,000,000 ₪`).type, "other");
  assert.equal(classify(`פרויקט מגורים אינטימי בלב העיר. דירות 5 חדרים החל מ־2,750,000 ₪!`).type, "other");
  assert.equal(classify(`הזדמנות! דירת 4 חדרים\nתשואה של כ-4.5%\nשכירות חודשית של 6,200 ₪`).type !== "rent", true);
  assert.equal(LR.extractRoomsFloorFree("דירת שלושה חדרים עם 2 חדרי רחצה").rooms, 3);
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
  assert.deepEqual(wrong, []);
});
