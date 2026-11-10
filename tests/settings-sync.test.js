const assert = require("node:assert/strict");
const test = require("node:test");

const LRSync = require("../sync-core.js");

const row = (settings, updatedAt) => ({
  key: LRSync.SETTINGS_ROW_KEY,
  data: { settings, updatedAt },
  deleted: false,
  client_updated_at: updatedAt,
});

test("settings hash ignores key order", () => {
  assert.equal(
    LRSync.settingsHash({ nearM: 800, blockedStreets: ["הרצל"] }),
    LRSync.settingsHash({ blockedStreets: ["הרצל"], nearM: 800 })
  );
  assert.notEqual(LRSync.settingsHash({ nearM: 800 }), LRSync.settingsHash({ nearM: 500 }));
});

test("the settings row is split out of pulled rows and never reaches the listing cache", () => {
  const listing = { key: "yad2:1", data: { price: 1 }, client_updated_at: 1 };
  const split = LRSync.splitSettingsRows([listing, row({ nearM: 500 }, 10)]);
  assert.deepEqual(split.rows, [listing]);
  assert.equal(split.settingsRow.data.settings.nearM, 500);
  assert.equal(LRSync.splitSettingsRows([listing]).settingsRow, null);
});

test("newer remote settings are applied; older or identical ones are not", () => {
  const local = { nearM: 800, blockedStreets: [] };
  const newer = LRSync.remoteSettingsToApply({ updatedAt: 5 }, row({ nearM: 500, blockedStreets: ["ויצמן"] }, 10), local);
  assert.deepEqual(newer, { settings: { nearM: 500, blockedStreets: ["ויצמן"] }, updatedAt: 10 });
  assert.equal(LRSync.remoteSettingsToApply({ updatedAt: 20 }, row({ nearM: 500 }, 10), local), null);
  // מחשב חדש בלי היסטוריה מקבל את ההגדרות מהשרת
  assert.ok(LRSync.remoteSettingsToApply({}, row({ nearM: 500 }, 10), {}).settings);
  // אותן הגדרות בדיוק: רק מעדכנים את חותמת הזמן
  assert.deepEqual(LRSync.remoteSettingsToApply({ updatedAt: 1 }, row(local, 10), local), { settings: null, updatedAt: 10 });
  assert.equal(LRSync.remoteSettingsToApply({}, { ...row({}, 10), deleted: true }, local), null);
});

test("settings are pushed only when they differ from what was already synced", () => {
  const local = { nearM: 800 };
  const first = LRSync.settingsRowToPush({}, local, "user-1", 1234);
  assert.equal(first.row.key, LRSync.SETTINGS_ROW_KEY);
  assert.equal(first.row.client_updated_at, 1234);
  assert.deepEqual(first.row.data, { settings: local, updatedAt: 1234 });
  assert.equal(LRSync.settingsRowToPush({ pushedHash: first.hash, updatedAt: 1234 }, local, "user-1"), null);
  const changed = LRSync.settingsRowToPush({ pushedHash: first.hash, updatedAt: 5000 }, { nearM: 300 }, "user-1", 9999);
  assert.equal(changed.updatedAt, 5000);
});
