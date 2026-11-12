// Scope Facebook listing analysis to a group's main feed, not profiles, pages, or individual posts –
// and only to groups that look like real-estate groups (by the group's name), so the extension does not
// scan every post in unrelated groups. A group can also be enabled by hand (stored per group id).
(() => {
  const isGroupFeed = (pathname) => /^\/groups\/[^/]+\/?$/.test(String(pathname || ""));
  const groupId = (pathname) => {
    const match = String(pathname || "").match(/^\/groups\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  // מילים כלליות בשם הקבוצה שמעידות על קבוצת דירות (בלי שמות של קבוצות או אתרים מסוימים)
  const REAL_ESTATE_NAME =
    /דירות|דירה|נדל["״׳']?ן|נדלן|נכסים|נכס|למכירה|מכירה|להשכרה|השכרה|שכירות|לקני(?:י)?ה|קני(?:י)?ה|לרכישה|דיור|בתים|מגרשים|קרקעות|real\s*estate|apartments?|housing|propert(?:y|ies)|for\s+sale|for\s+rent|rentals?\b/i;
  function isRealEstateGroupName(name) {
    return REAL_ESTATE_NAME.test(String(name || ""));
  }

  globalThis.LRFacebookPage = { isGroupFeed, groupId, isRealEstateGroupName };
  if (typeof module !== "undefined") module.exports = { isGroupFeed, groupId, isRealEstateGroupName };
})();
