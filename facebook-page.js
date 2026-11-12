// Scope Facebook listing analysis to a group's main feed, not profiles, pages, or individual posts –
// and only to groups that look like real-estate groups (by the group's name), so the extension does not
// scan every post in unrelated groups. A group can also be enabled by hand (stored per group id).
(() => {
  const isGroupFeed = (pathname) => /^\/groups\/[^/]+\/?$/.test(String(pathname || ""));
  const groupId = (pathname) => {
    const match = String(pathname || "").match(/^\/groups\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  // מילים בשם הקבוצה שמעידות על קבוצת דירות / נדל"ן (עברית ואנגלית)
  const REAL_ESTATE_NAME =
    /דירות|דירה|נדל["״׳']?ן|נדלן|נכסים|נכס|למכירה|להשכרה|השכרה|מכירה|מכירת|שכירות|דיור|בתים|קוטג|מגרשים|קרקעות|יד\s*2|תיווך|מתווכים|real\s*estate|apartment|apartments|homes?\b|housing|property|properties|for\s+sale|for\s+rent|rentals?\b|flat/i;
  function isRealEstateGroupName(name) {
    return REAL_ESTATE_NAME.test(String(name || ""));
  }

  globalThis.LRFacebookPage = { isGroupFeed, groupId, isRealEstateGroupName };
  if (typeof module !== "undefined") module.exports = { isGroupFeed, groupId, isRealEstateGroupName };
})();
