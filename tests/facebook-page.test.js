const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.LR = require("../parse.js");
const page = require("../facebook-page.js");

test("facebook page: the groups feed is not a group, but is a feed the extension runs on", () => {
  assert.equal(page.isGroupFeed("/groups/feed/"), false);
  assert.equal(page.isGroupFeed("/groups/joins/"), false);
  assert.equal(page.isGroupFeed("/groups/discover/"), false);
  assert.equal(page.groupId("/groups/feed/"), null);
  assert.equal(page.isGroupFeed("/groups/kfirshahaf/"), true);
  assert.equal(page.groupId("/groups/kfirshahaf/"), "kfirshahaf");
  assert.equal(page.isGroupsHomeFeed("/groups/feed/"), true);
  assert.equal(page.isGroupsHomeFeed("/groups/feed"), true);
  assert.equal(page.isGroupsHomeFeed("/groups/123/"), false);
});

test("facebook page: a post's group in the groups feed is the link to the group's main page", () => {
  const group = page.groupFromLinks([
    { href: "https://www.facebook.com/groups/123/user/456/", text: "שם המפרסם" },
    { href: "https://www.facebook.com/groups/123/posts/789/", text: "3 שעות" },
    { href: "https://www.facebook.com/groups/123/?__cft__[0]=x", text: "דירות למכירה בפתח תקווה" },
  ]);
  assert.deepEqual(group, { id: "123", name: "דירות למכירה בפתח תקווה" });
  assert.equal(page.groupFromLinks([{ href: "https://www.facebook.com/groups/feed/", text: "קבוצות" }]), null);
  assert.equal(page.groupFromLinks([{ href: "https://example.com/groups/1/", text: "דירות" }]), null);
  assert.equal(page.groupFromLinks([]), null);
});

test("facebook page: the group's city is used only when the name names one city", () => {
  const city = (name) => page.groupCityContext(name, globalThis.LR.findCities);
  assert.equal(city("דירות למכירה בפתח תקווה"), "פתח תקווה");
  assert.equal(city("דירות בשושו פתח תקווה והסביבה"), "פתח תקווה");
  assert.equal(city("דירות למכירה/השכרה בקריית אונו,אור יהודה,יהוד,גני תקווה,סביון."), null);
  assert.equal(city("דירות למכירה גבעתיים - רמת גן"), null);
  assert.equal(city("דירות להשקעה"), null);
  assert.equal(city(""), null);
});
