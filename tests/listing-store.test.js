const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../listing-store.js");

function memoryArea(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const out = {};
      for (const key of [].concat(keys)) if (key in data) out[key] = data[key];
      return out;
    },
    async set(values) {
      writes.push(Object.keys(values));
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    },
  };
}

const sample = () => {
  const cache = {};
  for (let i = 0; i < 200; i++) cache[`yad2:item${i}`] = { updatedAt: i, price: i * 1000 };
  return cache;
};

test("split/fold round-trips and every key lands in a stable shard", () => {
  const cache = sample();
  const shards = Store.split(cache);
  assert.equal(Object.keys(shards).length, 32);
  assert.deepEqual(Store.fold(shards), cache);
  assert.equal(Store.shardKeyOf("yad2:item7"), Store.shardKeyOf("yad2:item7"));
  assert.ok(Store.isCacheKey(Store.shardKeyOf("madlan:x")));
  assert.ok(Store.isCacheKey(Store.LEGACY_KEY));
  assert.equal(Store.isCacheKey("lightrailDeals"), false);
});

test("load migrates the old single key into shards and removes it", async () => {
  const area = memoryArea({ [Store.LEGACY_KEY]: sample() });
  const cache = await Store.load(area);
  assert.equal(Object.keys(cache).length, 200);
  assert.equal(Store.LEGACY_KEY in area.data, false);
  assert.deepEqual(Store.fold(area.data), cache);
});

test("save with previous writes only the shards that changed", async () => {
  const area = memoryArea();
  const before = sample();
  await Store.save(area, before);
  area.writes.length = 0;
  const after = { ...before, "yad2:item5": { ...before["yad2:item5"], price: 1 } };
  const written = await Store.save(area, after, before);
  assert.deepEqual(written, [Store.shardKeyOf("yad2:item5")]);
  assert.equal(Store.fold(area.data)["yad2:item5"].price, 1);
});

test("a full save removes records that were deleted", async () => {
  const area = memoryArea();
  const cache = sample();
  await Store.save(area, cache);
  const { "yad2:item3": _removed, ...rest } = cache;
  await Store.save(area, rest);
  assert.equal("yad2:item3" in Store.fold(area.data), false);
});

test("loadShards + saveShards touch only the shards of the given keys", async () => {
  const area = memoryArea();
  await Store.save(area, sample());
  area.writes.length = 0;
  const { cache, shardKeys } = await Store.loadShards(area, ["yad2:item9"]);
  assert.deepEqual(shardKeys, [Store.shardKeyOf("yad2:item9")]);
  cache["yad2:item9"] = { updatedAt: 999 };
  await Store.saveShards(area, cache, shardKeys);
  assert.deepEqual(area.writes, [[Store.shardKeyOf("yad2:item9")]]);
  const all = Store.fold(area.data);
  assert.equal(all["yad2:item9"].updatedAt, 999);
  assert.equal(Object.keys(all).length, 200, "other shards untouched");
});

test("applyShardChanges replaces only the changed shards in memory", () => {
  const cache = sample();
  const shard = Store.shardKeyOf("yad2:item1");
  const newShard = { ...Store.split(cache)[shard] };
  delete newShard["yad2:item1"];
  newShard["yad2:fresh"] = { updatedAt: 5 };
  // "yad2:fresh" may hash elsewhere; applyShardChanges trusts the event payload
  const next = Store.applyShardChanges(cache, { [shard]: newShard });
  assert.equal("yad2:item1" in next, false);
  assert.ok(next["yad2:fresh"]);
  assert.equal(Object.keys(next).length, 200);
});
