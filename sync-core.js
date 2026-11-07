// סנכרון אונליין (אופציונלי) מול Supabase של המשתמש עצמו.
// אין כאן שום כתובת, מפתח או משתמש קבועים: כל משתמש מזין את פרטי הפרויקט שלו במסך "סנכרון אונליין",
// והם נשמרים רק ב-chrome.storage.local במחשב שלו. הסיסמה לא נשמרת בכלל – רק אסימון כניסה מתחדש.
var LRSync = (() => {
  const SETTINGS_KEY = "lightrailSync";
  const HASHES_KEY = "lightrailSyncHashes";
  const TOMBSTONES_KEY = "lightrailSyncTombstones";
  const CACHE_KEY = "yad2AmenityCache_v1";
  const TABLE = "lightrail_records";
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

  function chunk(list, size) {
    const out = [];
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
    return out;
  }

  // ---------- גישה ל-Supabase (Auth + REST) ----------

  async function call(settings, path, { method = "GET", body, token, headers = {} } = {}) {
    let response;
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
      });
    } catch (error) {
      throw Object.assign(new Error("אין חיבור לשרת הסנכרון."), { offline: true, cause: error });
    }
    const text = await response.text();
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
