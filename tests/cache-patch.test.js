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

test("applyCachePatch prunes only records that were not updated since", () => {
  const cache = { "yad2:old": { updatedAt: 1 }, "yad2:touched": { updatedAt: 9 } };
  const result = LRSync.applyCachePatch(cache, [], [["yad2:old", 1], ["yad2:touched", 3], ["yad2:none", 1]]);
  assert.equal("yad2:old" in result.cache, false);
  assert.ok(result.cache["yad2:touched"]);
});
