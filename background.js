// Service worker: גיאוקוד כתובות (Nominatim) + רשימת תחנות רכבת קלה (Overpass / OpenStreetMap)

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
        `cache-manager.html?scheduledRefresh=1&uncheckedOnly=${schedule.uncheckedOnly === true ? "1" : "0"}`
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
