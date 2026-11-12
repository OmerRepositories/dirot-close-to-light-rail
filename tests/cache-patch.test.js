const test = require("node:test");
const assert = require("node:assert/strict");
const LRSync = require("../sync-core.js");

test("applyCachePatch adds new records and updates older ones", () => {
  const cache = { "yad2:a": { updatedAt: 1, price: 1 } };
  const result = LRSync.applyCachePatch(cache, [
    { key: "yad2:a", record: { updatedAt: 2, price: 2 }, existed: true },
    { key: "madlan:b", record: { updatedAt: 5 }, existed: false },
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.cache["yad2:a"].price, 2);
  assert.ok(result.cache["madlan:b"]);
  assert.equal(cache["yad2:a"].price, 1, "input is not mutated");
});

test("applyCachePatch keeps a newer stored record and reports it", () => {
  const cache = { "yad2:a": { updatedAt: 10, listingStatus: "removed" } };
  const result = LRSync.applyCachePatch(cache, [{ key: "yad2:a", record: { updatedAt: 5 }, existed: true }]);
  assert.equal(result.changed, false);
  assert.equal(result.cache, cache);
  assert.equal(result.newer["yad2:a"].listingStatus, "removed");
});

test("applyCachePatch does not bring back a record deleted since the tab read it", () => {
  const result = LRSync.applyCachePatch({}, [{ key: "yad2:a", record: { updatedAt: 5 }, existed: true }]);
  assert.deepEqual(result.deleted, ["yad2:a"]);
  assert.equal(result.changed, false);
  assert.equal("yad2:a" in result.cache, false);
});

test("applyCachePatch keeps a favorite set after the tab read the record", () => {
  const cache = { "yad2:a": { updatedAt: 5, favorite: true, favoriteAt: 5 } };
  const result = LRSync.applyCachePatch(cache, [{ key: "yad2:a", record: { updatedAt: 9, price: 3 }, existed: true }]);
  assert.equal(result.cache["yad2:a"].price, 3);
  assert.equal(result.cache["yad2:a"].favorite, true);
  // הסרה מהמועדפים (favorite:false עם זמן) נשמרת באותו אופן
  const off = { "yad2:a": { updatedAt: 5, favorite: false, favoriteAt: 7 } };
  const kept = LRSync.applyCachePatch(off, [{ key: "yad2:a", record: { updatedAt: 9, favorite: true, favoriteAt: 2 }, existed: true }]);
  assert.equal(kept.cache["yad2:a"].favorite, false);
});

test("applyCachePatch merge (Facebook): keeps notes and history, adds a new price, skips unchanged", () => {
  const stored = { "facebook:1": { updatedAt: 5, price: 2_000_000, notes: "לבדוק", favorite: true, favoriteAt: 4, priceHistory: [{ price: 2_000_000, at: 5, src: "page" }] } };
  const same = LRSync.applyCachePatch(stored, [{ key: "facebook:1", record: { updatedAt: 9, price: 2_000_000 }, existed: false, merge: true }]);
  assert.equal(same.changed, false, "same price again – nothing written");
  const drop = LRSync.applyCachePatch(stored, [{ key: "facebook:1", record: { updatedAt: 9, price: 1_900_000, contactPhones: "052-1234567" }, existed: false, merge: true }]);
  const merged = drop.cache["facebook:1"];
  assert.equal(merged.price, 1_900_000);
  assert.equal(merged.notes, "לבדוק");
  assert.equal(merged.favorite, true);
  assert.equal(merged.contactPhones, "052-1234567");
  assert.deepEqual(merged.priceHistory.map((point) => point.price), [2_000_000, 1_900_000]);
});

test("applyCachePatch prunes only records that were not updated since", () => {
  const cache = { "yad2:old": { updatedAt: 1 }, "yad2:touched": { updatedAt: 9 } };
  const result = LRSync.applyCachePatch(cache, [], [["yad2:old", 1], ["yad2:touched", 3], ["yad2:none", 1]]);
  assert.equal("yad2:old" in result.cache, false);
  assert.ok(result.cache["yad2:touched"]);
});
