const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LRSync = require("../sync-core.js");
const LRListingStore = require("../listing-store.js");

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

test("a request the server never answers times out instead of blocking every later sync", async () => {
  const originalFetch = globalThis.fetch;
  // שרת שלא עונה בכלל: הבקשה נגמרת רק כשמבטלים אותה
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  try {
    const started = Date.now();
    await assert.rejects(
      LRSync.checkTable({ url: "https://demo.example.test", apiKey: "k", accessToken: "t", requestTimeoutMs: 50 }),
      (error) => error.timedOut === true && /לא ענה בזמן/.test(error.message)
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed request says whether the internet is down or Supabase answers with an error", async () => {
  const originalFetch = globalThis.fetch;
  const settings = { url: "https://demo.example.test", apiKey: "k", accessToken: "t" };
  try {
    // השרת זמין (בדיקת no-cors עוברת) אבל הבקשה עצמה נחסמת – כמו פרויקט מושהה בלי כותרות CORS
    globalThis.fetch = async (_url, options = {}) => {
      if (options.mode === "no-cors") return { ok: false, status: 0, type: "opaque" };
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(LRSync.checkTable(settings), (error) => error.serverError === true && /מושהה/.test(error.message));
    // אין חיבור בכלל
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(LRSync.checkTable(settings), (error) => error.offline === true && /חיבור האינטרנט/.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the setup SQL creates one table with row level security and no fixed project details", () => {
  assert.match(LRSync.SETUP_SQL, /create table if not exists public\.lightrail_records/);
  assert.match(LRSync.SETUP_SQL, /enable row level security/);
  assert.match(LRSync.SETUP_SQL, /auth\.uid\(\) = user_id/);
  assert.doesNotMatch(LRSync.SETUP_SQL, /supabase\.co|password|secret/i);
});

// ---------- שני מחשבים מול שרת Supabase מדומה ----------

function fakeSupabase({ withDeals = false } = {}) {
  const rows = new Map(); // `${user}|${key}` -> row
  const dealRows = new Map(); // `${user}|${deal_key}` -> row
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
    if (withDeals && parsed.pathname === "/rest/v1/lightrail_deals") {
      if ((options.method || "GET") === "GET") {
        const filter = parsed.searchParams.get("updated_at");
        const since = filter ? Date.parse(filter.replace(/^gt\./, "")) : -Infinity;
        const limit = Number(parsed.searchParams.get("limit")) || 1000;
        return reply(200, [...dealRows.values()]
          .filter((row) => row.user_id === userId && Date.parse(row.updated_at) > since)
          .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
          .slice(0, limit)
          .map(({ user_id, ...row }) => row));
      }
      for (const incoming of body) {
        if (incoming.user_id !== userId) return reply(403, { message: "row level security" });
        const id = `${userId}|${incoming.deal_key}`;
        const old = dealRows.get(id);
        // אותה לוגיקה כמו הטריגר lightrail_deals_merge: משלימים חסרים ומאחדים מקורות
        let next = { ...incoming };
        if (old) {
          next = { ...old };
          for (const field of ["sqm", "rooms", "floor", "total_floors", "build_year", "neighborhood", "property_type"]) {
            if (next[field] === null || next[field] === undefined) next[field] = incoming[field];
          }
          next.sources = [...new Set([...old.sources, ...incoming.sources])].sort();
          if (JSON.stringify(next) === JSON.stringify(old)) continue;
        }
        clock += 1000;
        next.updated_at = new Date(clock).toISOString();
        dealRows.set(id, next);
      }
      return reply(201);
    }
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
  return { fetch, rows, dealRows };
}

function computer(server, initialCache) {
  const store = { yad2AmenityCache_v1: initialCache };
  const changeListeners = [];
  const syncChangeListeners = [];
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
    async remove(keys) {
      for (const key of [].concat(keys)) delete store[key];
    },
  };
  const syncStore = {};
  const syncArea = {
    async get(keys) {
      const list = keys === null ? Object.keys(syncStore) : [].concat(keys);
      const out = {};
      for (const key of list) if (key in syncStore) out[key] = clone(syncStore[key]);
      return out;
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: clone(syncStore[key]), newValue: clone(value) };
        syncStore[key] = clone(value);
      }
      for (const listener of changeListeners) listener(changes, "sync");
      for (const listener of syncChangeListeners) listener(changes);
    },
    onChanged: { addListener: (fn) => syncChangeListeners.push(fn) },
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
    storage: { local, sync: syncArea, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    alarms: { create: async () => {}, clear: async () => {}, get: (_n, cb) => cb && cb(null), onAlarm: noopEvent },
    tabs: { onRemoved: noopEvent, onUpdated: noopEvent },
  };
  const sandbox = { chrome, fetch: server.fetch, console: { ...console, warn() {} }, setTimeout, clearTimeout, URL, URLSearchParams, Date, Math, JSON, Promise };
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), sandbox);
  };
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
    setCache: (cache) => local.set(LRListingStore.split(cache)),
    cache: () => LRListingStore.fold(store),
    setSettings: (values) => syncArea.set(values),
    settings: () => clone(syncStore),
    // עסקאות נכתבות בפורמט הישן (מפתח אחד) – הסנכרון מעביר אותן לשמירה לפי עיר
    setDeals: async (deals) => {
      for (const key of Object.keys(store)) if (key === "lightrailDeals" || key.startsWith("lightrailDeals:")) delete store[key];
      await local.set({ lightrailDeals: deals });
    },
    deals: () => {
      const all = {};
      for (const [key, value] of Object.entries(store)) if (key === "lightrailDeals" || key.startsWith("lightrailDeals:")) Object.assign(all, value);
      return all;
    },
  };
}

test("tab cache patches: old single key migrates, only the changed shard is written, deleted records stay deleted", async () => {
  const initial = {};
  for (let i = 0; i < 100; i++) initial[`yad2:a${i}`] = { updatedAt: 10, price: i };
  const pc = computer(fakeSupabase(), initial);
  const tab = { id: "ext", tab: { id: 7 }, url: "https://www.yad2.co.il/item/a1" };
  const response = await pc.send({
    type: "lightrail:cache-patch",
    puts: [
      { key: "yad2:a1", record: { updatedAt: 20, price: 111 }, existed: true },
      { key: "yad2:gone", record: { updatedAt: 20 }, existed: true },
    ],
    prunes: [],
  }, tab);
  assert.equal(response.ok, true);
  assert.deepEqual([...response.deleted], ["yad2:gone"]);
  assert.equal(LRListingStore.LEGACY_KEY in pc.store, false, "old key migrated away");
  const cache = pc.cache();
  assert.equal(cache["yad2:a1"].price, 111);
  assert.equal(Object.keys(cache).length, 100);
  assert.equal("yad2:gone" in cache, false);
});

test("real deals sync through their own table: one row per deal, sources merged, nothing overwritten", async () => {
  const Deals = require("../deals-core.js");
  const server = fakeSupabase({ withDeals: true });
  const fromYad2 = Deals.fromYad2({
    address: { city: { text: "פתח תקווה" }, street: { text: "אמיר בנימיני" }, houseNumber: 2, neighborhood: { text: "עין גנים" } },
    saleDate: "2025-04-08T00:00:00.000Z", price: 2025000, buildingMR: 85, rooms: 4, floor: 2, numberOfFloors: 3,
  });
  const fromMadlan = Deals.fromMadlan(
    { action: "sale", isFinal: true, address: "בנימיני אמיר 2", date: "2025-04-08T00:00:00Z", price: 2025000, size: 84, beds: 4, floor: 2 },
    "פתח תקווה"
  );
  const other = Deals.fromMadlan(
    { action: "sale", isFinal: true, address: "ראש פינה 30", date: "2026-10-29T00:00:00Z", price: 2400000, size: 94, beds: 3, floor: 4 },
    "פתח תקווה"
  );
  const a = computer(server, {});
  const b = computer(server, {});
  await a.setDeals(Deals.mergeAll({}, [fromYad2], 1).store);
  await b.setDeals(Deals.mergeAll({}, [fromMadlan, other], 2).store);

  await a.connect();
  await b.connect();
  await a.syncNow();

  // אותה עסקה משני האתרים = שורה אחת בשרת
  assert.equal(server.dealRows.size, 2);
  const row = server.dealRows.get(`user-1|${fromYad2.key}`);
  assert.deepEqual(row.sources, ["madlan", "yad2"]);
  assert.equal(row.sqm, 85, "the first value is kept, a later write does not overwrite it");
  assert.equal(row.neighborhood, "עין גנים");
  // שני המחשבים מחזיקים את שתי העסקאות, עם שני המקורות
  for (const pc of [a, b]) {
    assert.deepEqual(Object.keys(pc.deals()).sort(), [fromYad2.key, other.key].sort());
    assert.deepEqual(pc.deals()[fromYad2.key].sources, ["madlan", "yad2"]);
  }
  assert.equal(b.deals()[fromYad2.key].neighborhood, "עין גנים", "a missing field is filled from the other site");

  // סבב נוסף בלי שינויים לא שולח כלום
  const before = JSON.stringify([...server.dealRows.values()]);
  await a.syncNow();
  await b.syncNow();
  assert.equal(JSON.stringify([...server.dealRows.values()]), before);

  // העסקאות נמחקו מהמחשב (למשל התקנה מחדש) – הסנכרון הבא מחזיר את כולן מהשרת
  await a.setDeals({});
  await a.syncNow();
  assert.equal(Object.keys(a.deals()).length, 2);
});

test("an interrupted large deals pull resumes where it stopped instead of starting over", async () => {
  const server = fakeSupabase({ withDeals: true });
  const base = Date.parse("2026-11-01T00:00:00Z");
  for (let index = 0; index < 2500; index++) {
    const key = `פתח תקווה|רוטשילד|${index + 1}|2025-01-01|${2_000_000 + index}`;
    server.dealRows.set(`user-1|${key}`, {
      user_id: "user-1", deal_key: key, city: "פתח תקווה", street: "רוטשילד", house: String(index + 1),
      sale_date: "2025-01-01", price: 2_000_000 + index, sqm: 100, rooms: 4, floor: null, total_floors: null,
      build_year: null, neighborhood: null, property_type: null, sources: ["yad2"],
      updated_at: new Date(base + index * 1000).toISOString(),
    });
  }
  // הבקשה השנייה של עמוד עסקאות נכשלת פעם אחת – כמו סבב שנקטע באמצע
  const dealGets = [];
  let failNext = 2;
  const originalFetch = server.fetch;
  server.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    // (בקשת הספירה "כמה השתנו" – limit=1 – לא נחשבת עמוד)
    if (parsed.pathname === "/rest/v1/lightrail_deals" && (options.method || "GET") === "GET" && parsed.searchParams.get("updated_at") && parsed.searchParams.get("limit") !== "1") {
      dealGets.push(parsed.searchParams.get("updated_at"));
      if (--failNext === 0) throw new TypeError("Failed to fetch");
    }
    return originalFetch(url, options);
  };
  const a = computer(server, {});
  await a.connect(); // נקטע אחרי העמוד הראשון (1000 עסקאות)
  assert.equal(Object.keys(a.deals()).length, 1000);
  const firstRoundGets = dealGets.length;
  await a.syncNow();
  assert.equal(Object.keys(a.deals()).length, 2500);
  // הסבב השני התחיל מהנקודה שנשמרה, לא מההתחלה
  assert.doesNotMatch(dealGets[firstRoundGets], /1970-01-01/);
});

test("without the deals table, listings still sync and the setup SQL is shown again", async () => {
  const server = fakeSupabase();
  const a = computer(server, { "yad2:a": { title: "A", price: 1, updatedAt: 1 } });
  await a.setDeals({ k: { city: "x", street: "y", house: "1", date: "2025-01-01", price: 1000000, sources: ["yad2"] } });
  const result = await a.connect();
  assert.equal(result.ok, true);
  assert.equal(server.rows.size, 1);
  const status = await a.send({ type: "lightrail:sync-status" });
  assert.equal(status.dealsNeedsSetup, true);
  assert.match(LRSync.SETUP_SQL, /create table if not exists public\.lightrail_deals/);
  assert.match(LRSync.SETUP_SQL, /primary key \(user_id, deal_key\)/);
});

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

test("settings (excluded streets, thresholds) sync between computers and never land in the listing cache", async () => {
  const server = fakeSupabase();
  const a = computer(server, {});
  const b = computer(server, {});
  await a.connect();
  await b.connect();
  await a.setSettings({ nearM: 500, blockedStreets: ["הרצל"] });
  await a.syncNow();
  await b.syncNow();
  assert.deepEqual(b.settings(), { nearM: 500, blockedStreets: ["הרצל"] });
  assert.ok(!("lightrail:settings" in (b.cache() || {})));

  // שינוי מאוחר יותר במחשב השני מנצח וחוזר לראשון
  await new Promise((resolve) => setTimeout(resolve, 5));
  await b.setSettings({ blockedStreets: ["הרצל", "ויצמן"] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await b.syncNow();
  await a.syncNow();
  assert.deepEqual(a.settings().blockedStreets, ["הרצל", "ויצמן"]);
  assert.equal(a.settings().nearM, 500);
  assert.ok(!("lightrail:settings" in (a.cache() || {})));
});