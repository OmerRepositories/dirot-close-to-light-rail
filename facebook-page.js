// Scope Facebook listing analysis to a group's main feed, not profiles, pages, or individual posts –
// and only to groups that look like real-estate groups (by the group's name), so the extension does not
// scan every post in unrelated groups. A group can also be enabled by hand (stored per group id).
// The groups feed (/groups/feed/, posts from all of the user's groups) is supported too: there each post
// is judged by the group it came from.
(() => {
  // נתיבים תחת /groups/ שאינם קבוצה
  const NOT_A_GROUP = /^(?:feed|joins|discover|create|notifications|search|requests|your_groups|invites|membership|saved)$/i;
  const groupId = (pathname) => {
    const match = String(pathname || "").match(/^\/groups\/([^/]+)/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    return NOT_A_GROUP.test(id) ? null : id;
  };
  // הפיד הראשי של קבוצה אחת: /groups/<id>/
  const isGroupFeed = (pathname) => /^\/groups\/[^/]+\/?$/.test(String(pathname || "")) && groupId(pathname) !== null;
  // הפיד של כל הקבוצות: /groups/feed/
  const isGroupsHomeFeed = (pathname) => /^\/groups\/feed\/?$/i.test(String(pathname || ""));

  // הקבוצה של פוסט בפיד הקבוצות: הקישור לדף הראשי של הקבוצה (/groups/<id>/) עם שם.
  // (קישורים לפוסט עצמו או למפרסם בתוך הקבוצה – /groups/<id>/posts/..., /groups/<id>/user/... – לא נחשבים)
  function groupFromLinks(links) {
    for (const link of links || []) {
      let url;
      try {
        url = new URL(link.href, "https://www.facebook.com/");
      } catch {
        continue;
      }
      if (!/(?:^|\.)facebook\.com$/i.test(url.hostname) || !isGroupFeed(url.pathname)) continue;
      const name = String(link.text || "").replace(/\s+/g, " ").trim();
      if (name.length < 2) continue;
      return { id: groupId(url.pathname), name };
    }
    return null;
  }

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

  // עיר מתוך שם הקבוצה – רק כשהשם מציין עיר אחת. "דירות בקריית אונו, אור יהודה, יהוד" לא אומרת
  // באיזו עיר הפוסט; עדיף בלי עיר מאשר עיר שגויה (מרחק שגוי מהרכבת שנראה מדויק).
  function groupCityContext(name, findCities) {
    if (!name || typeof findCities !== "function") return null;
    const cities = findCities(String(name));
    return cities.length === 1 ? cities[0] : null;
  }

  const api = { isGroupFeed, isGroupsHomeFeed, groupId, groupFromLinks, isRealEstateGroupName, groupCityContext };
  globalThis.LRFacebookPage = api;
  if (typeof module !== "undefined") module.exports = api;
})();
