// מטמון המודעות באחסון: מחולק ל-32 מפתחות ("חלקים") לפי hash של מפתח המודעה, במקום מפתח אחד ענק.
// כך שינוי של מודעה אחת כותב רק את החלק שלה (~1/32 מהמידע) ו-Chrome מעביר למאזינים רק אותו –
// מפתח אחד של כמה MB שנכתב מחדש בכל שינוי האט את כל הדפדפן.
// המפתח הישן (yad2AmenityCache_v1) מועבר לחלקים בפעם הראשונה שקוראים את המטמון.
const LRListingStore = (() => {
  const LEGACY_KEY = "yad2AmenityCache_v1";
  const PREFIX = "lrListingCache_";
  const SHARDS = 32;
  const SHARD_KEYS = Array.from({ length: SHARDS }, (_, i) => `${PREFIX}${String(i).padStart(2, "0")}`);
  const ALL_KEYS = [LEGACY_KEY, ...SHARD_KEYS];

  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  // FNV-1a – יציב בכל ההקשרים (לשונית, רקע, מנהל), כך שמודעה תמיד באותו חלק
  function shardIndex(key) {
    let hash = 2166136261;
    const text = String(key);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % SHARDS;
  }
  const shardKeyOf = (key) => SHARD_KEYS[shardIndex(key)];
  const isCacheKey = (key) => key === LEGACY_KEY || String(key).startsWith(PREFIX);

  // ערכי אחסון (חלקים ו/או המפתח הישן) → מטמון אחד. חלק גובר על המפתח הישן.
  function fold(values) {
    const cache = {};
    if (values && isObject(values[LEGACY_KEY])) Object.assign(cache, values[LEGACY_KEY]);
    for (const key of SHARD_KEYS) {
      if (values && isObject(values[key])) Object.assign(cache, values[key]);
    }
    return cache;
  }

  // מטמון → { חלק: רשומות } לכל 32 החלקים (גם ריקים – כדי שכתיבה מלאה תמחק רשומות שהוסרו)
  function split(cache) {
    const shards = {};
    for (const key of SHARD_KEYS) shards[key] = {};
    if (isObject(cache)) {
      for (const [key, record] of Object.entries(cache)) shards[shardKeyOf(key)][key] = record;
    }
    return shards;
  }

  // מוחק מאובייקט ערכי אחסון את החלקים ואת המפתח הישן (לגיבוי: שם המטמון נשמר כמפתח אחד)
  function stripCacheKeys(values) {
    for (const key of ALL_KEYS) delete values[key];
    return values;
  }

  async function migrate(area, values) {
    const shards = split(values[LEGACY_KEY]);
    for (const key of SHARD_KEYS) {
      if (isObject(values[key])) Object.assign(shards[key], values[key]);
    }
    await area.set(shards);
    await area.remove(LEGACY_KEY);
    return fold(shards);
  }

  // כל המטמון. אם עדיין יש מפתח ישן – מעבירים אותו לחלקים (פעם אחת)
  async function load(area) {
    const values = await area.get(ALL_KEYS);
    if (values && LEGACY_KEY in values) {
      if (isObject(values[LEGACY_KEY])) return migrate(area, values);
      await area.remove(LEGACY_KEY);
    }
    return fold(values);
  }

  // קריאה בלבד, בלי העברה (לשוניות יד2/מדלן – ההעברה נעשית ברקע ובמנהל המידע)
  async function read(area) {
    return fold(await area.get(ALL_KEYS));
  }

  // רק החלקים של המפתחות האלה – לעדכון נקודתי (הרקע ממזג כאן כתיבות מהלשוניות)
  async function loadShards(area, keys) {
    const shardKeys = [...new Set(keys.filter((key) => typeof key === "string").map(shardKeyOf))];
    if (!shardKeys.length) return { cache: {}, shardKeys };
    const legacy = await area.get(LEGACY_KEY);
    if (legacy && LEGACY_KEY in legacy) await load(area); // העברה לפני עדכון ראשון
    const values = await area.get(shardKeys);
    const cache = {};
    for (const key of shardKeys) if (isObject(values[key])) Object.assign(cache, values[key]);
    return { cache, shardKeys };
  }

  // כותב את החלקים האלה בלבד, מתוך מטמון שמכיל לפחות את כל הרשומות שלהם
  async function saveShards(area, cache, shardKeys) {
    if (!shardKeys.length) return;
    const wanted = new Set(shardKeys);
    const out = {};
    for (const key of shardKeys) out[key] = {};
    for (const [key, record] of Object.entries(cache || {})) {
      const shard = shardKeyOf(key);
      if (wanted.has(shard)) out[shard][key] = record;
    }
    await area.set(out);
  }

  // כתיבה של כל המטמון. עם previous – רק חלקים שבהם רשומה נוספה, הוסרה או הוחלפה באובייקט אחר
  async function save(area, cache, previous) {
    const next = split(cache);
    let changed = next;
    if (previous) {
      const before = split(previous);
      changed = {};
      for (const key of SHARD_KEYS) if (!sameShard(before[key], next[key])) changed[key] = next[key];
    }
    if (Object.keys(changed).length) await area.set(changed);
    return Object.keys(changed);
  }

  function sameShard(a, b) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
  }

  // שינויי חלקים שהגיעו ב-onChanged (חלק → ערך חדש) מוחלים על מטמון שבזיכרון
  function applyShardChanges(cache, changes) {
    const touched = new Set(Object.keys(changes).filter((key) => SHARD_KEYS.includes(key)));
    if (!touched.size) return cache;
    const next = {};
    for (const [key, record] of Object.entries(cache || {})) {
      if (!touched.has(shardKeyOf(key))) next[key] = record;
    }
    for (const key of touched) if (isObject(changes[key])) Object.assign(next, changes[key]);
    return next;
  }

  return {
    LEGACY_KEY,
    SHARD_KEYS,
    ALL_KEYS,
    shardKeyOf,
    isCacheKey,
    fold,
    split,
    stripCacheKeys,
    load,
    read,
    loadShards,
    saveShards,
    save,
    applyShardChanges,
  };
})();

if (typeof module !== "undefined") module.exports = LRListingStore;
