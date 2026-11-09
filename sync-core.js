// סנכרון אונליין (אופציונלי) מול Supabase של המשתמש עצמו.
// אין כאן שום כתובת, מפתח או משתמש קבועים: כל משתמש מזין את פרטי הפרויקט שלו במסך "סנכרון אונליין",
// והם נשמרים רק ב-chrome.storage.local במחשב שלו. הסיסמה לא נשמרת בכלל – רק אסימון כניסה מתחדש.
var LRSync = (() => {
  const SETTINGS_KEY = "lightrailSync";
  const HASHES_KEY = "lightrailSyncHashes";
  const TOMBSTONES_KEY = "lightrailSyncTombstones";
  const CACHE_KEY = "yad2AmenityCache_v1";
  const TABLE = "lightrail_records";
  const DEALS_TABLE = "lightrail_deals";
  const DEALS_KEY = "lightrailDeals";
  const DEAL_HASHES_KEY = "lightrailSyncDealHashes";
  const PUSH_CHUNK = 200;
  const PULL_PAGE = 1000;
  // חפיפה בקריאת שינויים: שורה שנכתבה ממש לפני שינוי מאוחר יותר לא תפוספס
  const PULL_OVERLAP_MS = 10_000;

  // פקודת ההקמה שהמשתמש מריץ פעם אחת ב-SQL Editor של הפרויקט שלו.
  // כל משתמש רואה ומשנה רק את השורות שלו (Row Level Security).
  const SETUP_SQL = `-- Light-rail extension: adds one table (lightrail_records) to this database
create table if not exists public.${TABLE} (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null,
  data jsonb,
  deleted boolean not null default false,
  client_updated_at bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, key)
);

create index if not exists ${TABLE}_sync_idx on public.${TABLE} (user_id, updated_at);

alter table public.${TABLE} enable row level security;

drop policy if exists "${TABLE} select own" on public.${TABLE};
drop policy if exists "${TABLE} insert own" on public.${TABLE};
drop policy if exists "${TABLE} update own" on public.${TABLE};
create policy "${TABLE} select own" on public.${TABLE} for select using (auth.uid() = user_id);
create policy "${TABLE} insert own" on public.${TABLE} for insert with check (auth.uid() = user_id);
create policy "${TABLE} update own" on public.${TABLE} for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at is set by the server. An update older than the stored version is ignored,
-- but the row is touched so every computer downloads the newer version again.
create or replace function public.${TABLE}_touch() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.client_updated_at < old.client_updated_at then
    new := old;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists ${TABLE}_touch on public.${TABLE};
create trigger ${TABLE}_touch before insert or update on public.${TABLE}
  for each row execute function public.${TABLE}_touch();

-- Real deals (tax authority) seen on Yad2 and Madlan: a separate table, one row per deal.
-- deal_key = city | street (normalized) | house number | sale date | price, built the same way on
-- every computer, so the same deal from both sites is one row. A second write never overwrites a value:
-- it only fills empty columns and adds its source, so the order of writes does not matter.
create table if not exists public.${DEALS_TABLE} (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  deal_key text not null,
  city text not null,
  street text not null,
  house text not null,
  sale_date date not null,
  price bigint not null check (price > 0),
  sqm numeric,
  rooms numeric,
  floor integer,
  total_floors integer,
  build_year integer,
  neighborhood text,
  property_type text,
  sources text[] not null default '{}',
  first_seen_at bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, deal_key)
);

create index if not exists ${DEALS_TABLE}_sync_idx on public.${DEALS_TABLE} (user_id, updated_at);
create index if not exists ${DEALS_TABLE}_place_idx on public.${DEALS_TABLE} (user_id, city, street);

alter table public.${DEALS_TABLE} enable row level security;

drop policy if exists "${DEALS_TABLE} select own" on public.${DEALS_TABLE};
drop policy if exists "${DEALS_TABLE} insert own" on public.${DEALS_TABLE};
drop policy if exists "${DEALS_TABLE} update own" on public.${DEALS_TABLE};
create policy "${DEALS_TABLE} select own" on public.${DEALS_TABLE} for select using (auth.uid() = user_id);
create policy "${DEALS_TABLE} insert own" on public.${DEALS_TABLE} for insert with check (auth.uid() = user_id);
create policy "${DEALS_TABLE} update own" on public.${DEALS_TABLE} for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.${DEALS_TABLE}_merge() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.sqm := coalesce(old.sqm, new.sqm);
    new.rooms := coalesce(old.rooms, new.rooms);
    new.floor := coalesce(old.floor, new.floor);
    new.total_floors := coalesce(old.total_floors, new.total_floors);
    new.build_year := coalesce(old.build_year, new.build_year);
    new.neighborhood := coalesce(old.neighborhood, new.neighborhood);
    new.property_type := coalesce(old.property_type, new.property_type);
    new.first_seen_at := least(old.first_seen_at, new.first_seen_at);
    new.sources := array(select distinct unnest(old.sources || new.sources) order by 1);
    if new is not distinct from old then
      return null; -- nothing new: keep the row (and its updated_at) as it was
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists ${DEALS_TABLE}_merge on public.${DEALS_TABLE};
create trigger ${DEALS_TABLE}_merge before insert or update on public.${DEALS_TABLE}
  for each row execute function public.${DEALS_TABLE}_merge();
`;

  // ---------- פונקציות טהורות (נבדקות בבדיקות) ----------

  // FNV-1a על ה-JSON של הרשומה: מזהה רשומות שהשתנו מאז הסנכרון האחרון
  function hashRecord(record) {
    const text = JSON.stringify(record === undefined ? null : record);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36) + ":" + text.length.toString(36);
  }

  // כתובת הפרויקט: https בלבד (מלבד localhost לפיתוח), בלי נתיב וסלאש בסוף
  function normalizeProjectUrl(value) {
    const text = String(value || "").trim();
    if (!text) throw new Error("חסרה כתובת הפרויקט.");
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw new Error("כתובת הפרויקט אינה תקינה.");
    }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("כתובת הפרויקט חייבת להתחיל ב-https://");
    }
    return `${url.protocol}//${url.host}`;
  }

  // רשומות מקומיות שהשתנו מאז הסנכרון האחרון (לפי hash)
  function changedKeys(cache, hashes) {
    const changed = [];
    const known = hashes && typeof hashes === "object" ? hashes : {};
    for (const [key, record] of Object.entries(cache && typeof cache === "object" ? cache : {})) {
      if (!record || typeof record !== "object") continue;
      if (known[key] !== hashRecord(record)) changed.push(key);
    }
    return changed;
  }

  // מיזוג שורות מהשרת לתוך המטמון המקומי. הגרסה עם updatedAt מאוחר יותר מנצחת.
  // מחזיר מטמון חדש (או אותו אובייקט אם אין שינוי) ואת ה-hash-ים שצריך לעדכן.
  function mergeRemoteRows(cache, rows) {
    const base = cache && typeof cache === "object" ? cache : {};
    let next = base;
    const hashUpdates = {};
    let applied = 0;
    const ensureCopy = () => {
      if (next === base) next = { ...base };
    };
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.key !== "string" || !row.key) continue;
      const remoteAt = Number(row.client_updated_at) || 0;
      const local = next[row.key];
      const localAt = local && Number.isFinite(local.updatedAt) ? local.updatedAt : 0;
      if (row.deleted) {
        if (local && localAt <= remoteAt) {
          ensureCopy();
          delete next[row.key];
          applied++;
        }
        if (!local || localAt <= remoteAt) hashUpdates[row.key] = null;
        continue;
      }
      if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) continue;
      const remoteHash = hashRecord(row.data);
      if (local && hashRecord(local) === remoteHash) {
        hashUpdates[row.key] = remoteHash;
        continue;
      }
      if (!local || localAt <= remoteAt) {
        ensureCopy();
        next[row.key] = row.data;
        hashUpdates[row.key] = remoteHash;
        applied++;
      }
      // אחרת הגרסה המקומית חדשה יותר – היא תישלח לשרת בסבב הבא
    }
    return { cache: next, hashUpdates, applied };
  }

  // עסקה מקומית ↔ שורה בטבלת העסקאות (עמודות אמיתיות, כדי שאפשר יהיה לשאול עליהן ב-Supabase)
  function dealToRow(key, deal, userId) {
    const number = (value) => (Number.isFinite(value) ? value : null);
    return {
      user_id: userId,
      deal_key: key,
      city: deal.city,
      street: deal.street,
      house: deal.house,
      sale_date: deal.date,
      price: Math.round(deal.price),
      sqm: number(deal.sqm),
      rooms: number(deal.rooms),
      floor: Number.isFinite(deal.floor) ? Math.round(deal.floor) : null,
      total_floors: Number.isFinite(deal.totalFloors) ? Math.round(deal.totalFloors) : null,
      build_year: Number.isFinite(deal.buildYear) ? Math.round(deal.buildYear) : null,
      neighborhood: deal.neighborhood || null,
      property_type: deal.propertyType || null,
      sources: Array.isArray(deal.sources) ? deal.sources : [],
      first_seen_at: number(deal.firstSeenAt),
    };
  }

  function rowToDeal(row) {
    if (!row || typeof row.deal_key !== "string" || !row.deal_key) return null;
    const number = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
    return {
      key: row.deal_key,
      deal: {
        city: row.city,
        street: row.street,
        house: row.house,
        neighborhood: row.neighborhood || null,
        date: String(row.sale_date || "").slice(0, 10),
        price: number(row.price),
        sqm: number(row.sqm),
        rooms: number(row.rooms),
        floor: number(row.floor),
        totalFloors: number(row.total_floors),
        buildYear: number(row.build_year),
        propertyType: row.property_type || null,
        sources: Array.isArray(row.sources) ? row.sources : [],
      },
    };
  }

  function chunk(list, size) {
    const out = [];
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
    return out;
  }

  // ---------- גישה ל-Supabase (Auth + REST) ----------

  // בקשה שלא נענית לא נשארת תלויה לנצח: בלי זה סבב סנכרון אחד תקוע חסם את כל הסבבים הבאים
  // (הם מחכים בתור) ואת כפתור "סנכרון עכשיו"
  const REQUEST_TIMEOUT_MS = 30_000;

  // אחרי בקשה שנכשלה: האם השרת בכלל זמין? בקשת no-cors מצליחה (תשובה "אטומה") כל עוד יש חיבור לשרת,
  // גם כשהוא מחזיר שגיאה בלי כותרות CORS. כך מבדילים בין "אין אינטרנט" ל"Supabase מחזיר שגיאה".
  async function serverReachable(url) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10_000) : null;
    try {
      await fetch(`${url}/auth/v1/health`, { mode: "no-cors", ...(controller ? { signal: controller.signal } : {}) });
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function call(settings, path, { method = "GET", body, token, headers = {} } = {}) {
    let response;
    let text;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), settings.requestTimeoutMs || REQUEST_TIMEOUT_MS) : null;
    try {
      response = await fetch(`${settings.url}${path}`, {
        method,
        headers: {
          apikey: settings.apiKey,
          Authorization: `Bearer ${token || settings.apiKey}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(controller ? { signal: controller.signal } : {}),
      });
      text = await response.text();
    } catch (error) {
      const timedOut = controller && controller.signal.aborted;
      if (timer) clearTimeout(timer);
      const reachable = timedOut ? null : await serverReachable(settings.url);
      throw Object.assign(
        new Error(timedOut
          ? "שרת הסנכרון לא ענה בזמן (30 שניות). ננסה שוב בסבב הבא."
          : reachable
            // השרת עונה, אבל בלי הרשאת CORS – כך נראית שגיאה של Supabase עצמה (למשל פרויקט מושהה)
            ? "השרת של Supabase עונה אבל מחזיר שגיאה – כנראה שהפרויקט מושהה או לא זמין. היכנסו ללוח הבקרה של Supabase והפעילו אותו (Restore project)."
            : "אין חיבור לשרת הסנכרון – בדקו את חיבור האינטרנט ואת כתובת הפרויקט."),
        { offline: !reachable, serverError: Boolean(reachable), timedOut: Boolean(timedOut), cause: error }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      const message =
        (data && (data.error_description || data.msg || data.message || data.error)) ||
        `שגיאה ${response.status}`;
      throw Object.assign(new Error(String(message)), { status: response.status, code: data && data.code });
    }
    return data;
  }

  function sessionFrom(data) {
    if (!data || !data.access_token || !data.refresh_token) throw new Error("הכניסה נכשלה.");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      userId: data.user && data.user.id,
      email: data.user && data.user.email,
    };
  }

  async function signIn(settings, email, password) {
    const data = await call(settings, "/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });
    return sessionFrom(data);
  }

  async function refreshSession(settings) {
    const data = await call(settings, "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: settings.refreshToken },
    });
    return sessionFrom(data);
  }

  // בודק שהטבלה קיימת (אחרי הרצת פקודת ההקמה)
  async function checkTable(settings) {
    try {
      await call(settings, `/rest/v1/${TABLE}?select=key&limit=1`, { token: settings.accessToken });
      return true;
    } catch (error) {
      if (error.status === 404 || error.code === "42P01" || error.code === "PGRST205") return false;
      throw error;
    }
  }

  async function upsertRows(settings, rows) {
    if (!rows.length) return;
    await call(settings, `/rest/v1/${TABLE}?on_conflict=user_id,key`, {
      method: "POST",
      token: settings.accessToken,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: rows,
    });
  }

  // טבלת העסקאות נוספה אחרי טבלת המודעות: מי שהריץ את פקודת ההקמה הישנה צריך להריץ אותה שוב.
  // עד אז סנכרון המודעות ממשיך כרגיל, ורק העסקאות לא נשלחות.
  async function checkDealsTable(settings) {
    try {
      await call(settings, `/rest/v1/${DEALS_TABLE}?select=deal_key&limit=1`, { token: settings.accessToken });
      return true;
    } catch (error) {
      if (error.status === 404 || error.code === "42P01" || error.code === "PGRST205") return false;
      throw error;
    }
  }

  async function upsertDealRows(settings, rows) {
    if (!rows.length) return;
    await call(settings, `/rest/v1/${DEALS_TABLE}?on_conflict=user_id,deal_key`, {
      method: "POST",
      token: settings.accessToken,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: rows,
    });
  }

  async function fetchDealChangesSince(settings, sinceIso) {
    const query =
      `select=deal_key,city,street,house,sale_date,price,sqm,rooms,floor,total_floors,build_year,neighborhood,property_type,sources,updated_at` +
      `&updated_at=gt.${encodeURIComponent(sinceIso)}&order=updated_at.asc&limit=${PULL_PAGE}`;
    return (await call(settings, `/rest/v1/${DEALS_TABLE}?${query}`, { token: settings.accessToken })) || [];
  }

  async function fetchChangesSince(settings, sinceIso) {
    const query =
      `select=key,data,deleted,client_updated_at,updated_at` +
      `&updated_at=gt.${encodeURIComponent(sinceIso)}&order=updated_at.asc&limit=${PULL_PAGE}`;
    return (await call(settings, `/rest/v1/${TABLE}?${query}`, { token: settings.accessToken })) || [];
  }

  return {
    SETTINGS_KEY,
    HASHES_KEY,
    TOMBSTONES_KEY,
    CACHE_KEY,
    TABLE,
    DEALS_TABLE,
    DEALS_KEY,
    DEAL_HASHES_KEY,
    dealToRow,
    rowToDeal,
    checkDealsTable,
    upsertDealRows,
    fetchDealChangesSince,
    PUSH_CHUNK,
    PULL_PAGE,
    PULL_OVERLAP_MS,
    SETUP_SQL,
    hashRecord,
    normalizeProjectUrl,
    changedKeys,
    mergeRemoteRows,
    chunk,
    signIn,
    refreshSession,
    checkTable,
    upsertRows,
    fetchChangesSince,
  };
})();

if (typeof module !== "undefined") module.exports = LRSync;
