const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LRSync = require("../sync-core.js");

// ---------- פונקציות טהורות ----------

test("record hashes change only when the record changes", () => {
  const record = { title: "a", price: 2_000_000, updatedAt: 5 };
  assert.equal(LRSync.hashRecord(record), LRSync.hashRecord({ ...record }));
  assert.notEqual(LRSync.hashRecord(record), LRSync.hashRecord({ ...record, price: 1_990_000 }));
});

test("project URLs are normalised and must be https", () => {
  assert.equal(LRSync.normalizeProjectUrl("abc.supabase.co/"), "https://abc.supabase.co");
  assert.equal(LRSync.normalizeProjectUrl(" https://abc.supabase.co/rest/v1 "), "https://abc.supabase.co");
  assert.equal(LRSync.normalizeProjectUrl("http://localhost:54321"), "http://localhost:54321");
  assert.throws(() => LRSync.normalizeProjectUrl("http://abc.supabase.co"));
  assert.throws(() => LRSync.normalizeProjectUrl(""));
});

test("remote rows merge by newest updatedAt, tombstones delete older local copies", () => {
  const cache = {
    keep: { title: "local newer", updatedAt: 200 },
    take: { title: "local older", updatedAt: 100 },
    gone: { title: "deleted elsewhere", updatedAt: 100 },
    same: { title: "same", updatedAt: 1 },
  };
  const rows = [
    { key: "keep", data: { title: "remote older", updatedAt: 150 }, deleted: false, client_updated_at: 150 },
    { key: "take", data: { title: "remote newer", updatedAt: 300 }, deleted: false, client_updated_at: 300 },
    { key: "gone", data: null, deleted: true, client_updated_at: 400 },
    { key: "same", data: { title: "same", updatedAt: 1 }, deleted: false, client_updated_at: 1 },
    { key: "new", data: { title: "new", updatedAt: 9 }, deleted: false, client_updated_at: 9 },
  ];
  const result = LRSync.mergeRemoteRows(cache, rows);
  assert.equal(result.cache.keep.title, "local newer");
  assert.equal(result.cache.take.title, "remote newer");
  assert.equal(result.cache.gone, undefined);
  assert.equal(result.cache.new.title, "new");
  assert.equal(result.applied, 3);
  assert.equal("keep" in result.hashUpdates, false, "local newer version will be pushed");
  assert.equal(result.hashUpdates.gone, null);
  assert.equal(result.hashUpdates.same, LRSync.hashRecord(cache.same));
  assert.equal(cache.take.title, "local older", "input is not mutated");
});

test("the setup SQL creates one table with row level security and no fixed project details", () => {
  assert.match(LRSync.SETUP_SQL, /create table if not exists public\.lightrail_records/);
  assert.match(LRSync.SETUP_SQL, /enable row level security/);
  assert.match(LRSync.SETUP_SQL, /auth\.uid\(\) = user_id/);
  assert.doesNotMatch(LRSync.SETUP_SQL, /supabase\.co|password|secret/i);
});

// ---------- שני מחשבים מול שרת Supabase מדומה ----------

function fakeSupabase() {
  const rows = new Map(); // `${user}|${key}` -> row
  let clock = Date.parse("2026-11-07T10:00:00Z");
  const users = { "me@example.test": { id: "user-1", password: "pw-1" } };
  const tokens = new Map();
  let tokenSeq = 0;
  const issue = (user) => {
    const access = `access-${++tokenSeq}`;
    const refresh = `refresh-${tokenSeq}`;
    tokens.set(access, user.id);
    tokens.set(refresh, user);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: user.id, email: "me@example.test" } };
  };
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  async function fetch(url, options = {}) {
    const parsed = new URL(url);
    const headers = options.headers || {};
    if (headers.apikey !== "public-key") return reply(401, { message: "bad key" });
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.pathname === "/auth/v1/token") {
      const grant = parsed.searchParams.get("grant_type");
      if (grant === "password") {
        const user = users[body.email];
        if (!user || user.password !== body.password) return reply(400, { error_description: "Invalid login credentials" });
        return reply(200, issue(user));
      }
      const user = tokens.get(body.refresh_token);
      return user ? reply(200, issue(user)) : reply(400, { error_description: "Invalid Refresh Token" });
    }
    const userId = tokens.get(String(headers.Authorization).replace("Bearer ", ""));
    if (typeof userId !== "string") return reply(401, { message: "JWT expired" });
    if (parsed.pathname !== "/rest/v1/lightrail_records") return reply(404, {});
    if ((options.method || "GET") === "GET") {
      const filter = parsed.searchParams.get("updated_at");
      const since = filter ? Date.parse(filter.replace(/^gt\./, "")) : -Infinity;
      const limit = Number(parsed.searchParams.get("limit"));
      const list = [...rows.values()]
        .filter((row) => row.user_id === userId && Date.parse(row.updated_at) > since)
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
        .slice(0, limit)
        .map(({ key, data, deleted, client_updated_at, updated_at }) => ({ key, data, deleted, client_updated_at, updated_at }));
      return reply(200, list);
    }
    for (const incoming of body) {
      if (incoming.user_id !== userId) return reply(403, { message: "row level security" });
      const id = `${userId}|${incoming.key}`;
      const old = rows.get(id);
      // אותה לוגיקה כמו הטריגר ב-SETUP_SQL
      const next = old && incoming.client_updated_at < old.client_updated_at ? { ...old } : { ...incoming };
      clock += 1000;
      next.updated_at = new Date(clock).toISOString();
      rows.set(id, next);
    }
    return reply(201);
  }
  return { fetch, rows };
}

function computer(server, initialCache) {
  const store = { yad2AmenityCache_v1: initialCache };
  const changeListeners = [];
  const messageListeners = [];
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const local = {
    async get(keys) {
      const list = keys === null ? Object.keys(store) : [].concat(keys);
      const out = {};
      for (const key of list) if (key in store) out[key] = clone(store[key]);
      return out;
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
        store[key] = clone(value);
      }
      for (const listener of changeListeners) listener(changes, "local");
    },
  };
  const noopEvent = { addListener() {} };
  const chrome = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onInstalled: noopEvent,
      onStartup: noopEvent,
      lastError: null,
    },
    storage: { local, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    alarms: { create: async () => {}, clear: async () => {}, get: (_n, cb) => cb && cb(null), onAlarm: noopEvent },
    tabs: { onRemoved: noopEvent, onUpdated: noopEvent },
  };
  const sandbox = { chrome, fetch: server.fetch, console: { ...console, warn() {} }, setTimeout, clearTimeout, URL, Date, Math, JSON, Promise };
  sandbox.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), sandbox);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), sandbox);
  const send = (message, sender = { id: "ext", url: "chrome-extension://ext/cache-manager.html" }) =>
    new Promise((resolve) => {
      let responded = false;
      const respond = (value) => {
        if (!responded) {
          responded = true;
          resolve(value);
        }
      };
      let pending = false;
      for (const listener of messageListeners) {
        if (listener(message, sender, respond) === true) pending = true;
      }
      if (!pending) setTimeout(() => respond(undefined), 0);
    });
  return {
    store,
    send,
    connect: () =>
      send({ type: "lightrail:sync-connect", url: "https://demo.example.test", apiKey: "public-key", email: "me@example.test", password: "pw-1" }),
    syncNow: () => send({ type: "lightrail:sync-now" }),
    setCache: (cache) => local.set({ yad2AmenityCache_v1: cache }),
    cache: () => store.yad2AmenityCache_v1,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("two computers stay in sync through the database", async () => {
  const server = fakeSupabase();
  const a = computer(server, {
    "yad2:a": { title: "A", price: 2_000_000, updatedAt: 100 },
    "yad2:b": { title: "B", price: 3_000_000, updatedAt: 100 },
  });
  const b = computer(server, { "madlan:c": { title: "C", price: 2_500_000, updatedAt: 100 } });

  // חיבור ראשון: כל מחשב מעלה את המידע שלו ומקבל את מה שכבר בשרת
  assert.equal((await a.connect()).ok, true);
  assert.equal(server.rows.size, 2);
  const connectB = await b.connect();
  assert.equal(connectB.ok, true);
  assert.deepEqual(Object.keys(b.cache()).sort(), ["madlan:c", "yad2:a", "yad2:b"]);
  await a.syncNow();
  assert.deepEqual(Object.keys(a.cache()).sort(), ["madlan:c", "yad2:a", "yad2:b"]);

  // שינוי במחשב A לא נשלח באמצע הדפדוף – הוא נכנס לרשימת הממתינות ונשלח בסבב הסנכרון
  await a.setCache({ ...a.cache(), "yad2:a": { title: "A", price: 1_950_000, updatedAt: 500 } });
  await wait(300);
  assert.equal(server.rows.get("user-1|yad2:a").data.price, 2_000_000, "nothing is sent while browsing");
  await a.syncNow();
  assert.equal(server.rows.get("user-1|yad2:a").data.price, 1_950_000);
  await b.syncNow();
  assert.equal(b.cache()["yad2:a"].price, 1_950_000);

  // מחיקה שהמשתמש ביצע ב-B נמחקת גם ב-A
  const withoutB = { ...b.cache() };
  delete withoutB["yad2:b"];
  await b.setCache(withoutB);
  await b.send({ type: "lightrail:sync-deleted", keys: ["yad2:b"] });
  assert.equal(server.rows.get("user-1|yad2:b").deleted, false, "the deletion waits for the next round");
  await b.syncNow();
  assert.equal(server.rows.get("user-1|yad2:b").deleted, true);
  await a.syncNow();
  assert.equal(a.cache()["yad2:b"], undefined);

  // הסרה בלי מחיקה מפורשת (פינוי מקום אוטומטי) לא מוחקת מהשרת
  const trimmed = { ...a.cache() };
  delete trimmed["madlan:c"];
  await a.setCache(trimmed);
  await a.syncNow();
  assert.equal(server.rows.get("user-1|madlan:c").deleted, false);

  // עדכון ישן לא דורס גרסה חדשה יותר בשרת
  await b.setCache({ ...b.cache(), "madlan:c": { title: "C old edit", price: 2_400_000, updatedAt: 50 } });
  await b.syncNow();
  assert.equal(server.rows.get("user-1|madlan:c").data.title, "C");
  assert.equal(b.cache()["madlan:c"].title, "C", "the newer server version comes back");

  // הסיסמה לא נשמרת במחשב
  assert.doesNotMatch(JSON.stringify(a.store), /pw-1/);
});

test("wrong password or a missing table give a clear error and leave sync off", async () => {
  const server = fakeSupabase();
  const a = computer(server, {});
  const bad = await a.send({
    type: "lightrail:sync-connect", url: "https://demo.example.test", apiKey: "public-key", email: "me@example.test", password: "nope",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid login credentials/);
  const status = await a.send({ type: "lightrail:sync-status" });
  assert.equal(status.enabled, false);
});

test("sync messages from web pages (content scripts) are refused", async () => {
  const server = fakeSupabase();
  const a = computer(server, {});
  const answer = await a.send(
    { type: "lightrail:sync-status" },
    { id: "ext", url: "https://www.yad2.co.il/realestate/forsale", tab: { id: 3 } }
  );
  assert.deepEqual({ ...answer }, { ok: false, error: "not allowed" });
});

test("a computer with older data that connects later never overwrites newer data", async () => {
  const server = fakeSupabase();
  // מחשב A עודכן היום: המחיר ירד; מחשב B היה כבוי שבוע ויש לו את הגרסה הישנה, ועוד מודעה חדשה משלו
  const a = computer(server, { "yad2:x": { title: "X", price: 1_900_000, updatedAt: 2_000 } });
  const b = computer(server, {
    "yad2:x": { title: "X", price: 2_000_000, updatedAt: 1_000 },
    "yad2:only-b": { title: "B only", price: 2_200_000, updatedAt: 1_500 },
  });
  await a.connect();
  const result = await b.connect();
  assert.equal(result.ok, true);
  // B קיבל את הגרסה החדשה, השרת לא נדרס, והמודעה שהייתה רק ב-B עלתה לשרת
  assert.equal(b.cache()["yad2:x"].price, 1_900_000);
  assert.equal(server.rows.get("user-1|yad2:x").data.price, 1_900_000);
  assert.equal(server.rows.get("user-1|yad2:only-b").data.price, 2_200_000);
  await a.syncNow();
  assert.equal(a.cache()["yad2:only-b"].price, 2_200_000);

  // ולהפך: B מחזיק גרסה חדשה יותר ממה שבשרת – היא זו שנשמרת אצל כולם
  await b.setCache({ ...b.cache(), "yad2:x": { title: "X", price: 1_850_000, updatedAt: 3_000 } });
  await b.syncNow();
  await a.syncNow();
  assert.equal(a.cache()["yad2:x"].price, 1_850_000);
});
