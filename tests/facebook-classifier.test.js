const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.LR = require("../parse.js");
const classifyFacebookPost = require("../facebook-classifier.js");
assert.equal(globalThis.LR.classifyFacebookPost, classifyFacebookPost);
const { isGroupFeed } = require("../facebook-page.js");

const cases = [
  {
    name: "seller ad that opens with a rhetorical question",
    type: "listing",
    text: `מחפשים את הבית הבא שלכם בכפר אברהם?
בואו להתאהב בדירה מוארת ומרווחת.
4 חדרים (104 מ"ר), קומה 3.
לפרטים ותיאום סיור התקשרו לינון.`,
  },
  {
    name: "seller ad with an audience-directed question and viewing CTA",
    type: "listing",
    text: `מחפשים דירת 5 חדרים אמיתית באור ים?
124 מ"ר בנוי, מרפסת שמש כ-20 מ"ר.
מחיר: 2,550,000 ₪.
לפרטים ותיאום סיור פרטי התקשרו.`,
  },
  {
    name: "seller ad with an attractive low rent-like amount",
    type: "rent",
    text: `מחפשים את הבית הבא שלכם?
דירת 3 חדרים משופצת ומוארת.
מחיר אטרקטיבי של 4,000 ש"ח בלבד.
לתיאום סיור התקשרו.`,
  },
  {
    name: "sale listing mentioning an existing tenant",
    type: "listing",
    text: `מחפשים הזדמנות השקעה?
דירת 3 חדרים עם שכירות קיימת והדיירים מעוניינים להישאר.
מחיר מבוקש: 1,770,000 ₪.
צרו קשר לתיאום סיור.`,
  },
  {
    name: "rental listing followed by a comment from a seeker",
    type: "rent",
    text: `להשכרה דירת 3 חדרים, 60 מ"ר, מחיר 4,000 ש"ח לחודש.
מחפשת דירה, אפשר פרטים?`,
  },
  {
    name: "person looking for a rental with a budget",
    type: "seeking",
    text: `מחפשת דירה 3-4 חדרים להשכרה עד 7,000 ₪, ללא תיווך.`,
  },
  {
    name: "person looking for a property",
    type: "seeking",
    text: `מחפש יחידת קרקע שקטה או דירה אחרונה ללא שכנים.`,
  },
  {
    name: "explicit sale listing with a rhetorical question",
    type: "listing",
    text: `מחפשים דירה למגורים?
למכירה בפתח תקווה דירת 4 חדרים, 95 מ"ר.
מחיר שיווק: 2,050,000 ₪.
שלחו הודעה לפרטים.`,
  },
  {
    name: "sale listing followed by a rhetorical question",
    type: "listing",
    text: `דירה למכירה.
מחפשים נכס איכותי במיקום מנצח?
דירת 3 חדרים, 60 מ"ר.
מחיר שיווק: 1,740,000 ₪.`,
  },
  {
    name: "explicit sale offer with rooms but no price or area",
    type: "listing",
    text: `למכירה דירה, אפשרות ל-5 חדרים בתכנון נכון.
דירה מלאה אור יום, מעלית וחניה פרטית.`,
  },
  {
    name: "property listing with seller contact but missing price and area",
    type: "listing",
    text: `ברוכים הבאים לבית הבא שלכם.
דירת 4 חדרים, קומה 6, חניה פרטית ומעלית.
רלוונטי לכם? צרו קשר.`,
  },
  {
    name: "ordinary rental listing",
    type: "rent",
    text: `דירת 5 חדרים להשכרה, 120 מ"ר.
מחיר 8,000 ₪ לחודש.`,
  },
];

for (const item of cases) {
  test(item.name, () => {
    assert.equal(classifyFacebookPost(item.text).type, item.type);
  });
}

test("sale price and area remain extractable when the post mentions an existing tenancy", () => {
  const parsed = LR.extractPriceSqmFree(cases[3].text);
  assert.equal(parsed.price, 1_770_000);
  assert.equal(parsed.sqm, null);
});

test("area extraction recognizes abbreviated square-meter notation", () => {
  const parsed = LR.extractPriceSqmFree("הבית 123 מ', מרפסת 50 מ'");
  assert.equal(parsed.sqm, 123);
});

test("Facebook analysis is limited to group main-feed URLs", () => {
  for (const path of ["/groups/370244223604031", "/groups/370244223604031/"]) {
    assert.equal(isGroupFeed(path), true, `${path} should be included`);
  }
  for (const path of [
    "/",
    "/marketplace/",
    "/profile.php",
    "/groups/370244223604031/posts/123456",
    "/groups/370244223604031/permalink/123456",
  ]) {
    assert.equal(isGroupFeed(path), false, `${path} should be excluded`);
  }
});

test("only groups whose name looks like a real-estate group are scanned", () => {
  const { isRealEstateGroupName, groupId } = require("../facebook-page.js");
  for (const name of ["דירות למכירה בפתח תקווה", "נדל\"ן בשרון – קנייה ומכירה", "דירות להשכרה תל אביב", "Real Estate Israel", "נכסים בקריית אונו"]) {
    assert.equal(isRealEstateGroupName(name), true, name);
  }
  for (const name of ["הורים בפתח תקווה", "מתכונים טבעוניים", "Python Israel", ""]) {
    assert.equal(isRealEstateGroupName(name), false, name);
  }
  assert.equal(groupId("/groups/370244223604031/"), "370244223604031");
});
