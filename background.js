// Service worker: גיאוקוד כתובות (Nominatim) + רשימת תחנות רכבת קלה (Overpass / OpenStreetMap)
// + סנכרון אונליין אופציונלי (sync-core.js)
importScripts("sync-core.js", "deals-core.js");

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const STATIONS_TTL_MS = 7 * 24 * 3600 * 1000; // שבוע
const GEO_MIN_GAP_MS = 1050; // Nominatim: מקסימום בקשה בשנייה
const WALK_DETOUR = 1.3; // מקדם המרה מקו אווירי למרחק הליכה משוער
const WALK_M_PER_MIN = 80;
const BIAS_DEG = 0.3; // ~30 ק"מ סביב אזור הדף, לשאילתות בלי עיר
const REFRESH_SCHEDULE_KEY = "lightrailRefreshSchedule";
const REFRESH_RUNTIME_KEY = "lightrailRefreshRuntime";
const REFRESH_ALARM_NAME = "lightrail-periodic-listing-refresh";

// ---------- עזרי מרחק ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- תחנות ----------
let stationsPromise = null;

async function loadStations() {
  const { stations, stationsAt } = await chrome.storage.local.get([
    "stations",
    "stationsAt",
  ]);
  if (stations && stations.length && Date.now() - (stationsAt || 0) < STATIONS_TTL_MS) {
    return stations;
  }

  // שאילתה לפי bbox (מהירה בהרבה משאילתת area של כל המדינה)
  const query = `
[out:json][timeout:40][bbox:29.3,34.2,33.5,36.0];
(
  node["railway"="station"]["station"="light_rail"];
  node["railway"="station"]["light_rail"="yes"];
  node["railway"="tram_stop"];
  node["public_transport"="station"]["light_rail"="yes"];
);
out body;`;

  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error("Overpass HTTP " + res.status);
      const json = await res.json();
      const list = (json.elements || [])
        .filter((e) => typeof e.lat === "number")
        .map((e) => ({
          lat: e.lat,
          lon: e.lon,
          name:
            (e.tags && (e.tags["name:he"] || e.tags.name || e.tags["name:en"])) ||
            "תחנה",
        }));
      if (!list.length) throw new Error("no stations returned");
      await chrome.storage.local.set({ stations: list, stationsAt: Date.now() });
      return list;
    } catch (err) {
      lastErr = err;
    }
  }
  // אם יש מטמון ישן – עדיף ממנו מכלום
  if (stations && stations.length) return stations;
  throw lastErr || new Error("failed to load stations");
}

function getStations() {
  if (!stationsPromise) {
    stationsPromise = loadStations().catch((e) => {
      stationsPromise = null; // לאפשר ניסיון חוזר
      throw e;
    });
  }
  return stationsPromise;
}

// טעינה מוקדמת של התחנות, כדי שלא יחכו להן כשנכנסים לאתר
chrome.runtime.onInstalled.addListener(() => getStations().catch(() => {}));
chrome.runtime.onStartup.addListener(() => getStations().catch(() => {}));

async function syncRefreshAlarm() {
  const { [REFRESH_SCHEDULE_KEY]: schedule } = await chrome.storage.local.get(REFRESH_SCHEDULE_KEY);
  if (!schedule || schedule.enabled !== true) {
    await chrome.alarms.clear(REFRESH_ALARM_NAME);
    return;
  }
  const hours = Math.max(1, Math.min(168, Math.round(Number(schedule.everyHours) || 5)));
  await chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: hours * 60 });
}

chrome.runtime.onInstalled.addListener(() => {
  syncRefreshAlarm().catch((error) =>
    console.error("[lightrail-ext] failed to initialize refresh schedule", error)
  );
});
chrome.runtime.onStartup.addListener(() => {
  syncRefreshAlarm().catch((error) =>
    console.error("[lightrail-ext] failed to restore refresh schedule", error)
  );
  chrome.storage.local.get(REFRESH_RUNTIME_KEY, (result) => {
    const runtime = result && result[REFRESH_RUNTIME_KEY];
    if (!runtime || runtime.running !== true) return;
    chrome.storage.local.set({
      [REFRESH_RUNTIME_KEY]: {
        ...runtime,
        running: false,
        scheduled: false,
        lastFinishedAt: Date.now(),
        lastResult: "הדפדפן נסגר בזמן הרענון",
      },
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM_NAME) return;
  Promise.all([
    chrome.storage.local.get(REFRESH_SCHEDULE_KEY),
    chrome.storage.local.get(REFRESH_RUNTIME_KEY),
  ])
    .then(async ([scheduleResult, runtimeResult]) => {
      const schedule = scheduleResult[REFRESH_SCHEDULE_KEY];
      if (!schedule || schedule.enabled !== true) return;
      const runtime = runtimeResult[REFRESH_RUNTIME_KEY] || {};
      if (runtime.running === true && Number.isInteger(runtime.managerTabId)) {
        const activeTab = await chrome.tabs.get(runtime.managerTabId).catch(() => null);
        if (activeTab) return;
      }
      const url = chrome.runtime.getURL(
        `cache-manager.html?scheduledRefresh=1&uncheckedOnly=${schedule.uncheckedOnly === true ? "1" : "0"}&site=${
          schedule.site === "yad2" || schedule.site === "madlan" ? schedule.site : "all"
        }`
      );
      let tab = Number.isInteger(runtime.managerTabId)
        ? await chrome.tabs.get(runtime.managerTabId).catch(() => null)
        : null;
      if (tab) {
        tab = await chrome.tabs.update(tab.id, { url, active: false });
      } else {
        tab = await chrome.tabs.create({ url, active: false });
      }
      await chrome.storage.local.set({
        [REFRESH_RUNTIME_KEY]: {
          managerTabId: tab.id,
          running: true,
          scheduled: true,
          startedAt: Date.now(),
        },
      });
    })
    .catch((error) =>
      console.error("[lightrail-ext] failed to start scheduled listing refresh", error)
    );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(REFRESH_RUNTIME_KEY, (result) => {
    const runtime = result && result[REFRESH_RUNTIME_KEY];
    if (!runtime || runtime.managerTabId !== tabId) return;
    chrome.storage.local.set({
      [REFRESH_RUNTIME_KEY]: {
        managerTabId: null,
        running: false,
        scheduled: false,
        lastFinishedAt: Date.now(),
        lastResult: "הכרטיסייה נסגרה לפני סיום הרענון",
      },
    });
  });
});

// ---------- גיאוקוד ----------
let geoCache = null;
let lastGeoCall = 0;
const netQueue = []; // תור בקשות רשת; הבקשה האחרונה שנכנסה (מה שעל המסך) נענית ראשונה
const inflight = new Map(); // מפתח -> Promise, כדי לא לשאול פעמיים את אותה כתובת
let pumping = false;

async function ensureGeoCache() {
  if (geoCache) return;
  const { geo } = await chrome.storage.local.get("geo");
  geoCache = geo || {};
}

let saveTimer = null;
function scheduleGeoSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const keys = Object.keys(geoCache);
    if (keys.length > 4000) {
      for (const k of keys.slice(0, keys.length - 3000)) delete geoCache[k];
    }
    await chrome.storage.local.set({ geo: geoCache });
  }, 1000);
}

async function fetchGeo(job, attempt = 0) {
  const wait = GEO_MIN_GAP_MS - (Date.now() - lastGeoCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeoCall = Date.now();

  let url =
    NOMINATIM +
    "?format=jsonv2&addressdetails=1&limit=1&countrycodes=il&accept-language=he&q=" +
    encodeURIComponent(job.q);
  if (job.bias) {
    const { lat, lon } = job.bias;
    // viewbox: left,top,right,bottom – נותן עדיפות (לא מגביל) לאזור
    url += `&viewbox=${lon - BIAS_DEG},${lat + BIAS_DEG},${lon + BIAS_DEG},${lat - BIAS_DEG}`;
  }
  const res = await fetch(url);
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 4000));
    return fetchGeo(job, attempt + 1);
  }
  if (!res.ok) throw new Error("Nominatim HTTP " + res.status);
  const arr = await res.json();
  let hit = arr && arr[0] ? { lat: +arr[0].lat, lon: +arr[0].lon } : null;
  const requestedNumber = job.q.match(/\s(\d{1,4}\s*[א-ת]?)\s*(?=,|$)/);
  if (hit && requestedNumber) {
    const foundNumber = arr[0].address && arr[0].address.house_number;
    const normalizeNumber = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
    if (normalizeNumber(foundNumber) !== normalizeNumber(requestedNumber[1])) hit = null;
  }
  geoCache[job.key] = hit;
  scheduleGeoSave();
  return hit;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (netQueue.length) {
      const job = netQueue.pop(); // LIFO: קודם מה שהמשתמש רואה עכשיו
      try {
        job.resolve(await fetchGeo(job));
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    pumping = false;
  }
}

async function geocode(q, bias) {
  await ensureGeoCache();
  // שאילתות עם הטיה מתויקות לפי האזור (עיגול ל-0.1 מעלה, ~10 ק"מ)
  const key = (bias ? `${q}|${bias.lat.toFixed(1)},${bias.lon.toFixed(1)}` : q) + "|house-check-v1";
  if (key in geoCache) return geoCache[key]; // מהמטמון: מיידי, בלי לחכות בתור
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve, reject) =>
    netQueue.push({ q, key, bias, resolve, reject })
  );
  inflight.set(key, p);
  p.then(
    () => inflight.delete(key),
    () => inflight.delete(key)
  );
  pump();
  return p;
}

// ---------- חישוב ----------
function nearest(stations, lat, lon) {
  let best = null;
  for (const s of stations) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (!best || d < best.distance) best = { ...s, distance: d };
  }
  return best;
}

// queries: [{ q, approx, bias }]  (מחרוזת פשוטה גם נתמכת)
async function lookup(queries, bias, coordinates) {
  const stations = await getStations();
  if (
    coordinates &&
    Number.isFinite(coordinates.lat) &&
    Number.isFinite(coordinates.lon) &&
    Math.abs(coordinates.lat) <= 90 &&
    Math.abs(coordinates.lon) <= 180
  ) {
    const st = nearest(stations, coordinates.lat, coordinates.lon);
    if (!st) return { ok: false, reason: "no-stations" };
    const meters = Math.round(st.distance);
    return {
      ok: true,
      approx: false,
      matched: "קואורדינטות המודעה",
      meters,
      walkMin: Math.max(1, Math.round((meters * WALK_DETOUR) / WALK_M_PER_MIN)),
      station: { name: st.name, lat: st.lat, lon: st.lon },
      origin: { lat: coordinates.lat, lon: coordinates.lon },
    };
  }
  for (let i = 0; i < queries.length; i++) {
    const qi =
      typeof queries[i] === "string"
        ? { q: queries[i], approx: i > 0, bias: false }
        : queries[i];
    const hit = await geocode(qi.q, qi.bias ? bias : null);
    if (!hit) continue;
    const st = nearest(stations, hit.lat, hit.lon);
    if (!st) return { ok: false, reason: "no-stations" };
    const meters = Math.round(st.distance);
    return {
      ok: true,
      approx: Boolean(qi.approx), // הערכה לפי שכונה/עיר/רחוב בלי עיר
      matched: qi.q,
      meters,
      walkMin: Math.max(1, Math.round((meters * WALK_DETOUR) / WALK_M_PER_MIN)),
      station: { name: st.name, lat: st.lat, lon: st.lon },
      origin: hit,
    };
  }
  return { ok: false, reason: "not-found" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "lookup" && Array.isArray(msg.queries)) {
    lookup(msg.queries, msg.bias || null, msg.coordinates || null)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: "error", error: String(err) }));
    return true; // תשובה אסינכרונית
  }
  if (msg && msg.type === "lightrail:refresh-schedule-updated") {
    syncRefreshAlarm()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[lightrail-ext] failed to update refresh schedule", error);
        sendResponse({ ok: false, error: error.message || "עדכון התזמון נכשל." });
      });
    return true;
  }
  if (msg && msg.type === "lightrail:refresh-run-started") {
    const managerTabId = _sender.tab && _sender.tab.id;
    if (!Number.isInteger(managerTabId)) {
      sendResponse({ ok: false, error: "לא ניתן לזהות את כרטיסיית מנהל המודעות." });
      return false;
    }
    chrome.storage.local.set({
      [REFRESH_RUNTIME_KEY]: {
        managerTabId,
        running: true,
        scheduled: Boolean(msg.scheduled),
        startedAt: Date.now(),
      },
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) console.error("[lightrail-ext] failed to save refresh run state", error.message);
      sendResponse(error ? { ok: false, error: error.message } : { ok: true });
    });
    return true;
  }
  if (msg && msg.type === "lightrail:refresh-run-finished") {
    const managerTabId = _sender.tab && _sender.tab.id;
    chrome.storage.local.get(REFRESH_RUNTIME_KEY, (result) => {
      const runtime = result && result[REFRESH_RUNTIME_KEY];
      if (runtime && runtime.managerTabId === managerTabId) {
        chrome.storage.local.set({
          [REFRESH_RUNTIME_KEY]: {
            managerTabId: runtime.managerTabId,
            running: false,
            scheduled: false,
            lastFinishedAt: Date.now(),
            lastResult: String(msg.result || "הסתיים"),
          },
        }, () => {
          const error = chrome.runtime.lastError;
          if (error) console.error("[lightrail-ext] failed to save refresh completion", error.message);
          sendResponse(error ? { ok: false, error: error.message } : { ok: true });
        });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }
});

// ---------- סנכרון אונליין (אופציונלי) ----------
// כבוי כברירת מחדל. כשהוא מופעל: מודעות שהשתנו נאספות לרשימת "ממתינות", ופעם בכמה דקות
// (לפי בחירת המשתמש) נשלחות בבת אחת לטבלה בפרויקט Supabase שלו, יחד עם משיכת שינויים
// ממחשבים אחרים. אין עבודת סנכרון בזמן הדפדוף בין מודעות. "סנכרון עכשיו" ופתיחת עמוד התוסף
// מסנכרנים מיד. מחיקה נשלחת לענן רק כשהמשתמש מחק בעצמו (ולא כשהתוסף מפנה מקום אוטומטית).
const SYNC_ALARM_NAME = "lightrail-online-sync";
const SYNC_INTERVALS_MIN = [1, 5, 15, 30];
const SYNC_DEFAULT_INTERVAL_MIN = 5;
let syncChain = Promise.resolve();

function syncIntervalMinutes(settings) {
  const value = Number(settings && settings.intervalMin);
  return SYNC_INTERVALS_MIN.includes(value) ? value : SYNC_DEFAULT_INTERVAL_MIN;
}

async function syncSettings() {
  const result = await chrome.storage.local.get(LRSync.SETTINGS_KEY);
  const settings = result[LRSync.SETTINGS_KEY];
  return settings && typeof settings === "object" ? settings : null;
}

async function saveSyncSettings(patch) {
  const current = (await syncSettings()) || {};
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [LRSync.SETTINGS_KEY]: next });
  return next;
}

// פעולות סנכרון רצות אחת אחרי השנייה (לא במקביל)
function queueSync(task) {
  const run = syncChain.then(task, task);
  syncChain = run.catch(() => {});
  return run;
}

async function ensureSyncSession(settings) {
  if (!settings || !settings.refreshToken) {
    throw Object.assign(new Error("יש להתחבר מחדש במסך סנכרון אונליין."), { needsLogin: true });
  }
  if (settings.accessToken && settings.expiresAt - 60_000 > Date.now()) return settings;
  try {
    const session = await LRSync.refreshSession(settings);
    return saveSyncSettings(session);
  } catch (error) {
    if (error.status === 400 || error.status === 401) {
      await saveSyncSettings({ accessToken: null, refreshToken: null, needsLogin: true });
      throw Object.assign(new Error("פג תוקף הכניסה – יש להתחבר מחדש במסך סנכרון אונליין."), { needsLogin: true });
    }
    throw error;
  }
}

async function syncPush(settings) {
  const stored = await chrome.storage.local.get([LRSync.CACHE_KEY, LRSync.HASHES_KEY, LRSync.TOMBSTONES_KEY]);
  const cache = stored[LRSync.CACHE_KEY] || {};
  const hashes = { ...(stored[LRSync.HASHES_KEY] || {}) };
  const tombstones = Array.isArray(stored[LRSync.TOMBSTONES_KEY]) ? stored[LRSync.TOMBSTONES_KEY] : [];
  const keys = LRSync.changedKeys(cache, hashes);
  let pushed = 0;
  for (const part of LRSync.chunk(keys, LRSync.PUSH_CHUNK)) {
    await LRSync.upsertRows(settings, part.map((key) => ({
      user_id: settings.userId,
      key,
      data: cache[key],
      deleted: false,
      client_updated_at: Number.isFinite(cache[key].updatedAt) ? Math.round(cache[key].updatedAt) : Date.now(),
    })));
    for (const key of part) hashes[key] = LRSync.hashRecord(cache[key]);
    pushed += part.length;
    await chrome.storage.local.set({ [LRSync.HASHES_KEY]: hashes });
  }
  // מחיקות שהמשתמש ביצע (רק אם הרשומה עדיין לא קיימת מקומית)
  const deletions = tombstones.filter((item) => item && item.key && !cache[item.key]);
  for (const part of LRSync.chunk(deletions, LRSync.PUSH_CHUNK)) {
    await LRSync.upsertRows(settings, part.map((item) => ({
      user_id: settings.userId,
      key: item.key,
      data: null,
      deleted: true,
      client_updated_at: item.at,
    })));
    for (const item of part) delete hashes[item.key];
    pushed += part.length;
  }
  await chrome.storage.local.set({ [LRSync.HASHES_KEY]: hashes, [LRSync.TOMBSTONES_KEY]: [] });
  return pushed;
}

async function syncPull(settings) {
  let cursor = settings.cursor || null;
  let since = cursor
    ? new Date(Math.max(0, Date.parse(cursor) - LRSync.PULL_OVERLAP_MS)).toISOString()
    : "1970-01-01T00:00:00Z";
  let applied = 0;
  for (;;) {
    const rows = await LRSync.fetchChangesSince(settings, since);
    if (!rows.length) break;
    const stored = await chrome.storage.local.get([LRSync.CACHE_KEY, LRSync.HASHES_KEY, LRSync.TOMBSTONES_KEY]);
    // מודעה שהמשתמש מחק כאן ומחיקתה עוד ממתינה לשליחה – לא מחזירים אותה מהשרת
    // (אלא אם מחשב אחר עדכן אותה אחרי המחיקה)
    const pendingDeletes = new Map(
      (Array.isArray(stored[LRSync.TOMBSTONES_KEY]) ? stored[LRSync.TOMBSTONES_KEY] : [])
        .filter((item) => item && item.key)
        .map((item) => [item.key, item.at])
    );
    const relevantRows = rows.filter(
      (row) => !pendingDeletes.has(row.key) || (Number(row.client_updated_at) || 0) > pendingDeletes.get(row.key)
    );
    const merge = LRSync.mergeRemoteRows(stored[LRSync.CACHE_KEY] || {}, relevantRows);
    const hashes = { ...(stored[LRSync.HASHES_KEY] || {}) };
    for (const [key, hash] of Object.entries(merge.hashUpdates)) {
      if (hash === null) delete hashes[key];
      else hashes[key] = hash;
    }
    // קודם ה-hash-ים: כך שינוי המטמון שנגרם מהמשיכה לא נשלח בחזרה לשרת
    await chrome.storage.local.set({ [LRSync.HASHES_KEY]: hashes });
    if (merge.cache !== stored[LRSync.CACHE_KEY]) {
      await chrome.storage.local.set({ [LRSync.CACHE_KEY]: merge.cache });
    }
    applied += merge.applied;
    const last = rows[rows.length - 1].updated_at;
    if (!cursor || Date.parse(last) > Date.parse(cursor)) cursor = last;
    since = last;
    if (rows.length < LRSync.PULL_PAGE) break;
  }
  if (cursor) await saveSyncSettings({ cursor });
  return applied;
}

// ---------- סנכרון עסקאות אמת (טבלה נפרדת) ----------
// אין כאן "מי מנצח": מיזוג עסקה רק משלים שדות חסרים ומאחד מקורות, גם אצלנו וגם בשרת (טריגר),
// כך שסדר הכתיבות בין המחשבים לא משנה. אין מחיקות.
async function syncDeals(settings) {
  if (!(await LRSync.checkDealsTable(settings))) {
    await saveSyncSettings({ dealsNeedsSetup: true });
    return { pulled: 0, pushed: 0, needsSetup: true };
  }
  if (settings.dealsNeedsSetup) await saveSyncSettings({ dealsNeedsSetup: false });

  // משיכה. אין עסקאות במחשב אבל כבר סונכרנו בעבר (למשל אחרי התקנה מחדש) – מושכים הכל מההתחלה,
  // אחרת המשיכה "מאז הפעם הקודמת" לא הייתה מחזירה אותן לעולם
  const localDeals = (await chrome.storage.local.get(LRSync.DEALS_KEY))[LRSync.DEALS_KEY];
  const hasLocalDeals = Boolean(localDeals && Object.keys(localDeals).length);
  let cursor = hasLocalDeals ? settings.dealsCursor || null : null;
  let since = cursor
    ? new Date(Math.max(0, Date.parse(cursor) - LRSync.PULL_OVERLAP_MS)).toISOString()
    : "1970-01-01T00:00:00Z";
  let pulled = 0;
  for (;;) {
    const rows = await LRSync.fetchDealChangesSince(settings, since);
    if (!rows.length) break;
    const stored = await chrome.storage.local.get([LRSync.DEALS_KEY, LRSync.DEAL_HASHES_KEY]);
    const before = stored[LRSync.DEALS_KEY] || {};
    const hashes = { ...(stored[LRSync.DEAL_HASHES_KEY] || {}) };
    const items = rows.map(LRSync.rowToDeal).filter(Boolean);
    const merged = LRDeals.mergeAll(before, items);
    for (const { key } of items) {
      // עסקה שהייתה מסונכרנת לפני המשיכה – מסומנת כמסונכרנת גם אחריה. עסקה עם שינוי מקומי שעוד
      // לא נשלח נשארת "שונה", כדי שהמידע הנוסף שלה יישלח לשרת בהמשך.
      const local = before[key];
      if (!local || hashes[key] === LRSync.hashRecord(local)) hashes[key] = LRSync.hashRecord(merged.store[key]);
    }
    await chrome.storage.local.set({ [LRSync.DEAL_HASHES_KEY]: hashes });
    if (merged.added || merged.updated) await chrome.storage.local.set({ [LRSync.DEALS_KEY]: merged.store });
    pulled += merged.added + merged.updated;
    const last = rows[rows.length - 1].updated_at;
    if (!cursor || Date.parse(last) > Date.parse(cursor)) cursor = last;
    since = last;
    if (rows.length < LRSync.PULL_PAGE) break;
  }
  if (cursor) await saveSyncSettings({ dealsCursor: cursor });

  // שליחה: רק עסקאות שהשתנו מאז הסנכרון האחרון
  const stored = await chrome.storage.local.get([LRSync.DEALS_KEY, LRSync.DEAL_HASHES_KEY]);
  const deals = stored[LRSync.DEALS_KEY] || {};
  const hashes = { ...(stored[LRSync.DEAL_HASHES_KEY] || {}) };
  const keys = LRSync.changedKeys(deals, hashes);
  let pushed = 0;
  for (const part of LRSync.chunk(keys, LRSync.PUSH_CHUNK)) {
    await LRSync.upsertDealRows(settings, part.map((key) => LRSync.dealToRow(key, deals[key], settings.userId)));
    for (const key of part) hashes[key] = LRSync.hashRecord(deals[key]);
    pushed += part.length;
    await chrome.storage.local.set({ [LRSync.DEAL_HASHES_KEY]: hashes });
  }
  return { pulled, pushed, needsSetup: false };
}

function runSync(reason) {
  return queueSync(async () => {
    let settings = await syncSettings();
    if (!settings || !settings.enabled) return { ok: true, skipped: true };
    try {
      settings = await ensureSyncSession(settings);
      const pulled = reason === "push" ? 0 : await syncPull(settings);
      const pushed = await syncPush(settings);
      const deals = await syncDeals(await syncSettings());
      await saveSyncSettings({
        lastDealsPulled: deals.pulled,
        lastDealsPushed: deals.pushed,
        lastSyncAt: Date.now(),
        lastError: "",
        needsLogin: false,
        ...(pulled ? { lastPulled: pulled } : {}),
        ...(pushed ? { lastPushed: pushed, lastPushAt: Date.now() } : {}),
      });
      return { ok: true, pulled, pushed };
    } catch (error) {
      console.warn("[lightrail-ext] online sync failed", error);
      await saveSyncSettings({ lastError: error.message || "הסנכרון נכשל.", lastErrorAt: Date.now() });
      return { ok: false, error: error.message || "הסנכרון נכשל.", needsLogin: Boolean(error.needsLogin) };
    }
  });
}

// תזמון קבוע לפי המרווח שנבחר. אם ההתראה כבר קיימת באותו מרווח – לא מאפסים אותה
// (אחרת כל הפעלה מחדש של הדפדפן הייתה דוחה את הסנכרון הבא).
async function updateSyncAlarm(force = false) {
  const settings = await syncSettings();
  if (!settings || !settings.enabled) {
    await chrome.alarms.clear(SYNC_ALARM_NAME);
    return;
  }
  const period = syncIntervalMinutes(settings);
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!force && existing && existing.periodInMinutes === period) return;
  await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: period, delayInMinutes: period });
}

// "ניקוי המידע השמור" (כל המטמון נמחק) הוא מקומי בלבד – הסנכרון לא שולח מחיקות בגללו,
// כי רק מחיקות מפורשות (lightrail:sync-deleted) נשלחות לענן.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) runSync("alarm");
});

chrome.runtime.onStartup.addListener(() => {
  updateSyncAlarm().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  updateSyncAlarm().catch(() => {});
});

async function connectSync(msg) {
  const url = LRSync.normalizeProjectUrl(msg.url);
  const apiKey = String(msg.apiKey || "").trim();
  const email = String(msg.email || "").trim();
  if (!apiKey) throw new Error("חסר המפתח הציבורי של הפרויקט.");
  if (!email || !msg.password) throw new Error("חסרים אימייל או סיסמה.");
  const base = { url, apiKey };
  const session = await LRSync.signIn(base, email, String(msg.password));
  const settings = { ...base, ...session };
  if (!(await LRSync.checkTable(settings))) {
    return {
      ok: false,
      needsSetup: true,
      error: "הטבלה עדיין לא קיימת. יש להריץ את פקודת ההקמה ב-SQL Editor ואז להתחבר שוב.",
    };
  }
  const previous = (await syncSettings()) || {};
  const sameAccount = previous.url === url && previous.userId === session.userId;
  await chrome.storage.local.set({
    [LRSync.SETTINGS_KEY]: {
      ...settings,
      enabled: true,
      needsLogin: false,
      lastError: "",
      intervalMin: syncIntervalMinutes(previous),
      // חשבון/פרויקט חדש: מתחילים מאפס – מושכים הכל ושולחים את כל המידע המקומי
      cursor: sameAccount ? previous.cursor || null : null,
      dealsCursor: sameAccount ? previous.dealsCursor || null : null,
    },
    ...(sameAccount ? {} : { [LRSync.HASHES_KEY]: {}, [LRSync.TOMBSTONES_KEY]: [], [LRSync.DEAL_HASHES_KEY]: {} }),
  });
  await updateSyncAlarm();
  const result = await runSync("connect");
  return { ...result, email: session.email };
}

async function disconnectSync() {
  const settings = (await syncSettings()) || {};
  // נשארים רק הכתובת, המפתח הציבורי והאימייל (כדי לא להקליד שוב); אסימוני הכניסה נמחקים
  await chrome.storage.local.set({
    [LRSync.SETTINGS_KEY]: {
      url: settings.url || "",
      apiKey: settings.apiKey || "",
      email: settings.email || "",
      intervalMin: syncIntervalMinutes(settings),
      enabled: false,
    },
  });
  await updateSyncAlarm();
  return { ok: true };
}

async function syncStatus() {
  const settings = (await syncSettings()) || {};
  return {
    ok: true,
    enabled: Boolean(settings.enabled),
    url: settings.url || "",
    apiKey: settings.apiKey || "",
    email: settings.email || "",
    needsLogin: Boolean(settings.needsLogin),
    intervalMin: syncIntervalMinutes(settings),
    nextSyncAt: settings.enabled ? ((await chrome.alarms.get(SYNC_ALARM_NAME)) || {}).scheduledTime || null : null,
    lastSyncAt: settings.lastSyncAt || null,
    lastError: settings.lastError || "",
    lastPulled: settings.lastPulled || 0,
    lastPushed: settings.lastPushed || 0,
    dealsNeedsSetup: Boolean(settings.dealsNeedsSetup),
    lastDealsPulled: settings.lastDealsPulled || 0,
    lastDealsPushed: settings.lastDealsPushed || 0,
  };
}

async function recordSyncDeletions(keys) {
  const settings = await syncSettings();
  if (!settings || !settings.enabled) return { ok: true, skipped: true };
  const stored = await chrome.storage.local.get(LRSync.TOMBSTONES_KEY);
  const list = Array.isArray(stored[LRSync.TOMBSTONES_KEY]) ? stored[LRSync.TOMBSTONES_KEY] : [];
  const at = Date.now();
  for (const key of keys) if (typeof key === "string" && key) list.push({ key, at });
  // המחיקה נכנסת לרשימת הממתינים ותישלח בסנכרון הבא
  await chrome.storage.local.set({ [LRSync.TOMBSTONES_KEY]: list });
  return { ok: true };
}

async function setSyncInterval(minutes) {
  const value = Number(minutes);
  if (!SYNC_INTERVALS_MIN.includes(value)) throw new Error("מרווח לא נתמך.");
  await saveSyncSettings({ intervalMin: value });
  await updateSyncAlarm(true);
  return syncStatus();
}

// הודעות סנכרון מתקבלות רק מעמודי התוסף עצמו (לא מסקריפטים שרצים באתרים)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("lightrail:sync-")) return false;
  const fromExtensionPage =
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""));
  if (!fromExtensionPage) {
    sendResponse({ ok: false, error: "not allowed" });
    return false;
  }
  const handlers = {
    "lightrail:sync-connect": () => connectSync(msg),
    "lightrail:sync-disconnect": () => disconnectSync(),
    "lightrail:sync-now": () => runSync("manual"),
    "lightrail:sync-status": () => syncStatus(),
    "lightrail:sync-deleted": () => recordSyncDeletions(Array.isArray(msg.keys) ? msg.keys : []),
    "lightrail:sync-interval": () => setSyncInterval(msg.minutes),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "הפעולה נכשלה." }));
  return true;
});
