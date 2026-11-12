// Scope Facebook listing analysis to a group's main feed, not profiles, pages, or individual posts –
// and only to groups that look like real-estate groups (by the group's name), so the extension does not
// scan every post in unrelated groups. A group can also be enabled by hand (stored per group id).
(() => {
  const isGroupFeed = (pathname) => /^\/groups\/[^/]+\/?$/.test(String(pathname || ""));
  const groupId = (pathname) => {
    const match = String(pathname || "").match(/^\/groups\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  // מילים בשם הקבוצה שמעידות על קבוצת דירות / נדל"ן – כמה שיותר, בעברית ובאנגלית.
  // (מילה אחת מספיקה; הפוסטים עצמם עדיין נבדקים בנפרד אם הם מודעה, כך שקבוצה כללית מדי לא מזיקה)
  const REAL_ESTATE_WORDS = [
    // דירות ובתים
    "דירה", "דירות", "דירת", "דיור", "בית", "בתים", "וילה", "וילות", "קוטג", "דו משפחתי", "דו-משפחתי",
    "פנטהאוז", "פנטהאוס", "דופלקס", "דירת גג", "דירת גן", "יחידת דיור", "יחידות דיור", "סטודיו", "חדר להשכרה", "חדרים",
    // נדל"ן ונכסים
    "נדל\"ן", "נדל״ן", "נדלן", "נדל'ן", "נכס", "נכסים", "מגרש", "מגרשים", "קרקע", "קרקעות", "בנייה", "בניה",
    "פרויקט", "פרויקטים", "יזמות", "יזמים", "התחדשות עירונית", "פינוי בינוי", "פינוי-בינוי", "תמ\"א", "תמא",
    // קנייה ומכירה
    "למכירה", "מכירה", "מכירת", "מוכרים", "מוכר", "לקנייה", "לקניה", "קנייה", "קניה", "קונים", "לרכישה", "רכישה",
    "משקיעים", "השקעות", "השקעה", "משכנתא", "משכנתאות",
    // השכרה
    "להשכרה", "השכרה", "השכרת", "שכירות", "שוכרים", "משכירים", "סאבלט", "שותפים", "שותפות",
    // תיווך ולוחות
    "תיווך", "מתווך", "מתווכים", "מתווכות", "יד 2", "יד2", "יד שניה", "יד שנייה", "לוח דירות", "לוח נדל",
    // אנגלית
    "real estate", "realestate", "realty", "apartment", "apartments", "flat", "flats", "home", "homes", "house",
    "houses", "housing", "property", "properties", "for sale", "for rent", "rent", "rental", "rentals",
    "sublet", "roommate", "roommates", "condo", "condos", "investment", "investors",
  ];
  // מילים באנגלית – כמילה שלמה בלבד ("rent" לא יתאים ל-"parents")
  const escape = (word) => {
    const pattern = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
    return /^[a-z\s]+$/i.test(word) ? `\\b${pattern}\\b` : pattern;
  };
  const REAL_ESTATE_NAME = new RegExp(REAL_ESTATE_WORDS.map(escape).join("|"), "i");
  function isRealEstateGroupName(name) {
    return REAL_ESTATE_NAME.test(String(name || ""));
  }

  globalThis.LRFacebookPage = { isGroupFeed, groupId, isRealEstateGroupName };
  if (typeof module !== "undefined") module.exports = { isGroupFeed, groupId, isRealEstateGroupName };
})();
