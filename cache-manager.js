const CACHE_KEY = "yad2AmenityCache_v1";
const REFRESH_DELAY_KEY = "cacheRefreshDelaySec";
const REFRESH_SCHEDULE_KEY = "lightrailRefreshSchedule";
// מתי כל מודעה נפתחה לאחרונה ברענון (בכל האתרים). נשמר בנפרד מהמטמון כדי לא להתנגש בכתיבה של עמוד המודעה.
const REFRESH_LOG_KEY = "lightrailRefreshLog_v1";
let refreshLog = {};
const REFRESH_RUNTIME_KEY = "lightrailRefreshRuntime";
const REFRESH_ALARM_NAME = "lightrail-periodic-listing-refresh";
const FONT_SCALE_KEY = "cacheManagerFontScale";
const MIN_REFRESH_DELAY_SEC = 5;
const MAX_REFRESH_DELAY_SEC = 600;
const MIN_FONT_SCALE = 0.8;
const MAX_FONT_SCALE = 1.5;
const FONT_SCALE_STEP = 0.1;
const REFRESH_LOAD_TIMEOUT_MS = 90000;
const REFRESH_DEALS_MAX_WAIT_MS = 5 * 60 * 1000;
const REFRESH_DEALS_PENDING_WAIT_MS = 30 * 1000;
const AMENITIES = [
  ["parking", "חניה"],
  ["secureRoom", "ממ״ד"],
  ["elevator", "מעלית"],
  ["storage", "מחסן"],
  ["airConditioner", "מיזוג אוויר"],
  ["accessible", "נגישות"],
  ["balcony", "מרפסת"],
  ["sunBoiler", "דוד שמש"],
  ["grating", "סורגים"],
  ["garden", "גינה"],
  ["pool", "בריכה"],
];
const AMENITY_LABELS = Object.fromEntries(AMENITIES);
const $ = (id) => document.getElementById(id);
const rows = $("recordRows");
const form = $("recordForm");
const collator = new Intl.Collator("he", { numeric: true, sensitivity: "base" });
let cache = {};
let visibleRecords = [];
let selectedKey = null;
let dirtyFields = new Set();
let writing = false;
let sort = { key: "updatedAt", direction: -1 };
// מיון לפי עד 3 עמודות בטבלת המודעות (כמו ORDER BY), לפי סדר הלחיצה על הכותרות:
// לחיצה מוסיפה עמודה → הופכת כיוון → מסירה. ריק = המיון הבסיסי (sort, מתיבת "מיון מהיר").
const RECORD_SORT_MAX = 3;
let recordSorts = [];
const recordSortOrder = () => (recordSorts.length ? recordSorts : [sort]);
function recordSortInitialDirection(key) {
  return ["title", "site", "recordType", "rooms", "price", "pricePerSqm", "railMeters"].includes(key) ? 1 : -1;
}
function toggleRecordSort(key) {
  const initial = recordSortInitialDirection(key);
  const index = recordSorts.findIndex((item) => item.key === key);
  if (!recordSorts.length) {
    // לחיצה על עמודת המיון הבסיסית הופכת אותה (כמו קודם); עמודה אחרת מתחילה מיון חדש
    recordSorts = [{ key, direction: sort.key === key ? -sort.direction : initial }];
  } else if (index < 0) {
    recordSorts = [...recordSorts, { key, direction: initial }].slice(-RECORD_SORT_MAX);
  } else if (recordSorts[index].direction === initial) {
    recordSorts = recordSorts.map((item, i) => (i === index ? { key, direction: -initial } : item));
  } else {
    recordSorts = recordSorts.filter((_, i) => i !== index);
  }
}
let refreshQueue = [];
let refreshIndex = 0;
let refreshItemStartedAt = 0;
let refreshLoadMs = 0;
let refreshLoadCount = 0;
let refreshTabId = null;
let refreshTimer = null;
let loadTimeout = null;
let refreshDelaySec = 30;
let refreshPaused = false;
let refreshStarting = false;
let currentPageLoaded = false;
let refreshAttemptId = 0;
let refreshSkippedCount = 0;
let refreshRunScheduled = false;
let deleteInProgress = false;
let fontScale = 1;
let showFullPriceHistory = false;
let activeTab = "listings";
let priceTimelineFilter = "all";
let timelinePreferencesEnabled = false;
let timelinePreferences = {
  requiredAmenities: ["secureRoom"],
  removeBrokerage: false,
  calculateRail: true,
  requireRail: true,
  nearM: 800,
  calculatePpsm: true,
  maxPpsm: 0,
  irrelevantMissingPct: 50,
  dealBreakerAmenities: [],
};

// "לא רלוונטית": חסר דיל ברייקר, או חסרים מאפייני חובה לפי הסף שבהגדרות. מודעה כזו לא נכללת ברענונים.
function listingRelevance(record) {
  if (!record || recordType(record) !== "listing") {
    return { irrelevant: false, missing: [], dealBreakerMissing: [] };
  }
  return LRCacheData.amenityRelevance(
    record,
    timelinePreferences.requiredAmenities,
    timelinePreferences.irrelevantMissingPct,
    timelinePreferences.dealBreakerAmenities
  );
}

function irrelevantTitle(relevance) {
  const label = (amenity) => (AMENITIES.find(([key]) => key === amenity) || [amenity, amenity])[1];
  const reason = relevance.dealBreakerMissing && relevance.dealBreakerMissing.length
    ? `חסר דיל ברייקר: ${relevance.dealBreakerMissing.map(label).join(", ")}`
    : `חסרים ${relevance.missing.length} מתוך ${relevance.requiredCount} מאפייני החובה: ${relevance.missing.map(label).join(", ")}`;
  return `לא רלוונטית – ${reason}. מודעה כזו לא נכללת ברענונים.`;
}
// יוצר אלמנט עם מחלקה וטקסט (גלובלי: משמש את מסך הסנכרון ואת ייצוא לפי כתובות)
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const expandedPriceHistory = new Set();
const timelineAmenityLabels = {
  parking: "חניה",
  secureRoom: "ממ״ד",
  elevator: "מעלית",
  storage: "מחסן",
  airConditioner: "מיזוג",
  accessible: "נגישות",
  balcony: "מרפסת",
  sunBoiler: "דוד שמש",
  grating: "סורגים",
  garden: "גינה",
  pool: "בריכה",
};

function initializeTimelineAmenityFilters() {
  const container = $("timelineAmenityFilters");
  for (const [key, label] of AMENITIES) {
    const field = document.createElement("label");
    field.className = "timeline-choice";
    const caption = document.createElement("span");
    caption.textContent = label;
    const select = document.createElement("select");
    select.dataset.timelineAmenity = key;
    for (const [value, text] of [["", "הכול"], ["true", "כן"], ["false", "לא"], ["unknown", "לא ידוע"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    field.append(caption, select);
    container.appendChild(field);
  }
}

function initializeSearchAmenityFilters() {
  const container = $("searchAmenityFilters");
  for (const [key, label] of AMENITIES) {
    const field = document.createElement("label");
    field.className = "search-choice";
    const caption = document.createElement("span");
    caption.textContent = label;
    const select = document.createElement("select");
    select.dataset.searchAmenity = key;
    for (const [value, text] of [["", "הכול"], ["true", "כן"], ["false", "לא"], ["unknown", "לא ידוע"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    field.append(caption, select);
    container.appendChild(field);
  }
}

function initializeDeleteAmenityFilters() {
  const container = $("deleteAmenityFilters");
  for (const [key, label] of AMENITIES) {
    const field = document.createElement("label");
    field.className = "search-choice";
    const caption = document.createElement("span");
    caption.textContent = `${label} (רשות)`;
    const select = document.createElement("select");
    select.dataset.deleteAmenity = key;
    for (const [value, text] of [["", "לא מסנן"], ["false", "לא קיים"], ["true", "קיים"], ["unknown", "לא ידוע"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    field.append(caption, select);
    container.appendChild(field);
  }
}

// בחירה מרובה (סטטוס מודעה): <details data-multi-select> עם תיבות סימון
function multiSelectValues(id) {
  return [...$(id).querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function updateMultiSelectSummary(details) {
  const checked = [...details.querySelectorAll('input[type="checkbox"]:checked')];
  details.querySelector("summary").textContent = checked.length
    ? checked.map((input) => input.dataset.label || input.parentElement.textContent.trim()).join(", ")
    : details.dataset.empty || "כל הסטטוסים";
}

function setMultiSelectValues(id, values) {
  const wanted = new Set(Array.isArray(values) ? values : values ? [values] : []);
  const details = $(id);
  for (const input of details.querySelectorAll('input[type="checkbox"]')) input.checked = wanted.has(input.value);
  updateMultiSelectSummary(details);
}

function readListingDeletionFilters() {
  const filters = {
    query: $("deleteListingQuery").value.trim(),
    site: $("deleteListingSite").value,
    status: multiSelectValues("deleteListingStatus"),
    requiredAmenities: timelinePreferences.requiredAmenities,
    irrelevantMissingPct: timelinePreferences.irrelevantMissingPct,
    dealBreakerAmenities: timelinePreferences.dealBreakerAmenities,
    brokerage: document.querySelector('[data-delete-boolean="brokerage"]').value,
    railApprox: document.querySelector('[data-delete-boolean="railApprox"]').value,
    ranges: {},
    amenities: {},
  };
  for (const input of document.querySelectorAll("[data-delete-range-min], [data-delete-range-max]")) {
    const isMin = input.dataset.deleteRangeMin !== undefined;
    const key = input.dataset.deleteRangeMin || input.dataset.deleteRangeMax;
    if (!input.value.trim()) continue;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) {
      return { filters, error: "יש להזין ערך מספרי תקין וחיובי בטווחים." };
    }
    const range = filters.ranges[key] || {};
    range[isMin ? "min" : "max"] = value;
    filters.ranges[key] = range;
  }
  for (const [field, range] of Object.entries(filters.ranges)) {
    if (Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > range.max) {
      return { filters, error: "ערך „מ־” לא יכול להיות גדול מערך „עד”." };
    }
  }
  for (const select of document.querySelectorAll("[data-delete-amenity]")) {
    if (select.value) filters.amenities[select.dataset.deleteAmenity] = select.value;
  }
  return { filters, error: "" };
}

function renderListingDeletionPreview() {
  // מסך המחיקה לא מוצג – אין טעם לסנן את כל המאגר; הוא ייבנה כשעוברים אליו
  if (activeTab !== "delete") return;
  const status = $("deletePreviewStatus");
  const list = $("deletePreviewList");
  const button = $("deleteMatchingListings");
  button.textContent = "מחיקת המודעות המתאימות";
  const { filters, error } = readListingDeletionFilters();
  list.replaceChildren();
  status.dataset.error = String(Boolean(error));
  if (error) {
    status.textContent = error;
    button.disabled = true;
    return;
  }
  if (!LRCacheData.hasListingDeletionFilters(filters)) {
    status.textContent = "בחר מסנן אחד או יותר כדי להציג התאמות. ללא מסנן לא ניתן לבצע מחיקה.";
    button.disabled = true;
    return;
  }
  const matches = LRCacheData.filterListingsForDeletion(cache, filters);
  if (!matches.length) {
    status.textContent = "לא נמצאו מודעות שמתאימות לכל המסננים שבחרת.";
    button.disabled = true;
    return;
  }
  status.textContent = `נמצאו ${matches.length.toLocaleString("he-IL")} מודעות למחיקה. בדוק את הרשימה לפני ההמשך:`;
  const previewLimit = 12;
  for (const [key, record] of matches.slice(0, previewLimit)) {
    const item = document.createElement("li");
    const title = record.title || key;
    const location = [record.address, record.city].filter(Boolean).join(", ");
    const price = displayPrice(record.price);
    item.textContent = [title, location, price].filter(Boolean).join(" · ");
    list.appendChild(item);
  }
  if (matches.length > previewLimit) {
    const more = document.createElement("li");
    more.textContent = `ועוד ${(matches.length - previewLimit).toLocaleString("he-IL")} מודעות…`;
    list.appendChild(more);
  }
  button.disabled = writing || deleteInProgress;
  button.textContent = `מחיקת ${matches.length.toLocaleString("he-IL")} המודעות המתאימות`;
}

// מס רכישה: מדרגות מההגדרות (chrome.storage.sync), לעמודת "כולל מס רכישה"
let purchaseTaxSettings = LRCacheData.purchaseTaxSettingsFrom({});
const PURCHASE_TAX_KEYS = ["showPurchaseTax", "purchaseTaxTrack", "purchaseTaxTracks", "purchaseTaxExemptUpTo", "purchaseTaxBrackets"];

function loadPurchaseTaxSettings(render = false) {
  chrome.storage.sync.get(
    { showPurchaseTax: true, purchaseTaxTrack: "single", purchaseTaxTracks: null, purchaseTaxExemptUpTo: null, purchaseTaxBrackets: null },
    (settings) => {
      if (chrome.runtime.lastError || !settings) return;
      purchaseTaxSettings = LRCacheData.purchaseTaxSettingsFrom(settings);
      document.body.dataset.purchaseTax = settings.showPurchaseTax === false ? "off" : "on";
      const header = document.querySelector("th.price-tax-col");
      if (header) header.title = `המחיר ועוד מס רכישה למסלול "${purchaseTaxSettings.label}" (נבחר בהגדרות: חישובים ← מס רכישה). המדרגות נכונות לשנת 2026 – כדאי לוודא שהן עדיין מעודכנות.`;
      if (render) renderRows();
    }
  );
}

function readTimelinePreferences(settings) {
  timelinePreferences = {
    requiredAmenities: Array.isArray(settings.requiredAmenities)
      ? settings.requiredAmenities.filter((key) => AMENITIES.some(([amenity]) => amenity === key))
      : [],
    removeBrokerage: Boolean(settings.removeBrokerage),
    calculateRail: Boolean(settings.calculateRail),
    requireRail: Boolean(settings.requireRail),
    nearM: Number.isFinite(Number(settings.nearM)) ? Math.max(0, Number(settings.nearM)) : 800,
    calculatePpsm: Boolean(settings.calculatePpsm),
    maxPpsm: Number.isFinite(Number(settings.maxPpsm)) ? Math.max(0, Number(settings.maxPpsm)) : 0,
    irrelevantMissingPct: Number.isFinite(Number(settings.irrelevantMissingPct))
      ? Math.max(0, Math.min(100, Number(settings.irrelevantMissingPct)))
      : 50,
    dealBreakerAmenities: Array.isArray(settings.dealBreakerAmenities)
      ? settings.dealBreakerAmenities.filter((key) => AMENITIES.some(([amenity]) => amenity === key))
      : [],
  };
}

function passesTimelineRange(event, { field, min, max }) {
  const value = field === "price"
    ? Number.isFinite(event.currentPrice) ? event.currentPrice : event.toPrice
    : event[field];
  if (!Number.isFinite(value)) return false;
  return (min === null || value >= min) && (max === null || value <= max);
}

function passesTimelineFilters(event, filters) {
  if (!filters.ranges.every((range) => passesTimelineRange(event, range))) return false;
  const brokerageFilter = filters.brokerage;
  if (brokerageFilter === "unknown") {
    if (typeof event.brokerage === "boolean") return false;
  } else if (brokerageFilter && String(event.brokerage) !== brokerageFilter) {
    return false;
  }
  for (const [amenity, wanted] of filters.amenities) {
    const value = event.amenities && event.amenities[amenity];
    if (wanted === "unknown" ? typeof value === "boolean" : String(value) !== wanted) {
      return false;
    }
  }

  if (timelinePreferencesEnabled) {
    for (const amenity of timelinePreferences.requiredAmenities) {
      if (!event.amenities || event.amenities[amenity] !== true) return false;
    }
    if (timelinePreferences.removeBrokerage && event.brokerage === true) return false;
    if (timelinePreferences.calculateRail && timelinePreferences.requireRail) {
      if (
        !Number.isFinite(event.railMeters) ||
        event.railApprox === true ||
        event.railMeters > timelinePreferences.nearM
      ) return false;
    }
    if (timelinePreferences.calculatePpsm && timelinePreferences.maxPpsm > 0) {
      if (!Number.isFinite(event.pricePerSqm) || event.pricePerSqm > timelinePreferences.maxPpsm) {
        return false;
      }
    }
  }
  return true;
}

const SEARCH_ONLY_TITLE =
  "נשמרה מכרטיס בתוצאות החיפוש בלבד: אין עדיין מאפיינים ותאריכים מעמוד המודעה. פתיחת המודעה או רענון ישלימו את המידע.";

// ---------- מצב ענן לכל רשומה (סנכרון אונליין) ----------
// "synced" = הגרסה המקומית זהה למה שנשלח למסד הנתונים; "pending" = שונתה ועוד לא נשלחה.
// ההשוואה לפי אותו hash שהסנכרון ב-background.js שומר אחרי כל שליחה מוצלחת.
let cloudSync = { enabled: false, needsLogin: false, hashes: {}, lastPushAt: null, lastSyncAt: null, lastError: "" };
const cloudHashCache = new WeakMap();
const CLOUD_LABELS = { synced: "✓ בענן", pending: "⏳ ממתין" };

function cloudState(key, record) {
  if (!cloudSync.enabled || !record || typeof record !== "object") return "";
  let hash = cloudHashCache.get(record);
  if (!hash) {
    hash = LRSync.hashRecord(record);
    cloudHashCache.set(record, hash);
  }
  return cloudSync.hashes[key] === hash ? "synced" : "pending";
}

function cloudTime(timestamp) {
  return timestamp
    ? new Date(timestamp).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
}

function renderCloudCell(td, key, record) {
  const state = cloudState(key, record);
  td.replaceChildren();
  if (!state) return;
  const chip = document.createElement("span");
  chip.className = `cloud-chip ${state}${state === "pending" && cloudSync.lastError ? " error" : ""}`;
  chip.textContent = state === "pending" && cloudSync.lastError ? "⚠ לא נשלח" : CLOUD_LABELS[state];
  td.title =
    state === "synced"
      ? `הגרסה הזו שמורה במסד הנתונים${cloudSync.lastPushAt ? ` · שליחה אחרונה: ${cloudTime(cloudSync.lastPushAt)}` : ""}`
      : cloudSync.lastError
        ? `לא נשלח: ${cloudSync.lastError}`
        : `השתנתה במחשב הזה ונמצאת ברשימת הממתינות – תישלח ${nextSyncText()}`;
  td.appendChild(chip);
}

const columns = [
  { key: "title", label: "מודעה / כתובת", sortKey: "title", className: "record-name" },
  { key: "price", label: "מחיר", sortKey: "price", className: "price-col" },
  { key: "priceWithTax", label: "כולל מס רכישה", sortKey: "priceWithTax", className: "price-tax-col", title: "כמה הדירה תעלה בפועל: המחיר ועוד מס רכישה לפי המדרגות שבהגדרות (חישובים ← מס רכישה). המדרגות נכונות לשנת 2026 – כדאי לוודא שהן עדיין מעודכנות." },
  { key: "pricePerSqm", label: "מחיר למ״ר", sortKey: "pricePerSqm", title: "מחושב ממחיר חלקי שטח; אינו ניתן לעריכה" },
  { key: "sqm", label: "מ״ר", sortKey: "sqm" },
  // החשובים קרוב להתחלה (מימין): חדרים, קומה ומרחק מהרכבת
  { key: "rooms", label: "חדרים", sortKey: "rooms", title: "מספר החדרים שזוהה במודעה" },
  { key: "floor", label: "קומה", sortKey: "floor", title: "קומת הדירה מתוך מספר הקומות בבניין (מנתוני יד2)" },
  { key: "railMeters", label: "רכבת (מ׳)", sortKey: "railMeters", title: "מרחק בקו אווירי; עשוי להיות משוער" },
  { key: "listingStatus", label: "סטטוס מודעה", sortKey: "listingStatus", title: "נבדק ברענון הדרגתי של יד2" },
  { key: "notes", label: "הערה אישית", sortKey: "notes", className: "notes-column", title: "הערות שהוספת למודעה; לחיצה על השורה פותחת את מסך העריכה" },
  { key: "site", label: "אתר", sortKey: "site" },
  { key: "cloud", label: "ענן", sortKey: "cloud", className: "cloud-col", title: "האם הגרסה שבמחשב הזה כבר נשמרה במסד הנתונים המרוחק (מוצג רק כשסנכרון אונליין פעיל)" },
  { key: "shelterMeters", label: "מקלט ציבורי (מ׳)", sortKey: "shelterMeters", title: "מרחק למקלט הציבורי הקרוב, כפי שיד2 מציגה בעמוד המודעה" },
  { key: "listingAgeDays", label: "גיל מודעה (ימים)", sortKey: "listingAgeDays", title: "כמה ימים המודעה באוויר; מחושב ונשמר בכל שמירה או רענון של המודעה" },
  { key: "sellerPressure", label: "לחץ למכור", sortKey: "sellerPressure", title: "מדד 0–100: ימים באוויר (עד 60 נק׳), ירידת מחיר מהשיא (עד 30) ומספר הורדות (עד 10)" },
  { key: "brokerage", label: "תיווך", boolean: true, title: "כן / לא / לא ידוע" },
  ...["building", "street", "neighborhood", "city"].map((level) => ({
    key: `realDeals:${level}`,
    realLevel: level,
    label: `מול ${{ building: "הבניין", street: "הרחוב", neighborhood: "השכונה", city: "העיר" }[level]}`,
    sortKey: `realDeals:${level}`,
    title: `המחיר למ״ר של המודעה מול חציון עסקאות אמת מ-4 השנים האחרונות ${{ building: "בבניין", street: "ברחוב", neighborhood: "בשכונה", city: "בעיר" }[level]} (מינימום ${LRDeals.LEVEL_MINIMUMS[level]} עסקאות; קודם בגודל דומה). שלילי = זול מהעסקאות.`,
  })),
  { key: "dealScore", label: "ציון שווה", sortKey: "dealScore", title: "ציון משוקלל: מאפיינים, מחיר למ״ר (מול עסקאות אמת כשיש), קרבה לרכבת ותיווך" },
  ...AMENITIES.map(([key, label]) => ({
    key: `amenity:${key}`,
    amenity: key,
    label,
    boolean: true,
    title: "מאפיין הנכס: כן / לא / לא ידוע",
  })),
  { key: "type", label: "סוג", sortKey: "recordType" },
  { key: "updatedAt", label: "עדכון אחרון", sortKey: "updatedAt" },
  { key: "priceHistory", label: "היסטוריית מחיר", sortKey: "priceHistory", title: "מספר נקודות היסטוריית מחיר" },
  { key: "actions", label: "פעולות" },
];

function storageGet(key = CACHE_KEY) {
  // מטמון המודעות שמור בחלקים (listing-store.js)
  if (key === CACHE_KEY) {
    return LRListingStore.load(chrome.storage.local).catch((error) => {
      throw new Error((error && error.message) || `טעינת ${key} נכשלה.`);
    });
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || `טעינת ${key} נכשלה.`));
        return;
      }
      if (key === CACHE_KEY) {
        resolve(result && result[CACHE_KEY] && typeof result[CACHE_KEY] === "object"
          ? result[CACHE_KEY]
          : {});
      } else {
        resolve(result ? result[key] : undefined);
      }
    });
  });
}

async function storageSet(values) {
  // מטמון המודעות נכתב לחלקים שלו; שאר המפתחות כרגיל
  if (values && CACHE_KEY in values) {
    const { [CACHE_KEY]: listingCache, ...rest } = values;
    try {
      await LRListingStore.save(chrome.storage.local, listingCache);
    } catch (error) {
      throw new Error((error && error.message) || "שמירת הנתונים נכשלה.");
    }
    if (!Object.keys(rest).length) return;
    values = rest;
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || "שמירת הנתונים נכשלה."));
        return;
      }
      resolve();
    });
  });
}

function storageGetAll(area) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].get(null, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || `טעינת ${area} נכשלה.`));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSetArea(area, values) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || `שמירת ${area} נכשלה.`));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(area, keys) {
  if (!keys.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.storage[area].remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || `מחיקה מ-${area} נכשלה.`));
        return;
      }
      resolve();
    });
  });
}

async function restoreStorageArea(area, snapshot, attemptedValues) {
  await storageSetArea(area, snapshot);
  await storageRemove(
    area,
    Object.keys(attemptedValues).filter((key) => !(key in snapshot))
  );
}

// תיקוני נתונים בטעינה: תאריכי בסיס משוערים + ניקוי מחירים שפוענחו לא נכון (קפיצות כמו ₪105,000).
// קודם בודקים על המידע שכבר בידינו; קוראים שוב מהאחסון וכותבים רק אם באמת יש מה לתקן.
function applyDataFixes(source) {
  const baseline = LRCacheData.addEstimatedBaselineDates(source);
  const projects = LRCacheData.fixMisfiledProjects(baseline.cache);
  const outliers = LRCacheData.cleanPriceOutliers(projects.cache);
  return {
    cache: outliers.cache,
    baselineCount: baseline.updatedCount,
    projectFixCount: projects.updatedCount,
    priceFixCount: outliers.updatedCount,
    removedPoints: outliers.removedPoints,
  };
}

function dataFixCount(fixes) {
  return fixes.baselineCount + fixes.priceFixCount + fixes.projectFixCount;
}

async function migrateEstimatedBaselineDates(sourceCache) {
  let latestCache = sourceCache;
  try {
    const probe = applyDataFixes(sourceCache);
    if (!dataFixCount(probe)) return sourceCache;
    latestCache = await storageGet();
    const migration = applyDataFixes(latestCache);
    if (!dataFixCount(migration)) return latestCache;
    await storageSet({ [CACHE_KEY]: migration.cache });
    const notes = [];
    if (migration.projectFixCount) {
      notes.push(
        `${migration.projectFixCount.toLocaleString("he-IL")} כרטיסי פרויקט ממדלן שנשמרו כמודעות סומנו כפרויקטים`
      );
    }
    if (migration.priceFixCount) {
      notes.push(
        `תוקנו מחירים שפוענחו לא נכון ב־${migration.priceFixCount.toLocaleString("he-IL")} מודעות (${migration.removedPoints.toLocaleString("he-IL")} תצפיות שגויות הוסרו מההיסטוריה)`
      );
    }
    if (migration.baselineCount) {
      notes.push(`עודכנו ${migration.baselineCount.toLocaleString("he-IL")} תאריכי בסיס משוערים בהיסטוריית המחירים`);
    }
    setRefreshStatus(`${notes.join("; ")}.`);
    if (migration.priceFixCount) showPriceFixNotice(migration.priceFixCount, migration.removedPoints);
    return migration.cache;
  } catch (error) {
    console.error("[lightrail-ext] failed to save estimated price baseline dates", error);
    setRefreshStatus(
      `תאריך הבסיס המשוער חושב לתצוגה, אך לא נשמר במטמון: ${error.message || "שגיאת שמירה"}`,
      true
    );
    return latestCache;
  }
}

// הודעה קצרה בראש העמוד אחרי תיקון מחירים, כדי שהמשתמש יידע שהנתונים השתנו
function showPriceFixNotice(fixed, removed) {
  let notice = $("priceFixNotice");
  if (!notice) {
    notice = document.createElement("p");
    notice.id = "priceFixNotice";
    notice.className = "price-fix-notice";
    notice.setAttribute("role", "status");
    document.querySelector(".views").prepend(notice);
  }
  notice.textContent = `תוקנו מחירים שגויים ב־${fixed.toLocaleString("he-IL")} מודעות: הוסרו ${removed.toLocaleString("he-IL")} תצפיות מחיר שלא היו הגיוניות (למשל ₪105,000 לדירה של ₪2,130,000), והמחיר הנוכחי שוחזר במקרה הצורך.`;
  notice.hidden = false;
  clearTimeout(showPriceFixNotice.timer);
  showPriceFixNotice.timer = setTimeout(() => { notice.hidden = true; }, 15000);
}

function displayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("he-IL") : String(value);
}

const PRICE_FORMAT = new Intl.NumberFormat("he-IL");
function displayPrice(value) {
  return Number.isFinite(value) ? `₪${PRICE_FORMAT.format(Math.round(value))}` : "";
}

// יצירת Intl.DateTimeFormat יקרה – פעם אחת לכל העמוד
const HISTORY_DATE_FORMAT = new Intl.DateTimeFormat("he-IL-u-nu-latn", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
function displayHistoryDate(value) {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
    return "תאריך לא ידוע";
  }
  return HISTORY_DATE_FORMAT.format(new Date(value));
}

function validPriceHistory(record) {
  return Array.isArray(record && record.priceHistory)
    ? record.priceHistory.filter(
        (point) =>
          point &&
          Number.isFinite(point.price) &&
          (Number.isFinite(point.at) || point.baselineUnknown === true)
      )
    : [];
}

function priceHistoryDate(point, index, history) {
  const estimatedAt = LRCacheData.inferredPriceHistoryTimestamp(history, index);
  const timestamp = Number.isFinite(estimatedAt) ? estimatedAt : point.at;
  const date = displayHistoryDate(timestamp);
  return Number.isFinite(estimatedAt) ? `${date} (משוער)` : date;
}

function refreshableListingUrl(key, record) {
  const rawUrl = record.url || record.listingUrl || record.href || record.link || "";
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (
    recordSite(key) === "yad2" &&
    url.hostname === "www.yad2.co.il" &&
    /^\/realestate\/item\/[^/]+(?:\/[^/]+)?\/?$/.test(url.pathname)
  ) {
    return url.href;
  }
  if (
    recordSite(key) === "madlan" &&
    url.hostname === "www.madlan.co.il" &&
    /^\/(?:listings|bulletin)\/[^/]+\/?$/.test(url.pathname)
  ) {
    return url.href;
  }
  return null;
}

function listingPageUrl(key, record) {
  const rawUrl = record.url || record.listingUrl || record.href || record.link || "";
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const path = url.pathname;
  if (
    recordSite(key) === "yad2" &&
    url.hostname === "www.yad2.co.il" &&
    /^\/(?:realestate\/item|yad1\/project)\/[^/]+(?:\/[^/]+)?\/?$/.test(path)
  ) {
    return url.href;
  }
  if (
    recordSite(key) === "madlan" &&
    url.hostname === "www.madlan.co.il" &&
    /^\/(?:listings|projects)\/[^/]+\/?$/.test(path)
  ) {
    return url.href;
  }
  return null;
}

function dateInputValue(value) {
  if (!value) return "";
  const text = String(value);
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const local = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!local) return "";
  const year = local[3].length === 2 ? `20${local[3]}` : local[3];
  return `${year}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
}

function recordSite(key) {
  return key.slice(0, key.indexOf(":"));
}

function recordType(record) {
  return record && record.recordType === "project" ? "project" : "listing";
}

function amenityValue(record, key) {
  const value = record.amenities && record.amenities[key];
  return typeof value === "boolean" ? value : null;
}

function booleanText(value) {
  if (value === true) return ["כן", "yes"];
  if (value === false) return ["לא", "no"];
  return ["לא ידוע", "unknown"];
}

function textCell(value, className) {
  const span = document.createElement("span");
  span.textContent = value === undefined || value === null ? "" : String(value);
  if (className) span.className = className;
  return span;
}

function getFormField(field) {
  return form.querySelector(`[data-field="${field}"]`);
}

function appendHeaderCell(row, column) {
  const th = document.createElement("th");
  th.scope = "col";
  if (column.className) th.className = column.className;
  if (column.boolean) th.classList.add("boolean-column");
  if (column.title) th.title = column.title;
  const label = column.sortKey
    ? document.createElement("button")
    : document.createElement("span");
  label.textContent = column.label;
  if (column.sortKey) {
    label.type = "button";
    label.className = "sort-button";
    label.dataset.sort = column.sortKey;
    label.title = `${column.title ? column.title + " · " : ""}לחיצה: הוספה למיון (עד ${RECORD_SORT_MAX} עמודות, לפי סדר הלחיצה), לחיצה נוספת הופכת כיוון ושלישית מסירה`;
    label.addEventListener("click", () => {
      toggleRecordSort(column.sortKey);
      renderRows();
    });
  }
  th.appendChild(label);

  row.appendChild(th);
}

function renderHeader() {
  const header = $("gridHead");
  header.replaceChildren();
  const titles = document.createElement("tr");
  const filters = document.createElement("tr");
  filters.className = "filter-row";
  for (const column of columns) {
    appendHeaderCell(titles, column);
    const empty = document.createElement("th");
    if (column.key === "cloud") empty.className = "cloud-col";
    if (column.boolean) {
      const filter = document.createElement("select");
      filter.className = "column-filter";
      filter.dataset.booleanFilter = column.key;
      filter.setAttribute("aria-label", `סינון ${column.label}`);
      for (const [value, caption] of [["", "הכול"], ["true", "כן"], ["false", "לא"], ["unknown", "לא ידוע"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = caption;
        filter.appendChild(option);
      }
      filter.addEventListener("change", renderRows);
      empty.appendChild(filter);
    } else if (column.key !== "actions") {
      const filter = document.createElement("input");
      filter.type = "search";
      filter.className = "column-filter";
      filter.dataset.columnFilter = column.key;
      filter.setAttribute("aria-label", `חיפוש בעמודה ${column.label}`);
      filter.placeholder = "חיפוש";
      filter.addEventListener("input", scheduleRenderRows);
      empty.appendChild(filter);
    }
    filters.appendChild(empty);
  }
  header.append(titles, filters);
}

function allPriceRanks(records) {
  const entries = records
    .filter(([, record]) => record && typeof record === "object" && recordType(record) === "listing")
    .map(([key, record]) => [key, LRCacheData.pricePerSqm(record)])
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => a[1] - b[1]);
  return new Map(entries.map(([key], index) => [
    key,
    entries.length < 2 ? 0.5 : 1 - index / (entries.length - 1),
  ]));
}

// "4/6" (קומה 4 מתוך 6), "4" כשמספר הקומות לא ידוע, "קרקע" לקומה 0
function floorText(record) {
  if (!Number.isFinite(record.floor)) return "";
  const floor = record.floor === 0 ? "קרקע" : String(record.floor);
  return Number.isFinite(record.buildingTopFloor) && record.buildingTopFloor > 0
    ? `${floor}/${record.buildingTopFloor}`
    : floor;
}

function rowSortValue(key, record, priceRanks, sortKey = sort.key) {
  if (sortKey === "recordType") return recordType(record);
  if (sortKey === "site") return recordSite(key);
  if (sortKey === "pricePerSqm") return LRCacheData.pricePerSqm(record);
  if (sortKey === "priceWithTax") {
    const tax = LRCacheData.purchaseTax(record.price, purchaseTaxSettings);
    return tax ? tax.total : null;
  }
  if (sortKey === "dealScore") {
    return LRCacheData.dealScore(record, priceRanks.get(key) ?? 0.5, realDealsFor(record)?.diffPct);
  }
  if (sortKey.startsWith("realDeals:")) {
    const result = realDealsAllFor(record)[sortKey.slice("realDeals:".length)];
    return result && Number.isFinite(result.diffPct) ? result.diffPct : null;
  }
  if (sortKey === "priceHistory") {
    return validPriceHistory(record).length;
  }
  if (sortKey === "sellerPressure") {
    const pressure = sellerPressure(record);
    return pressure ? pressure.score : null;
  }
  if (sortKey === "cloud") return cloudState(key, record) || null;
  return record[sortKey];
}

function matchesBooleanFilter(record, filterKey, filterValue) {
  if (!filterValue) return true;
  let value;
  if (filterKey === "brokerage") value = record.brokerage;
  else if (filterKey === "railApprox") value = record.railApprox;
  else value = amenityValue(record, filterKey.slice("amenity:".length));
  const actual = typeof value === "boolean" ? String(value) : "unknown";
  return actual === filterValue;
}

function numericRangeForRecord(record, key) {
  if (key === "price") {
    return {
      min: record.price,
      max: Number.isFinite(record.maxPrice) ? record.maxPrice : record.price,
    };
  }
  if (key === "sqm") {
    return {
      min: record.sqm,
      max: Number.isFinite(record.maxSqm) ? record.maxSqm : record.sqm,
    };
  }
  if (key === "pricePerSqm") {
    if (
      Number.isFinite(record.price) &&
      Number.isFinite(record.maxPrice) &&
      Number.isFinite(record.sqm) &&
      Number.isFinite(record.maxSqm) &&
      record.sqm > 0 &&
      record.maxSqm > 0
    ) {
      return {
        min: Math.min(record.price, record.maxPrice) / Math.max(record.sqm, record.maxSqm),
        max: Math.max(record.price, record.maxPrice) / Math.min(record.sqm, record.maxSqm),
      };
    }
    return LRCacheData.pricePerSqm(record);
  }
  if (key === "sellerPressure") {
    const pressure = sellerPressure(record);
    return pressure ? pressure.score : null;
  }
  return record[key];
}

function activeNumericRanges(selector = "[data-range-min], [data-range-max]") {
  const ranges = new Map();
  for (const input of document.querySelectorAll(selector)) {
    const isMin = input.dataset.rangeMin !== undefined || input.dataset.searchRangeMin !== undefined;
    const key = input.dataset.rangeMin || input.dataset.rangeMax ||
      input.dataset.searchRangeMin || input.dataset.searchRangeMax;
    const edge = isMin ? "min" : "max";
    if (input.value.trim() === "") continue;
    const value = Number(input.value);
    if (!Number.isFinite(value)) continue;
    const range = ranges.get(key) || {};
    range[edge] = value;
    ranges.set(key, range);
  }
  return ranges;
}

function matchesNumericFilters(record, ranges) {
  for (const [key, range] of ranges) {
    if (!LRCacheData.matchesNumericRange(numericRangeForRecord(record, key), range.min, range.max)) {
      return false;
    }
  }
  return true;
}

function matchesSearchDateFilters(record) {
  for (const input of document.querySelectorAll("[data-search-date-min], [data-search-date-max]")) {
    if (!input.value) continue;
    const field = input.dataset.searchDateMin || input.dataset.searchDateMax;
    const edge = input.dataset.searchDateMin ? "min" : "max";
    const value = record[field];
    if (value === undefined || value === null || value === "") return false;
    let normalized = dateInputValue(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value < 1e12 ? value * 1000 : value);
      normalized = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
    }
    const timestamp = Date.parse(normalized);
    const boundary = Date.parse(input.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(boundary)) return false;
    if (edge === "min" ? timestamp < boundary : timestamp > boundary + 86400000 - 1) return false;
  }
  return true;
}

function columnFilterText(key, record, recordKey, priceRanks) {
  if (key === "title") return [record.title, record.address, record.city, record.neighborhood].filter(Boolean).join(" ");
  if (key === "notes") return record.notes || "";
  if (key === "type") return recordType(record) === "project" ? "פרויקט" : "מודעה";
  if (key === "site") return recordSite(recordKey);
  if (key === "listingStatus") {
    if (listingRelevance(record).irrelevant && record.listingStatus !== "removed") return "לא רלוונטית";
    const searchOnly = recordType(record) === "listing" && record.indexedFrom === "search"
      ? " מהחיפוש בלבד"
      : "";
    return recordSite(recordKey) === "yad2" && recordType(record) === "listing"
      ? record.listingStatus === "active"
        ? "פעילה"
        : record.listingStatus === "removed"
          ? "הוסרה"
          : `לא נבדקה${searchOnly}`
      : searchOnly.trim();
  }
  if (key === "cloud") return CLOUD_LABELS[cloudState(recordKey, record)] || "";
  if (key === "price") return `${record.price ?? ""} ${displayPrice(record.price)}`;
  if (key === "priceWithTax") {
    const tax = LRCacheData.purchaseTax(record.price, purchaseTaxSettings);
    return tax ? `${tax.total} ${displayPrice(tax.total)}` : "";
  }
  if (key === "sqm" || key === "rooms" || key === "railMeters" || key === "listingAgeDays" || key === "shelterMeters") {
    return String(record[key] ?? "");
  }
  if (key === "floor") return floorText(record);
  if (key === "sellerPressure") {
    const pressure = sellerPressure(record);
    return pressure ? `${pressure.score} ${LRCacheData.PRESSURE_LABELS[pressure.level]}` : "";
  }
  if (key === "pricePerSqm") return `${LRCacheData.pricePerSqm(record) ?? ""} ${displayPrice(LRCacheData.pricePerSqm(record))}`;
  if (key === "brokerage") return booleanText(record.brokerage)[0];
  if (key.startsWith("amenity:")) {
    return booleanText(amenityValue(record, key.slice("amenity:".length)))[0];
  }
  if (key === "updatedAt") return displayDate(record.updatedAt);
  if (key === "priceHistory") {
    const history = validPriceHistory(record);
    return history
      .map((point, index) =>
        `${point.price} ${displayPrice(point.price)} ${priceHistoryDate(point, index, history)}`
      )
      .join(" ");
  }
  if (key === "dealScore") {
    return String(LRCacheData.dealScore(record, priceRanks.get(recordKey) ?? 0.5, realDealsFor(record)?.diffPct) ?? "");
  }
  if (key.startsWith("realDeals:")) {
    return realLevelText(realDealsAllFor(record)[key.slice("realDeals:".length)]);
  }
  return "";
}

function renderBoolean(value) {
  const [label, state] = booleanText(value);
  const span = textCell(label, `boolean-value ${state}`);
  return span;
}

// הרשומות שעונות על המסננים של מסך מסוים: searchMode = "חיפוש מודעה", אחרת טבלת המודעות.
// נפרד מהציור כדי שרענון "תוצאות מסוננות" ישתמש תמיד במסנני טבלת המודעות – גם אם הטבלה
// האחרונה שצוירה הייתה מסך החיפוש (שבלי מסננים ריק) או שעוד לא צוירה בכלל.
function filterRecordsFor(searchMode) {
  const query = $(searchMode ? "listingSearchQuery" : "searchInput").value.trim().toLocaleLowerCase("he");
  const queryWords = searchWords(query);
  const site = $(searchMode ? "listingSearchSite" : "siteFilter").value;
  const type = $(searchMode ? "listingSearchType" : "typeFilter").value;
  const boolFilters = searchMode ? [] : [...document.querySelectorAll("[data-boolean-filter]")]
    .map((select) => [select.dataset.booleanFilter, select.value])
    .filter(([, value]) => value);
  // מסנני מסך החיפוש לא משפיעים על טבלת המודעות (ועל הרענון)
  const searchBoolFilters = !searchMode ? [] : [...document.querySelectorAll("[data-search-boolean]")]
    .map((select) => [select.dataset.searchBoolean, select.value])
    .filter(([, value]) => value);
  const amenityFilters = !searchMode ? [] : [...document.querySelectorAll("[data-search-amenity]")]
    .map((select) => [select.dataset.searchAmenity, select.value])
    .filter(([, value]) => value);
  const columnFilters = searchMode ? [] : [...document.querySelectorAll("[data-column-filter]")]
    .map((input) => [input.dataset.columnFilter, input.value.trim().toLocaleLowerCase("he")])
    .filter(([, value]) => value);
  const ranges = searchMode
    ? activeNumericRanges("[data-search-range-min], [data-search-range-max]")
    : activeNumericRanges();
  ensureListingAges(cache);
  const priceRanks = priceRanksFor(cache);
  // במסך החיפוש לא טוענים את כל המאגר מראש: מחכים שהמשתמש יקליד או יבחר מסנן
  const searchDates = [...document.querySelectorAll("[data-search-date-min], [data-search-date-max]")]
    .some((input) => input.value);
  const searchStatuses = searchMode ? multiSelectValues("listingSearchStatus") : [];
  // עיר: כתיב מלא או חסר לא משנה ("פתח תקוה" = "פתח תקווה"), וחלק מהשם מספיק ("רמת" = רמת גן / רמת השרון)
  if (searchMode) fillListingCities();
  const searchCities = searchMode ? multiSelectValues("listingSearchCity") : [];
  const preset = searchMode ? searchPreset : null;
  if (searchMode) renderSearchPresetChip();
  const waiting = searchMode && !(
    preset || query || site || type || searchStatuses.length || searchCities.length ||
    searchBoolFilters.length || amenityFilters.length || ranges.size || searchDates
  );
  const list = waiting ? [] : Object.entries(cache)
    .filter(([key, record]) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return false;
      if (preset && !preset.keys.has(key)) return false;
      if (site && recordSite(key) !== site) return false;
      if (searchCities.length && !LRStreetFilter.cityAllowed(searchCities, record.city || "")) return false;
      if (type && recordType(record) !== type) return false;
      if (searchStatuses.length) {
        // סטטוס אחד לכל מודעה: "פעילה" לא כוללת מודעות שסומנו לא רלוונטיות
        const status = recordType(record) === "listing"
          ? LRCacheData.listingStatusKey(recordSite(key), record, listingRelevance(record).irrelevant)
          : "";
        if (!searchStatuses.includes(status)) return false;
      }
      if (!boolFilters.every(([field, value]) => matchesBooleanFilter(record, field, value))) return false;
      if (!searchBoolFilters.every(([field, value]) =>
        matchesBooleanFilter(record, field, value)
      )) return false;
      if (!amenityFilters.every(([field, value]) =>
        matchesBooleanFilter(record, `amenity:${field}`, value)
      )) return false;
      if (!matchesNumericFilters(record, ranges)) return false;
      if (searchMode && !matchesSearchDateFilters(record)) return false;
      if (query && !matchesSearchWords(key, record, queryWords)) return false;
      return columnFilters.every(([field, value]) =>
        columnFilterText(field, record, key, priceRanks)
          .toLocaleLowerCase("he")
          .includes(value)
      );
    })
  // ORDER BY לפי סדר העמודות שנבחרו; ערך כל עמודה מחושב פעם אחת לשורה. ערכים חסרים בסוף בכל רמה.
  const order = recordSortOrder();
  const isMissing = (v) => v === null || v === undefined || v === "" || Number.isNaN(v);
  const sorted = list
    .map((entry) => ({ entry, values: order.map((item) => rowSortValue(entry[0], entry[1], priceRanks, item.key)) }))
    .sort((left, right) => {
      for (let i = 0; i < order.length; i++) {
        const a = left.values[i];
        const b = right.values[i];
        const aMissing = isMissing(a);
        const bMissing = isMissing(b);
        if (aMissing || bMissing) {
          if (aMissing === bMissing) continue;
          return aMissing ? 1 : -1;
        }
        const comparison =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : collator.compare(String(a), String(b));
        if (comparison) return comparison * (order[i].direction < 0 ? -1 : 1);
      }
      return 0;
    })
    .map((row) => row.entry);
  return { list: sorted, waiting, priceRanks };
}

function renderRows() {
  const searchMode = activeTab === "search";
  const filtered = filterRecordsFor(searchMode);
  const { priceRanks } = filtered;
  searchWaiting = filtered.waiting;
  visibleRecords = filtered.list;

  rows.replaceChildren();
  const twins = LRCacheData.findTwins(cache);
  // בונים רק את השורות שרואים: 100 בכל פעם, והשאר נוספות כשגוללים לסוף הטבלה
  rowRenderer = ([key, record]) => {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.key = key;
    row.setAttribute("aria-selected", String(key === selectedKey));
    for (const column of columns) {
      const td = document.createElement("td");
      if (column.key === "type") {
        td.appendChild(textCell(
          recordType(record) === "project" ? "פרויקט" : "מודעה",
          `type-chip${recordType(record) === "project" ? " project" : ""}`
        ));
      } else if (column.key === "site") {
        const siteName = recordSite(key);
        td.textContent = siteName === "yad2" ? "יד2" : siteName === "madlan" ? "מדלן" : siteName;
      } else if (column.key === "cloud") {
        td.className = "cloud-col";
        renderCloudCell(td, key, record);
      } else if (column.key === "listingStatus") {
        td.className = "listing-status-cell";
        const status = document.createElement("span");
        const site = recordSite(key);
        const searchOnly = recordType(record) === "listing" && record.indexedFrom === "search";
        const relevance = listingRelevance(record);
        if (relevance.irrelevant && record.listingStatus !== "removed") {
          status.className = "listing-status irrelevant";
          status.textContent = "לא רלוונטית";
          td.title = irrelevantTitle(relevance);
        } else if (!["yad2", "madlan"].includes(site) || recordType(record) !== "listing") {
          status.className = "listing-status unknown";
          status.textContent = searchOnly ? "מהחיפוש בלבד" : "—";
          if (searchOnly) td.title = SEARCH_ONLY_TITLE;
        } else if (record.listingStatus === "active") {
          status.className = "listing-status active";
          status.textContent = "פעילה";
          td.title = record.listingStatusCheckedAt
            ? `נבדקה ב־${displayDate(record.listingStatusCheckedAt)}`
            : "";
        } else if (record.listingStatus === "removed") {
          status.className = "listing-status removed";
          status.textContent = "הוסרה";
          td.title = record.listingStatusCheckedAt
            ? `נבדקה ב־${displayDate(record.listingStatusCheckedAt)}`
            : "";
        } else {
          status.className = "listing-status unknown";
          status.textContent = searchOnly ? "לא נבדקה · מהחיפוש בלבד" : "לא נבדקה";
          if (searchOnly) td.title = SEARCH_ONLY_TITLE;
        }
        td.appendChild(status);
      } else if (column.key === "title") {
        td.className = "record-name";
        const title = record.title || key;
        const address = [record.address, record.city].filter(Boolean).join(", ") +
          (record.addressApprox ? " (מספר בית משוער)" : "");
        const listingUrl = listingPageUrl(key, record);
        if (listingUrl) {
          for (const [label, className] of [
            [title, "record-title"],
            [address, "record-address"],
          ]) {
            const link = document.createElement("a");
            link.href = listingUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.className = `record-link ${className}`;
            link.dataset.recordLink = "true";
            link.setAttribute("aria-label", `פתיחת המודעה: ${title}`);
            link.textContent = label;
            td.appendChild(link);
          }
        } else {
          td.append(
            textCell(title, "record-title"),
            textCell(address, "record-address")
          );
        }
        // אותה דירה באתר השני
        const twinKey = twins.get(key);
        const twin = twinKey && cache[twinKey];
        const twinUrl = twin && listingPageUrl(twinKey, twin);
        if (twinUrl) {
          const link = document.createElement("a");
          link.href = twinUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "record-link record-twin";
          link.dataset.recordLink = "true";
          const gap = Number.isFinite(twin.price) && Number.isFinite(record.price) ? twin.price - record.price : 0;
          link.textContent = `אותה דירה ${recordSite(twinKey) === "madlan" ? "במדלן" : "ביד2"}` +
            (Number.isFinite(twin.price) && twin.price > 0 ? `: ${displayPrice(twin.price)}` : "") +
            (gap ? ` (${gap > 0 ? "יקר" : "זול"} ב־${displayPrice(Math.abs(gap))})` : "") + " ↗";
          link.title = "זוהתה לפי כתובת או מיקום, חדרים, קומה ושטח. שתי המודעות ממשיכות להתרענן בנפרד.";
          td.appendChild(link);
        }
      } else if (column.key === "notes") {
        td.className = "notes-cell";
        td.textContent = record.notes || "";
        td.title = record.notes || "";
      } else if (column.key === "price") {
        td.className = "price-col";
        td.textContent = displayPrice(record.price);
      } else if (column.key === "priceWithTax") {
        td.className = "price-tax-col";
        const tax = LRCacheData.purchaseTax(record.price, purchaseTaxSettings);
        if (tax) {
          td.textContent = displayPrice(tax.total);
          td.title = `${displayPrice(record.price)} + מס רכישה ${displayPrice(tax.tax)} (${tax.effectivePct}% מהמחיר) · ${purchaseTaxSettings.label || "דירה יחידה"}`;
        }
      } else if (column.key === "pricePerSqm") {
        td.textContent = displayPrice(LRCacheData.pricePerSqm(record));
        td.title = "מחיר למ״ר מחושב מהמחיר והשטח";
      } else if (column.key === "sqm") {
        td.textContent = Number.isFinite(record.sqm) ? String(record.sqm) : "";
      } else if (column.key === "railMeters") {
        td.textContent = Number.isFinite(record.railMeters) ? Math.round(record.railMeters).toLocaleString("he-IL") : "";
        td.title = record.railApprox === true ? "המרחק משוער" : "המרחק בקו אווירי";
      } else if (column.key === "rooms") {
        td.textContent = Number.isFinite(record.rooms) ? String(record.rooms) : "";
      } else if (column.key === "floor") {
        td.textContent = floorText(record);
      } else if (column.key === "shelterMeters") {
        td.textContent = Number.isFinite(record.shelterMeters) ? record.shelterMeters.toLocaleString("he-IL") : "";
      } else if (column.key === "sellerPressure") {
        const pressure = sellerPressure(record);
        td.title = pressureTitle(pressure);
        if (pressure) {
          const chip = document.createElement("span");
          chip.className = `pressure-chip ${pressure.level}`;
          chip.textContent = `${pressure.score} · ${LRCacheData.PRESSURE_LABELS[pressure.level]}`;
          td.appendChild(chip);
        }
      } else if (column.key === "listingAgeDays") {
        // מחושב ונשמר בזמן שמירה/רענון של המודעה – לא מחשבים כאן בכל ציור
        td.textContent = Number.isFinite(record.listingAgeDays) ? record.listingAgeDays.toLocaleString("he-IL") : "";
        if (Number.isFinite(record.listingAgeAt)) {
          td.title = `חושב בעדכון האחרון של המודעה (${displayDate(record.listingAgeAt)})`;
        }
      } else if (column.key === "brokerage") {
        td.appendChild(renderBoolean(record.brokerage));
      } else if (column.key === "dealScore") {
        const real = realDealsFor(record);
        const score = LRCacheData.dealScore(record, priceRanks.get(key) ?? 0.5, real?.diffPct);
        td.textContent = score === null ? "—" : `${score} ★`;
        td.title = `ציון משוקלל לעזרה במיון בלבד, לא המלצת השקעה. רכיב המחיר: ${
          real && Number.isFinite(real.diffPct) ? "מול עסקאות אמת באזור" : "מול המודעות השמורות"
        }`;
      } else if (column.realLevel) {
        const real = realDealsAllFor(record)[column.realLevel];
        td.textContent = realLevelText(real);
        td.title = real ? realDealsTitle(real) : `אין מספיק עסקאות אמת ${LRDeals.LEVEL_LABELS[column.realLevel]} (צריך ${LRDeals.LEVEL_MINIMUMS[column.realLevel]}).`;
        td.className = real && Number.isFinite(real.diffPct)
          ? real.diffPct <= -5 ? "real-deals below" : real.diffPct >= 5 ? "real-deals above" : "real-deals"
          : "real-deals";
      } else if (column.amenity) {
        td.appendChild(renderBoolean(amenityValue(record, column.amenity)));
      } else if (column.key === "updatedAt") {
        td.textContent = displayDate(record.updatedAt);
      } else if (column.key === "priceHistory") {
        const history = validPriceHistory(record);
        td.className = "price-history-cell";
        if (!history.length) {
          td.textContent = "—";
        } else {
          const historyList = document.createElement("div");
          historyList.className = "price-history-list";
          const expanded = showFullPriceHistory || expandedPriceHistory.has(key);
          if (expanded) historyList.classList.add("expanded");
          const visibleCount = expanded ? history.length : Math.min(3, history.length);
          for (let index = history.length - 1; index >= history.length - visibleCount; index--) {
            const point = history[index];
            const item = document.createElement("div");
            item.className = "price-history-item";
            const date = document.createElement("span");
            date.className = "price-history-date";
            date.textContent = priceHistoryDate(point, index, history);
            const price = document.createElement("strong");
            price.textContent = displayPrice(point.price);
            item.append(date, price);
            historyList.appendChild(item);
          }
          td.appendChild(historyList);
          if (history.length > 3) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "history-toggle";
            toggle.dataset.historyToggle = key;
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.textContent = expanded
              ? "הצג פחות"
              : `הצג עוד ${(history.length - 3).toLocaleString("he-IL")}`;
            td.appendChild(toggle);
          }
        }
      } else if (column.key === "actions") {
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.dataset.action = "edit";
        edit.textContent = "עריכה";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.action = "delete";
        remove.className = "danger";
        remove.textContent = "מחיקה";
        if (recordType(record) === "listing" && (record.address || record.neighborhood)) {
          const deals = document.createElement("button");
          deals.type = "button";
          deals.dataset.action = "deals";
          deals.className = "deals-action";
          deals.textContent = "עסקאות";
          deals.title = "חיפוש עסקאות אמת בכתובת הזו";
          actions.append(deals);
        }
        if (recordType(record) === "listing") {
          const copy = document.createElement("button");
          copy.type = "button";
          copy.dataset.action = "copy";
          copy.className = "copy-action";
          copy.textContent = "📋 העתקה";
          copy.title = "מעתיק את טקסט המודעה (מחיר, שטח, קומה, מרחק מהרכבת, מול עסקאות אמת וקישור) – כמו הכפתור באתר";
          actions.append(copy);
        }
        actions.append(edit, remove);
        td.appendChild(actions);
      }
      row.appendChild(td);
    }
    rows.appendChild(row);
  };
  renderedRowCount = 0;
  appendRowPage();
  const resultCount = searchWaiting
    ? `${Object.keys(cache).length.toLocaleString("he-IL")} רשומות במאגר · בחרו מסנן או הקלידו כדי לחפש`
    : `${visibleRecords.length.toLocaleString("he-IL")} מתוך ${Object.keys(cache).length.toLocaleString("he-IL")} רשומות`;
  const savedListingCount = listingCountFor(cache);
  $("listingsCount").textContent = savedListingCount.toLocaleString("he-IL");
  $("listingsCount").title = `${savedListingCount.toLocaleString("he-IL")} מודעות שמורות`;
  $("listingsTab").setAttribute(
    "aria-label",
    `מודעות ופרויקטים, ${savedListingCount.toLocaleString("he-IL")} מודעות שמורות`
  );
  $("recordCount").textContent = resultCount;
  $("searchResultCount").textContent = resultCount;
  $("emptyState").hidden = visibleRecords.length > 0;
  $("emptyState").textContent = searchWaiting
    ? "התחילו להקליד מילת חיפוש או לבחור מסנן – התוצאות יופיעו כאן."
    : "לא נמצאו רשומות מתאימות.";
  $("sortSelect").value = sort.key;
  renderHeaderSortState();
  // ציר הזמן נבנה רק כשהוא מוצג; אחרת רק מסמנים שצריך לבנות אותו מחדש
  if (activeTab === "priceChanges") renderPriceTimeline();
  else timelineDirty = true;
}

// ---------- ביצועים: טעינה בחלקים, זיכרון ביניים ועיכוב הקלדה ----------
const ROW_PAGE_SIZE = 100;
let rowRenderer = null;
let renderedRowCount = 0;
let searchWaiting = false;
let timelineDirty = true;
const haystackCache = new WeakMap();
let priceRanksMemo = { cache: null, size: -1, ranks: new Map() };
let listingCountMemo = { cache: null, size: -1, count: 0 };

// טקסט לחיפוש: בלי סימני פיסוק, גרשיים ומקפים, וכתיב מלא/חסר אחיד ("תקווה" = "תקוה", "יישוב" = "ישוב").
// כך "פתח תקווה הדר גנים" מוצא את "הרב ישעיהו משורר, הדר גנים, פתח תקווה" – כל מילה בנפרד, בכל סדר.
function searchText(value) {
  return String(value || "")
    .toLocaleLowerCase("he")
    .replace(/[‎‏‪-‮]/g, "")
    .replace(/["'`״׳]/g, "")
    .replace(/[,.;:()\[\]{}\\/|_\-–־]+/g, " ")
    .replace(/וו/g, "ו")
    .replace(/יי/g, "י")
    .replace(/\s+/g, " ")
    .trim();
}

function searchWords(query) {
  return searchText(query).split(" ").filter(Boolean);
}

function recordHaystack(key, record) {
  let text = haystackCache.get(record);
  if (text === undefined) {
    text = ` ${searchText(`${key} ${JSON.stringify(record)}`)} `;
    haystackCache.set(record, text);
  }
  return text;
}

// רשימת הערים להשלמה בשדה "עיר" בחיפוש מודעה – הערים שיש בהן מודעות שמורות, מהנפוצה לפחות נפוצה
let listingCitiesMemo = { cache: null, size: -1 };
function fillListingCities() {
  const size = Object.keys(cache).length;
  if (listingCitiesMemo.cache === cache && listingCitiesMemo.size === size) return;
  listingCitiesMemo = { cache, size };
  const counts = new Map();
  for (const record of Object.values(cache)) {
    const city = record && typeof record === "object" && String(record.city || "").trim();
    if (city) counts.set(city, (counts.get(city) || 0) + 1);
  }
  // בחירה מרובה של ערים (תיבות סימון, הנפוצות קודם); מה שכבר סומן נשאר מסומן
  const checked = new Set(multiSelectValues("listingSearchCity"));
  const options = [...counts].sort((a, b) => b[1] - a[1]).map(([city, count]) => {
    const label = el("label", "", "");
    const input = el("input");
    input.type = "checkbox";
    input.value = city;
    input.dataset.label = city;
    input.checked = checked.has(city);
    label.append(input, ` ${city} `, el("span", "multi-count", `(${count.toLocaleString("he-IL")})`));
    return label;
  });
  $("listingSearchCities").replaceChildren(...options);
  updateMultiSelectSummary($("listingSearchCity"));
}

function matchesSearchWords(key, record, words) {
  if (!words.length) return true;
  const haystack = recordHaystack(key, record);
  return words.every((word) => haystack.includes(word));
}

// מודעות שנשמרו לפני שהגיל נשמר ברשומה: משלימים פעם אחת לכל טעינת מטמון (בזיכרון בלבד);
// ברענון/שמירה הבאים של המודעה הגיל נשמר בה עצמה.
let agesFilledFor = { cache: null, size: -1 };
function ensureListingAges(currentCache) {
  const size = Object.keys(currentCache).length;
  if (agesFilledFor.cache === currentCache && agesFilledFor.size === size) return;
  agesFilledFor = { cache: currentCache, size };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const record of Object.values(currentCache)) {
    if (!record || typeof record !== "object" || Number.isFinite(record.listingAgeDays)) continue;
    const created = record.listingCreatedAt ? Date.parse(record.listingCreatedAt) : NaN;
    if (!Number.isFinite(created)) continue;
    Object.defineProperty(record, "listingAgeDays", {
      value: Math.max(0, Math.floor((today.getTime() - created) / 86400000)),
      enumerable: false, // לא נכתב חזרה לאחסון ולא נכנס לחיפוש הטקסט
      configurable: true,
      writable: true,
    });
  }
}

function priceRanksFor(currentCache) {
  const size = Object.keys(currentCache).length;
  if (priceRanksMemo.cache !== currentCache || priceRanksMemo.size !== size) {
    priceRanksMemo = { cache: currentCache, size, ranks: allPriceRanks(Object.entries(currentCache)) };
  }
  return priceRanksMemo.ranks;
}

function listingCountFor(currentCache) {
  const size = Object.keys(currentCache).length;
  if (listingCountMemo.cache !== currentCache || listingCountMemo.size !== size) {
    const count = Object.values(currentCache).filter(
      (record) => record && typeof record === "object" && recordType(record) === "listing"
    ).length;
    listingCountMemo = { cache: currentCache, size, count };
  }
  return listingCountMemo.count;
}

function moreRowsBar() {
  let bar = $("moreRows");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "moreRows";
    bar.className = "more-rows";
    const label = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", appendRowPage);
    bar.append(label, button);
    rows.closest(".table-wrap").appendChild(bar);
    // כשהפס מגיע לתצוגה (גלילה לסוף הטבלה) טוענים את 100 הבאות
    new IntersectionObserver((observed) => {
      if (observed.some((entry) => entry.isIntersecting)) appendRowPage();
    }, { root: rows.closest(".table-wrap"), rootMargin: "300px" }).observe(bar);
  }
  return bar;
}

function appendRowPage() {
  if (!rowRenderer) return;
  const end = Math.min(visibleRecords.length, renderedRowCount + ROW_PAGE_SIZE);
  for (; renderedRowCount < end; renderedRowCount++) rowRenderer(visibleRecords[renderedRowCount]);
  const bar = moreRowsBar();
  const remaining = visibleRecords.length - renderedRowCount;
  bar.hidden = remaining <= 0;
  bar.firstChild.textContent = `מוצגות ${renderedRowCount.toLocaleString("he-IL")} מתוך ${visibleRecords.length.toLocaleString("he-IL")}`;
  bar.lastChild.textContent = `הצג עוד ${Math.min(ROW_PAGE_SIZE, remaining).toLocaleString("he-IL")}`;
}

function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
const scheduleRenderRows = debounce(() => renderRows());
const scheduleDeletionPreview = debounce(() => renderListingDeletionPreview());
const scheduleTimeline = debounce(() => renderPriceTimeline());

let timelineMemo = { cache: null, size: -1, events: [], changes: 0 };
function timelineEventsFor(currentCache) {
  const size = Object.keys(currentCache).length;
  if (timelineMemo.cache !== currentCache || timelineMemo.size !== size) {
    const events = LRCacheExport.getPriceTimelineEvents(currentCache);
    timelineMemo = {
      cache: currentCache,
      size,
      events,
      changes: events.filter((event) => event.kind === "increase" || event.kind === "decrease").length,
    };
  }
  return timelineMemo;
}

const TIMELINE_PAGE_SIZE = 150;
let timelineLimit = TIMELINE_PAGE_SIZE;

// תאריך השינוי כפי שאפשר לדעת אותו באמת – לא להציג את תאריך האינדוקס כאילו הוא תאריך הירידה
function timelineDateText(change) {
  if (!Number.isFinite(change.at)) return { text: "תאריך לא ידוע" };
  const at = displayHistoryDate(change.at);
  const detected = Number.isFinite(change.detectedAt) ? displayHistoryDate(change.detectedAt) : at;
  const from = Number.isFinite(change.notBefore) ? displayHistoryDate(change.notBefore) : "";
  switch (change.dateKind) {
    case "site":
      return { text: at, badge: "תאריך מהאתר", title: "תאריך השינוי כפי שהאתר מפרסם אותו." };
    case "updated":
      return {
        text: at,
        badge: "משוער",
        title: `לפי תאריך העדכון של המודעה (המודעה עשויה להתעדכן גם מסיבות אחרות). התוסף זיהה את השינוי ב־${detected}.`,
      };
    case "beforeFirstSeen":
      return {
        text: `עד ${detected}`,
        badge: "תאריך לא ידוע",
        title: `המחיר הקודם ידוע (למשל מ„ירד ב־” בכרטיס), אבל לא מתי השתנה – רק שזה קרה לפני ${detected}, כשהתוסף ראה את המודעה לראשונה.`,
      };
    case "detected":
      return from && from !== detected
        ? {
            text: `בין ${from} ל־${detected}`,
            badge: "זוהה ברענון",
            title: `המחיר עוד היה הקודם ב־${from} והשתנה עד ${detected}, כשהתוסף ראה את המודעה שוב.`,
          }
        : { text: detected, badge: "זוהה ברענון", title: "התוסף ראה את השינוי ביום הזה." };
    default:
      return { text: at };
  }
}

// מה בדיוק הכפתור "רק מודעות שמתאימות להגדרות שלי" בודק – אותם תנאים כמו ב-passesTimelineFilters
function timelinePreferencesSummaryText() {
  const rules = [];
  for (const amenity of timelinePreferences.requiredAmenities) {
    rules.push(`יש ${timelineAmenityLabels[amenity] || amenity}`);
  }
  if (timelinePreferences.removeBrokerage) rules.push("בלי תיווך");
  if (timelinePreferences.calculateRail && timelinePreferences.requireRail) {
    rules.push(`עד ${PRICE_FORMAT.format(timelinePreferences.nearM)} מ׳ מהרכבת (מרחק מדויק)`);
  }
  if (timelinePreferences.calculatePpsm && timelinePreferences.maxPpsm > 0) {
    rules.push(`עד ${displayPrice(timelinePreferences.maxPpsm)} למ״ר`);
  }
  if (!rules.length) return "„רק מודעות שמתאימות להגדרות שלי”: בהגדרות לא נבחרו תנאים, אז הכפתור לא מסנן כלום.";
  return `${timelinePreferencesEnabled ? "מוצגות רק מודעות" : "„רק מודעות שמתאימות להגדרות שלי” יציג רק מודעות"} שעונות על ההגדרות שלך: ${rules.join(" · ")}. משנים את התנאים בהגדרות התוסף.`;
}

// קורא את ערכי המסננים פעם אחת לכל רינדור (ולא פעם לכל אירוע – זה מה שהיה כבד)
function readTimelineFilters() {
  const ranges = [];
  for (const field of ["price", "railMeters", "pricePerSqm", "rooms"]) {
    const minimum = document.querySelector(`[data-timeline-min="${field}"]`);
    const maximum = document.querySelector(`[data-timeline-max="${field}"]`);
    const min = minimum && minimum.value !== "" ? Number(minimum.value) : null;
    const max = maximum && maximum.value !== "" ? Number(maximum.value) : null;
    if (min !== null || max !== null) ranges.push({ field, min, max });
  }
  const amenities = [...document.querySelectorAll("[data-timeline-amenity]")]
    .filter((input) => input.value)
    .map((input) => [input.dataset.timelineAmenity, input.value]);
  return { ranges, brokerage: $("timelineBrokerage").value, amenities };
}

function renderPriceTimeline() {
  timelineDirty = false;
  const timeline = $("priceTimeline");
  timeline.replaceChildren();
  const memo = timelineEventsFor(cache);
  const allEvents = memo.events;
  const changes = { length: memo.changes };
  const kindFilteredEvents = priceTimelineFilter === "all"
    ? allEvents
    : allEvents.filter((event) => event.kind === priceTimelineFilter);
  const filters = readTimelineFilters();
  const events = kindFilteredEvents.filter((event) => passesTimelineFilters(event, filters));
  $("priceChangesCount").textContent = changes.length.toLocaleString("he-IL");
  $("timelineCount").textContent = `${events.length.toLocaleString("he-IL")} מתוך ${kindFilteredEvents.length.toLocaleString("he-IL")} אירועים`;
  $("emptyTimeline").hidden = events.length > 0;
  $("timelinePreferences").setAttribute("aria-pressed", String(timelinePreferencesEnabled));
  const summary = $("timelinePreferencesSummary");
  summary.textContent = timelinePreferencesSummaryText();
  summary.dataset.active = String(timelinePreferencesEnabled);

  for (const change of events.slice(0, timelineLimit)) {
    const item = document.createElement("li");
    item.className = `timeline-item ${change.kind}`;
    const card = document.createElement("article");
    card.className = "timeline-card";
    const metadata = document.createElement("div");
    metadata.className = "timeline-meta";
    const date = Number.isFinite(change.at) ? document.createElement("time") : document.createElement("span");
    if (Number.isFinite(change.at)) date.dateTime = new Date(change.at).toISOString();
    const dateInfo = timelineDateText(change);
    date.textContent = dateInfo.text;
    if (dateInfo.title) date.title = dateInfo.title;
    const site = document.createElement("span");
    site.className = "timeline-site";
    site.textContent = change.site === "yad2" ? "יד2" : change.site === "madlan" ? "מדלן" : change.site;
    metadata.append(date, site);
    if (dateInfo.badge) {
      const badge = document.createElement("span");
      badge.className = `timeline-date-kind ${change.dateKind || ""}`;
      badge.textContent = dateInfo.badge;
      if (dateInfo.title) badge.title = dateInfo.title;
      metadata.appendChild(badge);
    }

    const title = document.createElement("h3");
    if (/^https?:\/\//i.test(change.url)) {
      const link = document.createElement("a");
      link.href = change.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = change.title;
      title.appendChild(link);
    } else {
      title.textContent = change.title;
    }

    const summary = document.createElement("p");
    summary.className = "timeline-change";
    const detail = document.createElement("p");
    detail.className = "timeline-prices";
    if (change.kind === "decrease" || change.kind === "increase") {
      summary.textContent = `מחיר המודעה ${change.kind === "decrease" ? "ירד" : "עלה"} ב־${displayPrice(Math.abs(change.change))}`;
      detail.textContent = `מ־${displayPrice(change.fromPrice)} ל־${displayPrice(change.toPrice)}`;
    } else if (change.kind === "uncertain") {
      summary.textContent = "תצפית ראשונית — השינוי הקודם לא ודאי";
      detail.textContent = `${displayPrice(change.fromPrice)} ← ${displayPrice(change.toPrice)}`;
    }
    const address = document.createElement("p");
    address.className = "timeline-address";
    address.textContent = [change.address, change.city].filter(Boolean).join(", ");
    const facts = [];
    if (Number.isFinite(change.currentPrice)) {
      facts.push(`מחיר עדכני: ${displayPrice(change.currentPrice)}`);
    }
    if (Number.isFinite(change.rooms)) facts.push(`${change.rooms} חדרים`);
    if (Number.isFinite(change.sqm)) facts.push(`${change.sqm} מ״ר`);
    if (Number.isFinite(change.pricePerSqm)) {
      facts.push(`${displayPrice(change.pricePerSqm)} למ״ר`);
    }
    if (Number.isFinite(change.railMeters)) {
      const estimate = change.railApprox ? " (משוער)" : "";
      const station = change.railStation ? ` · תחנה: ${change.railStation}` : "";
      facts.push(`מרחק מהרכבת: ${Math.round(change.railMeters)} מ׳${estimate}${station}`);
    }
    if (typeof change.brokerage === "boolean") {
      facts.push(`תיווך: ${change.brokerage ? "כן" : "לא"}`);
    }
    for (const amenity of ["secureRoom", "storage"]) {
      const value = change.amenities && change.amenities[amenity];
      facts.push(
        `${timelineAmenityLabels[amenity]}: ${
          typeof value === "boolean" ? (value ? "כן" : "לא") : "לא ידוע"
        }`
      );
    }
    for (const [amenity, label] of Object.entries(timelineAmenityLabels)) {
      if (amenity === "secureRoom" || amenity === "storage") continue;
      const value = change.amenities && change.amenities[amenity];
      if (typeof value === "boolean") facts.push(`${label}: ${value ? "כן" : "לא"}`);
    }
    const factsElement = document.createElement("p");
    factsElement.className = "timeline-facts";
    factsElement.textContent = facts.join(" · ");
    card.append(metadata, title, summary, detail, factsElement);
    if (address.textContent) card.appendChild(address);
    // מעבר לחיפוש מודעה עם המודעה הזו בלבד – כל מה שנאסף עליה. הקישור בכותרת נשאר קישור לאתר.
    if (change.listingId) {
      const openSaved = () => openSearchWith({ query: change.listingId, site: change.site || "" });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timeline-open";
      button.textContent = "למידע השמור ←";
      button.title = "פתיחת המודעה בחיפוש מודעה, עם כל המידע שנשמר עליה";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openSaved();
      });
      card.appendChild(button);
      card.classList.add("clickable");
      card.title = "לחיצה על הכרטיס פותחת את המידע השמור על המודעה; הכותרת פותחת את המודעה באתר";
      card.addEventListener("click", (event) => {
        // לחיצה על הקישור בכותרת (או על כל קישור אחר) ממשיכה לאתר כרגיל
        if (event.target.closest("a")) return;
        if (window.getSelection && String(window.getSelection())) return; // סימון טקסט, לא לחיצה
        openSaved();
      });
    }
    item.appendChild(card);
    timeline.appendChild(item);
  }
  if (events.length > timelineLimit) {
    const more = document.createElement("li");
    more.className = "more-rows timeline-more";
    const label = document.createElement("span");
    label.textContent = `מוצגים ${timelineLimit.toLocaleString("he-IL")} מתוך ${events.length.toLocaleString("he-IL")} אירועים`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `הצג עוד ${Math.min(TIMELINE_PAGE_SIZE, events.length - timelineLimit).toLocaleString("he-IL")}`;
    button.addEventListener("click", () => {
      timelineLimit += TIMELINE_PAGE_SIZE;
      renderPriceTimeline();
    });
    more.append(label, button);
    timeline.appendChild(more);
  }

  for (const button of document.querySelectorAll("[data-price-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.priceFilter === priceTimelineFilter));
  }
}

function loadTimelinePreferences() {
  const defaults = {
    requiredAmenities: ["secureRoom"],
    removeBrokerage: false,
    calculateRail: true,
    requireRail: true,
    nearM: 800,
    calculatePpsm: true,
    maxPpsm: 0,
    irrelevantMissingPct: 50,
    dealBreakerAmenities: [],
  };
  chrome.storage.sync.get(defaults, (settings) => {
    const error = chrome.runtime.lastError;
    if (error) {
      console.error("[lightrail-ext] failed to load timeline preferences", error.message);
      $("timelinePreferences").title = "לא ניתן לטעון את ההעדפות מההגדרות.";
      return;
    }
    readTimelinePreferences(settings || defaults);
    renderPriceTimeline();
    renderRows();
  });
}

// ההגדרות הן אותו טופס של החלון הקופץ (popup.html) במצב עמוד; טוענים אותו פעם אחת ומחליפים קטגוריה לפי hash
function showSettingsSection(section) {
  const frame = $("settingsFrame");
  if (!frame.getAttribute("src")) {
    frame.src = `popup.html?page=1#${section}`;
    return;
  }
  try {
    frame.contentWindow.location.hash = section;
  } catch (_error) {
    frame.src = `popup.html?page=1#${section}`;
  }
}

const VIEW_NAMES = ["dashboard", "listings", "search", "delete", "priceChanges", "deals", "refresh", "transfer", "addressExport", "sync"];

// ---------- לוח בקרה ----------
// מדד לחץ למכור (LRCacheData.sellerPressure) – נשמר בזיכרון לכל רשומה כדי שמיון וציור לא יחשבו שוב ושוב
const pressureCache = new WeakMap();
function sellerPressure(record) {
  if (!record || typeof record !== "object") return null;
  if (!pressureCache.has(record)) pressureCache.set(record, LRCacheData.sellerPressure(record));
  return pressureCache.get(record);
}

function sortByPressure() {
  sort.key = "sellerPressure";
  sort.direction = -1;
  recordSorts = [];
  renderRows();
}

function pressureTitle(pressure) {
  if (!pressure) return "אין מספיק מידע: חסרים גיל מודעה והיסטוריית מחירים";
  const parts = [
    Number.isFinite(pressure.ageDays) ? `${pressure.ageDays} ימים באוויר` : "גיל לא ידוע",
    pressure.drops ? `${pressure.drops} הורדות מחיר` : "בלי הורדות מחיר",
  ];
  if (pressure.dropPct) parts.push(`ירידה של ${Math.round(pressure.dropPct * 100)}% מהשיא`);
  return `מדד לחץ למכור ${pressure.score}/100 (${LRCacheData.PRESSURE_LABELS[pressure.level]}): ${parts.join(" · ")}`;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// פותח את חיפוש המודעה עם מסנן מוכן (לחיצה על מספר בלוח הבקרה)
// קבוצת מודעות מדויקת מלוח הבקרה ("עד 300 מ׳ מהרכבת" → בדיוק המודעות שנספרו שם)
let searchPreset = null;

function openSearchWithKeys(label, keys) {
  openSearchWith({ preset: { label, keys: new Set(keys) } });
}

function renderSearchPresetChip() {
  const chip = $("searchPresetChip");
  if (!chip) return;
  chip.hidden = !searchPreset;
  if (searchPreset) {
    chip.querySelector("span").textContent = `מלוח הבקרה: ${searchPreset.label} (${searchPreset.keys.size.toLocaleString("he-IL")})`;
  }
}

function openSearchWith({ status = "", query = "", site = "", preset = null } = {}) {
  searchPreset = preset;
  document.querySelectorAll("[data-search-range-min], [data-search-range-max], [data-search-date-min], [data-search-date-max], [data-search-boolean], [data-search-amenity]")
    .forEach((input) => { input.value = ""; });
  $("listingSearchQuery").value = query;
  $("listingSearchSite").value = site;
  setMultiSelectValues("listingSearchCity", []);
  $("listingSearchType").value = "listing";
  setMultiSelectValues("listingSearchStatus", status);
  setActiveTab("search");
}

async function renderDashboard() {
  ensureListingAges(cache);
  let log = {};
  try {
    const stored = await storageGet(REFRESH_LOG_KEY);
    log = stored && typeof stored === "object" ? stored : {};
  } catch (_error) {
    // בלי יומן רענון הספירה תסתמך על תאריך בדיקת הסטטוס בלבד
  }
  const today = startOfToday();
  const weekAgo = today - 6 * 86400000;
  const stats = {
    listings: 0, projects: 0, yad2: 0, madlan: 0,
    relevant: 0, irrelevant: 0, amenitiesUnknown: 0,
    active: 0, removed: 0, unchecked: 0, searchOnly: 0,
    refreshedToday: 0, refreshedWeek: 0, neverRefreshed: 0,
    drops: 0, rises: 0, brokerage: 0, nearRail: 0,
    pressure: { high: 0, medium: 0, low: 0 },
    pressureScores: [],
    prices: [], ppsm: [], ages: [],
    // חדש: מתי נשמרו, התפלגויות, מאפיינים וירידות מחיר לפי תאריך
    newToday: 0, newWeek: 0, newMonth: 0,
    rooms: new Map(), rail: new Map(),
    amenities: new Map(AMENITIES.map(([amenity]) => [amenity, { yes: 0, known: 0 }])),
    dropsWeek: 0, dropsMonth: 0, dropPcts: [], dropsUnknownDate: 0,
    // המפתחות שמאחורי כל מספר – לחיצה עליו פותחת בדיוק אותן מודעות
    keys: {
      rooms: new Map(), rail: new Map(), amenities: new Map(),
      nearRail: [], brokerage: [], noBrokerage: [], newToday: [], newWeek: [], newMonth: [],
      pressureHigh: [], pressureMedium: [], drops: [], rises: [], dropsWeek: new Set(), dropsMonth: new Set(),
      unknownDropDate: new Set(), amenitiesUnknown: [], relevant: [], searchOnly: [], neverRefreshed: [], refreshedToday: [],
    },
  };
  const push = (map, bucket, key) => {
    if (!map.has(bucket)) map.set(bucket, []);
    map.get(bucket).push(key);
  };
  const monthAgo = today - 29 * 86400000;
  const cities = new Map();
  for (const [key, record] of Object.entries(cache)) {
    if (!record || typeof record !== "object") continue;
    if (recordType(record) === "project") { stats.projects++; continue; }
    stats.listings++;
    const site = recordSite(key);
    if (site === "yad2") stats.yad2++;
    if (site === "madlan") stats.madlan++;
    const hasAmenities = record.amenities && Object.values(record.amenities).some((v) => typeof v === "boolean");
    const irrelevant = listingRelevance(record).irrelevant;
    if (irrelevant) stats.irrelevant++;
    else if (!hasAmenities) { stats.amenitiesUnknown++; stats.keys.amenitiesUnknown.push(key); }
    else { stats.relevant++; stats.keys.relevant.push(key); }
    // אותו סטטוס כמו בחיפוש: "פעילה" לא כוללת לא רלוונטיות, כך שהמספר תואם למה שנפתח בלחיצה
    const status = LRCacheData.listingStatusKey(site, record, irrelevant);
    if (status === "active") stats.active++;
    else if (status === "removed") stats.removed++;
    else if (status === "unchecked") stats.unchecked++;
    if (record.indexedFrom === "search") { stats.searchOnly++; stats.keys.searchOnly.push(key); }
    const firstSeen = firstSeenAt(record);
    if (firstSeen >= today) { stats.newToday++; stats.keys.newToday.push(key); }
    if (firstSeen >= weekAgo) { stats.newWeek++; stats.keys.newWeek.push(key); }
    if (firstSeen >= monthAgo) { stats.newMonth++; stats.keys.newMonth.push(key); }
    const roomsBucket = roomsBucketOf(record.rooms);
    stats.rooms.set(roomsBucket, (stats.rooms.get(roomsBucket) || 0) + 1);
    push(stats.keys.rooms, roomsBucket, key);
    const railBucket = railBucketOf(record);
    stats.rail.set(railBucket, (stats.rail.get(railBucket) || 0) + 1);
    push(stats.keys.rail, railBucket, key);
    for (const [amenity, counts] of stats.amenities) {
      const value = record.amenities && record.amenities[amenity];
      if (typeof value !== "boolean") continue;
      counts.known++;
      if (value) { counts.yes++; push(stats.keys.amenities, amenity, key); }
    }
    const refreshed = Math.max(lastRefreshedAt(key, record), Number(log[key]) || 0);
    if (!refreshed) { stats.neverRefreshed++; stats.keys.neverRefreshed.push(key); }
    else if (refreshed >= today) { stats.refreshedToday++; stats.keys.refreshedToday.push(key); }
    if (refreshed >= weekAgo) stats.refreshedWeek++;
    const history = validPriceHistory(record);
    if (history.length >= 2) {
      const diff = history[history.length - 1].price - history[0].price;
      if (diff < 0) { stats.drops++; stats.keys.drops.push(key); }
      if (diff > 0) { stats.rises++; stats.keys.rises.push(key); }
    }
    if (record.brokerage === true) { stats.brokerage++; stats.keys.brokerage.push(key); }
    if (record.brokerage === false) stats.keys.noBrokerage.push(key);
    if (Number.isFinite(record.railMeters) && record.railApprox !== true && record.railMeters <= timelinePreferences.nearM) {
      stats.nearRail++;
      stats.keys.nearRail.push(key);
    }
    const pressure = sellerPressure(record);
    if (pressure) {
      stats.pressure[pressure.level]++;
      stats.pressureScores.push(pressure.score);
      if (pressure.level === "high") stats.keys.pressureHigh.push(key);
      if (pressure.level === "medium") stats.keys.pressureMedium.push(key);
    }
    const ppsm = LRCacheData.pricePerSqm(record);
    if (Number.isFinite(record.price)) stats.prices.push(record.price);
    if (Number.isFinite(ppsm)) stats.ppsm.push(ppsm);
    if (Number.isFinite(record.listingAgeDays)) stats.ages.push(record.listingAgeDays);
    if (record.city) {
      const city = cities.get(record.city) || { count: 0, irrelevant: 0, ppsm: [], drops: 0 };
      city.count++;
      if (irrelevant) city.irrelevant++;
      if (Number.isFinite(ppsm)) city.ppsm.push(ppsm);
      if (history.length >= 2 && history[history.length - 1].price < history[0].price) city.drops++;
      cities.set(record.city, city);
    }
  }
  // ירידות מחיר לפי תאריך השינוי (אותם אירועים כמו במסך שינויי המחירים)
  for (const event of timelineEventsFor(cache).events) {
    if (event.kind !== "decrease") continue;
    if (event.fromPrice > 0) stats.dropPcts.push((-event.change / event.fromPrice) * 100);
    if (event.dateKind === "beforeFirstSeen") { stats.dropsUnknownDate++; stats.keys.unknownDropDate.add(event.key); continue; }
    if (event.at >= weekAgo) { stats.dropsWeek++; stats.keys.dropsWeek.add(event.key); }
    if (event.at >= monthAgo) { stats.dropsMonth++; stats.keys.dropsMonth.add(event.key); }
  }
  stats.dealAreas = LRDeals.dealsByArea(dealsStore, { years: 3 });
  drawDashboard(stats, cities);
}

// פותח את חיפוש העסקאות מסונן לעיר (ולשכונה) – לחיצה על שורה בלוח הבקרה
// שכונה: נבחרת בשדה השכונה; אם אין עסקאות עם השכונה הזו בשדה – נשארת חיפוש טקסט חופשי
function openDealsWith({ city = "", query = "", neighborhood = "" } = {}) {
  $("dealsSource").value = "";
  document.querySelectorAll("[data-deals-min], [data-deals-max]").forEach((input) => { input.value = ""; });
  const years = LRDeals.dealsByArea({}, { years: 3 }).years;
  document.querySelector('[data-deals-min="year"]').value = String(years[0]);
  setActiveTab("deals");
  fillDealsCities();
  $("dealsCity").value = city;
  const picked = setDealsHood(neighborhood);
  $("dealsQuery").value = picked || !neighborhood ? query : `${query} ${neighborhood}`.trim();
  renderDeals();
}

// "עסקאות" ליד מודעה: חיפוש עסקאות ברחוב ובמספר הבית שלה (בלי מספר בית – כל הרחוב; בלי כתובת – השכונה),
// בעיר שלה גם אם הכתיב שונה ("פתח תקוה" / "פתח תקווה")
function openDealsForRecord(record) {
  if (!record) return;
  const first = String(record.address || "").split(",")[0].trim();
  const cityOfRecord = String(record.city || "").trim();
  const hasStreet = first && LRDeals.normCity(first) !== LRDeals.normCity(cityOfRecord);
  const query = hasStreet ? first : "";
  const neighborhood = hasStreet ? "" : String(record.neighborhood || "").trim();
  fillDealsCities();
  const wanted = LRDeals.normCity(cityOfRecord);
  const option = wanted ? [...$("dealsCity").options].find((item) => item.value && LRDeals.normCity(item.value) === wanted) : null;
  openDealsWith({
    city: option ? option.value : "",
    query: option || !cityOfRecord ? query : `${query} ${cityOfRecord}`.trim(),
    neighborhood,
  });
}

// טקסט המודעה ללוח (אותו טקסט כמו כפתור ההעתקה באתר / עמודת הטקסט ב-Excel)
function listingCopyText(key, record) {
  const { site, listingId } = LRCacheExport.parseCacheKey(key);
  const url = LRCacheExport.recordUrl(site, listingId, record);
  const ppsm = LRCacheData.pricePerSqm(record);
  return LRCacheExport.whatsappMessage({ ...record, pricePerSqm: ppsm }, url, dealsIndex);
}

async function copyListingText(key, button) {
  const record = cache[key];
  if (!record) return;
  const original = button.textContent;
  try {
    const text = listingCopyText(key, record);
    if (!text) throw new Error("אין טקסט למודעה הזו.");
    await navigator.clipboard.writeText(text);
    button.textContent = "✓ הועתק";
  } catch (error) {
    console.warn("[lightrail-ext] copy failed", error);
    button.textContent = "ההעתקה נכשלה";
  }
  setTimeout(() => { button.textContent = original; }, 1500);
}

// הפעם הראשונה שהתוסף ראה מחיר למודעה (לא נקודות מהאתר, שיכולות להיות ישנות בהרבה)
function firstSeenAt(record) {
  let first = 0;
  for (const point of Array.isArray(record.priceHistory) ? record.priceHistory : []) {
    if (!point || point.src === "site" || !Number.isFinite(point.at)) continue;
    if (!first || point.at < first) first = point.at;
  }
  return first;
}

const ROOMS_BUCKETS = ["1–2", "2.5–3", "3.5–4", "4.5–5", "5.5+", "לא ידוע"];
function roomsBucketOf(rooms) {
  if (!Number.isFinite(rooms) || rooms <= 0) return "לא ידוע";
  if (rooms <= 2) return "1–2";
  if (rooms <= 3) return "2.5–3";
  if (rooms <= 4) return "3.5–4";
  if (rooms <= 5) return "4.5–5";
  return "5.5+";
}

const RAIL_BUCKETS = ["עד 300 מ׳", "300–600 מ׳", "600–1,000 מ׳", "1–2 ק״מ", "מעל 2 ק״מ", "משוער או לא ידוע"];
function railBucketOf(record) {
  const meters = record.railMeters;
  if (!Number.isFinite(meters) || record.railApprox === true) return "משוער או לא ידוע";
  if (meters <= 300) return "עד 300 מ׳";
  if (meters <= 600) return "300–600 מ׳";
  if (meters <= 1000) return "600–1,000 מ׳";
  if (meters <= 2000) return "1–2 ק״מ";
  return "מעל 2 ק״מ";
}

function drawDashboard(stats, cities) {
  const root = $("dashboard");
  root.replaceChildren();
  const number = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString("he-IL") : "—");
  const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const tile = (label, value, note, onClick, tone, icon) => {
    const card = el(onClick ? "button" : "div", "stat-tile");
    if (onClick) {
      card.type = "button";
      card.title = "לחיצה מציגה את המודעות";
      card.addEventListener("click", onClick);
    }
    if (tone) card.dataset.tone = tone;
    const head = el("span", "stat-label");
    if (icon) head.append(el("span", "stat-icon", icon));
    head.append(label);
    card.append(head, el("strong", "stat-value", value));
    if (note) card.append(el("span", "stat-note", note));
    return card;
  };
  // פותח בחיפוש מודעה בדיוק את המודעות שנספרו (רק אם יש כאלה)
  const show = (label, keys) => {
    const list = [...keys];
    return list.length ? () => openSearchWithKeys(label, list) : null;
  };
  const section = (title, icon, tone) => {
    const box = el("section", "dash-card");
    if (tone) box.dataset.tone = tone;
    const heading = el("h3", "dash-heading");
    if (icon) heading.append(el("span", "dash-icon", icon));
    heading.append(title);
    box.append(heading);
    root.appendChild(box);
    return box;
  };

  // שורת מספרים ראשית
  const heroes = el("div", "stat-row");
  heroes.append(
    tile("מודעות שמורות", number(stats.listings), `יד2 ${number(stats.yad2)} · מדלן ${number(stats.madlan)} · ${number(stats.projects)} פרויקטים`, () => openSearchWith({}), "teal", "🏠"),
    tile("לא רלוונטיות", number(stats.irrelevant), `${pct(stats.irrelevant, stats.listings)} מהמודעות · לא נכללות ברענון`, () => openSearchWith({ status: "irrelevant" }), "amber", "🚫"),
    // רלוונטיות = יש בהן את מאפייני החובה (מודעות שהמאפיינים שלהן עוד לא ידועים לא נספרות)
    tile(
      "מודעות רלוונטיות",
      number(stats.relevant),
      `${pct(stats.relevant, stats.listings)} מהמודעות · ${number(stats.amenitiesUnknown)} עם מאפיינים לא ידועים`,
      show("מודעות רלוונטיות", stats.keys.relevant),
      "blue",
      "✅"
    ),
    tile("ירדו במחיר", number(stats.drops), `${number(stats.rises)} עלו במחיר`, show("ירדו במחיר", stats.keys.drops), "green", "📉"),
    tile(
      "לחץ גבוה למכור",
      number(stats.pressure.high),
      `מדד 60+ מתוך 100 · חציון המדד: ${number(medianOf(stats.pressureScores))}`,
      stats.keys.pressureHigh.length ? () => { openSearchWithKeys("לחץ גבוה למכור", stats.keys.pressureHigh); sortByPressure(); } : null,
      "red",
      "🔥"
    ),
  );
  root.appendChild(heroes);

  // התאמה לדרישות: פס מחולק עם תוויות גלויות (הצבעים נבדקו לעיוורון צבעים)
  const fit = section("התאמה למאפייני החובה שלך", "🎯", "green");
  const known = stats.relevant + stats.irrelevant;
  const bar = el("div", "split-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${stats.relevant} רלוונטיות, ${stats.irrelevant} לא רלוונטיות`);
  for (const [kind, count, label] of [["relevant", stats.relevant, "רלוונטיות"], ["irrelevant", stats.irrelevant, "לא רלוונטיות"]]) {
    if (!count) continue;
    const part = el("span", `split-part ${kind}`);
    part.style.flexGrow = String(count);
    part.title = `${label}: ${count.toLocaleString("he-IL")} (${pct(count, known)})`;
    bar.appendChild(part);
  }
  const legend = el("div", "split-legend");
  const legendOpen = {
    relevant: show("רלוונטיות", stats.keys.relevant),
    irrelevant: stats.irrelevant ? () => openSearchWith({ status: "irrelevant" }) : null,
  };
  for (const [kind, count, label] of [["relevant", stats.relevant, "רלוונטיות"], ["irrelevant", stats.irrelevant, "לא רלוונטיות"]]) {
    const item = el(legendOpen[kind] ? "button" : "span", "legend-item");
    if (legendOpen[kind]) { item.type = "button"; item.addEventListener("click", legendOpen[kind]); }
    item.append(el("i", `legend-swatch ${kind}`), el("span", "", `${label} ${number(count)} (${pct(count, known)})`));
    legend.appendChild(item);
  }
  const unknownOpen = show("מאפיינים לא ידועים", stats.keys.amenitiesUnknown);
  const unknownItem = el(unknownOpen ? "button" : "span", "legend-item muted", `מאפיינים לא ידועים עדיין: ${number(stats.amenitiesUnknown)}`);
  if (unknownOpen) { unknownItem.type = "button"; unknownItem.addEventListener("click", unknownOpen); }
  legend.appendChild(unknownItem);
  fit.append(known ? bar : el("p", "stat-note", "עוד אין מודעות עם מאפיינים ידועים."), legend);

  // סטטוס ורענון
  const status = el("div", "stat-row compact");
  status.append(
    tile("פעילות", number(stats.active), "נבדקו ברענון (יד2 ומדלן)", () => openSearchWith({ status: "active" }), "green", "✅"),
    tile("הוסרו", number(stats.removed), "כבר לא באתר", () => openSearchWith({ status: "removed" }), "slate", "🗑️"),
    tile("לא נבדקו", number(stats.unchecked), `${number(stats.searchOnly)} מהן מהחיפוש בלבד`, () => openSearchWith({ status: "unchecked" }), "amber", "❔"),
    tile("רועננו היום", number(stats.refreshedToday), `${number(stats.refreshedWeek)} בשבוע האחרון · ${number(stats.neverRefreshed)} אף פעם`, show("רועננו היום", stats.keys.refreshedToday), "blue", "🔄"),
  );
  section("סטטוס ורענון", "📋", "blue").appendChild(status);

  // מחירים
  const prices = el("div", "stat-row compact");
  prices.append(
    tile("מחיר חציוני", `₪${number(medianOf(stats.prices))}`, "", null, "teal", "💰"),
    tile("מחיר למ״ר חציוני", `₪${number(medianOf(stats.ppsm))}`, "", null, "teal", "📐"),
    tile("גיל מודעה חציוני", `${number(medianOf(stats.ages))} ימים`, `לחץ למכור – בינוני: ${number(stats.pressure.medium)} · נמוך: ${number(stats.pressure.low)}`, show("לחץ בינוני למכור", stats.keys.pressureMedium), "amber", "⏳"),
    tile("קרובות לרכבת", number(stats.nearRail), `עד ${number(timelinePreferences.nearM)} מ׳ · תיווך: ${number(stats.brokerage)}`, show(`עד ${number(timelinePreferences.nearM)} מ׳ מהרכבת`, stats.keys.nearRail), "green", "🚊"),
    tile("עם תיווך", number(stats.brokerage), `ללא תיווך: ${number(stats.keys.noBrokerage.length)}`, show("עם תיווך", stats.keys.brokerage), "red", "🤝"),
  );
  section("מחירים ומיקום", "📍", "teal").appendChild(prices);

  // פעילות לאחרונה: מה נוסף ומה ירד במחיר בשבוע ובחודש האחרונים
  const recent = el("div", "stat-row compact");
  recent.append(
    tile("נשמרו היום", number(stats.newToday), `${number(stats.newWeek)} ב־7 ימים · ${number(stats.newMonth)} ב־30 יום`, show("נשמרו היום", stats.keys.newToday), "blue", "🆕"),
    tile("נשמרו ב־7 ימים", number(stats.newWeek), `${number(stats.newMonth)} ב־30 יום`, show("נשמרו ב־7 ימים", stats.keys.newWeek), "blue", "🗓️"),
    tile("ירידות מחיר ב־7 ימים", number(stats.dropsWeek), `${number(stats.dropsMonth)} ב־30 יום`, show("ירדו במחיר ב־7 ימים", stats.keys.dropsWeek), "green", "⬇️"),
    tile(
      "ירידה חציונית",
      stats.dropPcts.length ? `${(Math.round(medianOf(stats.dropPcts) * 10) / 10).toLocaleString("he-IL")}%` : "—",
      `מתוך ${number(stats.dropPcts.length)} ירידות מחיר`,
      () => setActiveTab("priceChanges"),
      "green",
      "📊"
    ),
    tile("ירידות בלי תאריך ידוע", number(stats.dropsUnknownDate), "קרו לפני שהמודעה נשמרה (למשל „ירד ב־” בכרטיס)", show("ירידות בלי תאריך ידוע", stats.keys.unknownDropDate), "slate", "❓"),
  );
  section("פעילות לאחרונה", "⚡", "amber").appendChild(recent);

  // התפלגויות: פס אחד בגוון אחד לכל שורה, המספר והאחוז כתובים ליד הפס
  const barTable = (headers, items) => {
    const max = Math.max(0, ...items.map((item) => item.value));
    const table = el("table", "city-table dist-table");
    const headRow = el("tr");
    for (const label of headers) headRow.appendChild(el("th", "", label));
    table.appendChild(el("thead")).appendChild(headRow);
    const tbody = el("tbody");
    for (const item of items) {
      const row = el("tr");
      if (item.title) row.title = item.title;
      if (item.open) {
        row.classList.add("clickable");
        row.tabIndex = 0;
        row.addEventListener("click", item.open);
        row.addEventListener("keydown", (event) => { if (event.key === "Enter") item.open(); });
      }
      const cell = el("td", "city-count");
      const track = el("span", "city-bar");
      const fill = el("span", "city-bar-fill");
      fill.style.width = `${max && item.value ? Math.max(3, (item.value / max) * 100) : 0}%`;
      track.appendChild(fill);
      cell.append(track, el("span", "city-bar-value", item.text));
      row.append(el("td", "city-name", item.label), cell);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    return table;
  };
  const distGrid = el("div", "dash-grid");
  const countItems = (buckets, map, keyMap, prefix) => buckets.map((label) => {
    const count = map.get(label) || 0;
    return {
      label,
      value: count,
      text: `${number(count)} (${pct(count, stats.listings)})`,
      title: `${label}: ${number(count)} מודעות${count ? " · לחיצה מציגה אותן" : ""}`,
      open: show(`${prefix} ${label}`, keyMap.get(label) || []),
    };
  });
  const cardHeading = (box, title, icon, tone) => {
    box.dataset.tone = tone;
    const heading = el("h3", "dash-heading");
    heading.append(el("span", "dash-icon", icon), title);
    box.appendChild(heading);
  };
  const roomsBox = el("section", "dash-card");
  cardHeading(roomsBox, "לפי מספר חדרים", "🛏️", "blue");
  roomsBox.append(barTable(["חדרים", "מודעות"], countItems(ROOMS_BUCKETS, stats.rooms, stats.keys.rooms, "חדרים:")));
  const railBox = el("section", "dash-card");
  cardHeading(railBox, "מרחק מהרכבת הקלה", "🚊", "green");
  railBox.append(barTable(["מרחק", "מודעות"], countItems(RAIL_BUCKETS, stats.rail, stats.keys.rail, "מהרכבת:")));
  const amenityBox = el("section", "dash-card");
  cardHeading(amenityBox, "מאפיינים", "✨", "amber");
  const amenityItems = AMENITIES
    .filter(([amenity]) => stats.amenities.get(amenity).known > 0)
    .map(([amenity, label]) => {
      const counts = stats.amenities.get(amenity);
      const share = (counts.yes / counts.known) * 100;
      return {
        label,
        value: share,
        text: `${Math.round(share)}%`,
        title: `${label}: יש ב־${number(counts.yes)} מתוך ${number(counts.known)} מודעות שידוע עליהן · לחיצה מציגה אותן`,
        open: show(`יש ${label}`, stats.keys.amenities.get(amenity) || []),
      };
    });
  amenityBox.append(
    amenityItems.length
      ? barTable(["מאפיין", "יש (מתוך הידועות)"], amenityItems)
      : el("p", "stat-note", "עוד אין מודעות עם מאפיינים ידועים.")
  );
  distGrid.append(roomsBox, railBox, amenityBox);
  root.appendChild(distGrid);

  // ערים: פסים אופקיים בגוון אחד, המספר כתוב ליד כל פס
  const cityBox = section("ערים מובילות", "🏙️", "blue");
  const top = [...cities].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  const max = top.length ? top[0][1].count : 0;
  const table = el("table", "city-table");
  const head = el("tr");
  for (const label of ["עיר", "מודעות", "מחיר למ״ר חציוני", "ירדו במחיר", "לא רלוונטיות"]) head.appendChild(el("th", "", label));
  table.appendChild(el("thead")).appendChild(head);
  const body = el("tbody");
  for (const [city, data] of top) {
    const row = el("tr");
    row.title = `פתיחת המודעות ב${city}`;
    row.addEventListener("click", () => openSearchWith({ query: city }));
    const name = el("td", "city-name", city);
    const countCell = el("td", "city-count");
    const track = el("span", "city-bar");
    const fill = el("span", "city-bar-fill");
    fill.style.width = `${max ? Math.max(4, (data.count / max) * 100) : 0}%`;
    track.appendChild(fill);
    countCell.append(track, el("span", "city-bar-value", number(data.count)));
    row.append(name, countCell, el("td", "", `₪${number(medianOf(data.ppsm))}`), el("td", "", number(data.drops)), el("td", "", number(data.irrelevant)));
    body.appendChild(row);
  }
  table.appendChild(body);
  cityBox.appendChild(top.length ? table : el("p", "stat-note", "עוד אין מודעות עם עיר."));

  // עסקאות אמת לפי עיר ושכונה בשנים האחרונות
  const areas = stats.dealAreas;
  const yearsLabel = `${areas.years[0]}–${areas.years[areas.years.length - 1]}`;
  const dealsTable = (headers, items, nameOf, onClick) => {
    const max = items.length ? items[0].count : 0;
    const table = el("table", "city-table");
    const headRow = el("tr");
    for (const label of headers) headRow.appendChild(el("th", "", label));
    table.appendChild(el("thead")).appendChild(headRow);
    const body = el("tbody");
    for (const item of items) {
      const row = el("tr");
      row.title = "פתיחת העסקאות בחיפוש עסקאות";
      row.addEventListener("click", () => onClick(item));
      const countCell = el("td", "city-count");
      const track = el("span", "city-bar");
      const fill = el("span", "city-bar-fill");
      fill.style.width = `${max ? Math.max(4, (item.count / max) * 100) : 0}%`;
      track.appendChild(fill);
      countCell.append(track, el("span", "city-bar-value", number(item.count)));
      row.append(el("td", "city-name", nameOf(item)), countCell);
      for (const year of areas.years) row.appendChild(el("td", "", number(item.byYear[year])));
      row.appendChild(el("td", "", item.medianPpsm ? `₪${number(item.medianPpsm)}` : "—"));
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  };
  const yearHeaders = areas.years.map(String);
  const dealCities = section(`עסקאות אמת לפי עיר (${yearsLabel})`, "🧾", "green");
  if (!areas.cities.length) {
    dealCities.appendChild(el("p", "stat-note", "עוד אין עסקאות אמת מהשנים האחרונות. הן נאספות כשפותחים מודעות ביד2 ובמדלן."));
  } else {
    dealCities.append(
      dealsTable(["עיר", "עסקאות", ...yearHeaders, "₪ למ״ר חציוני"], areas.cities.slice(0, 10), (item) => item.city,
        (item) => openDealsWith({ city: item.city })),
      el("p", "stat-note", "לפי העסקאות שנאספו מהמודעות שפתחת – לא כל העסקאות בעיר. עיר שפתחת בה יותר מודעות תיראה עם יותר עסקאות.")
    );
    if (areas.neighborhoods.length) {
      const dealHoods = section(`שכונות עם הכי הרבה עסקאות (${yearsLabel})`, "🏘️", "teal");
      dealHoods.appendChild(
        dealsTable(["שכונה", "עסקאות", ...yearHeaders, "₪ למ״ר חציוני"], areas.neighborhoods.slice(0, 10),
          (item) => `${item.neighborhood} · ${item.city}`,
          (item) => openDealsWith({ city: item.city, neighborhood: item.neighborhood }))
      );
    }
  }
  $("dashboardUpdated").textContent = `עודכן ${new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`;
}
function viewFromHash() {
  const name = decodeURIComponent(location.hash.slice(1));
  if (VIEW_NAMES.includes(name)) return name;
  if (name.startsWith("settings-") && document.querySelector(`[data-settings="${name.slice(9)}"]`)) return name;
  return "";
}

function setActiveTab(tab) {
  activeTab = tab;
  const tableWrap = rows.closest(".table-wrap");
  if (tab === "search") $("searchResultsHost").appendChild(tableWrap);
  else $("listingsMain").appendChild(tableWrap);
  for (const [id, name] of [
    ["listingsTab", "listings"],
    ["listingSearchTab", "search"],
    ["listingDeleteTab", "delete"],
    ["priceChangesTab", "priceChanges"],
    ["dealsTab", "deals"],
    ["refreshTab", "refresh"],
    ["transferTab", "transfer"],
    ["addressExportTab", "addressExport"],
    ["syncTab", "sync"],
    ["dashboardTab", "dashboard"],
  ]) {
    const active = tab === name;
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-selected", String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  $("listingsPanel").hidden = tab !== "listings";
  $("listingSearchPanel").hidden = tab !== "search";
  $("listingDeletePanel").hidden = tab !== "delete";
  $("priceChangesPanel").hidden = tab !== "priceChanges";
  $("dealsPanel").hidden = tab !== "deals";
  $("refreshPanel").hidden = tab !== "refresh";
  $("transferPanel").hidden = tab !== "transfer";
  $("addressExportPanel").hidden = tab !== "addressExport";
  $("syncPanel").hidden = tab !== "sync";
  $("dashboardPanel").hidden = tab !== "dashboard";
  const settingsSection = tab.startsWith("settings-") ? tab.slice("settings-".length) : "";
  for (const button of document.querySelectorAll("[data-settings]")) {
    const active = button.dataset.settings === settingsSection;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $("settingsPanel").hidden = !settingsSection;
  if (settingsSection) showSettingsSection(settingsSection);
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  $("listingToolbar").hidden = tab === "search" || tab === "delete" || tab === "priceChanges" || tab === "deals";
  $("listingAdvancedFilters").hidden = tab === "search" || tab === "delete" || tab === "priceChanges" || tab === "deals";
  if (tab === "deals") renderDeals();
  document.body.dataset.activeTab = tab;
  if (tab === "search" || tab === "listings") renderRows();
  if (tab === "delete") renderListingDeletionPreview();
  if (tab === "priceChanges" && timelineDirty) renderPriceTimeline();
  if (tab === "dashboard") renderDashboard();
  if (tab === "sync") renderSyncPanel();
  syncNavMenus();
}

// תפריט עליון: לחיצה על קטגוריה עוברת ישר לעמוד האחרון שפתחת בה (או לראשון), והעמודים של
// הקטגוריה הפעילה מוצגים בשורה קבועה מתחת לכותרת – כך עוברים ביניהם בלי לפתוח שוב תפריט.
function syncNavMenus() {
  let activeMenu = null;
  for (const menu of document.querySelectorAll(".nav-menu")) {
    const activeTab = menu.querySelector(".view-tab.active");
    menu.classList.toggle("has-active", Boolean(activeTab));
    if (activeTab) {
      menu.dataset.last = activeTab.id;
      activeMenu = menu;
    }
  }
  const subNav = $("subNav");
  if (!subNav) return;
  subNav.replaceChildren();
  subNav.hidden = !activeMenu;
  if (!activeMenu) return;
  for (const tab of activeMenu.querySelectorAll(".view-tab")) {
    const label = tab.querySelector(".nav-label");
    const button = el("button", "sub-tab", label ? label.textContent : tab.title);
    button.type = "button";
    button.title = tab.title || "";
    button.dataset.tone = tab.dataset.tone || "";
    const active = tab.classList.contains("active");
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    const count = tab.querySelector(".tab-count");
    if (count && !count.hidden && count.textContent.trim()) button.append(el("span", "tab-count", count.textContent));
    button.addEventListener("click", () => tab.click());
    subNav.append(button);
  }
}
document.querySelectorAll(".nav-menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    const menu = trigger.closest(".nav-menu");
    const target = (menu.dataset.last && $(menu.dataset.last)) || menu.querySelector(".view-tab");
    if (target) target.click();
  });
});

function handleTabKeydown(event) {
  // סדר הלשוניות כפי שהן מופיעות בתפריט הצד
  const tabs = [...document.querySelectorAll('.view-tabs [role="tab"]')];
  const currentIndex = tabs.indexOf(event.currentTarget);
  let nextIndex;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

function renderHeaderSortState() {
  const order = recordSortOrder();
  for (const button of document.querySelectorAll(".sort-button[data-sort]")) {
    const index = order.findIndex((item) => item.key === button.dataset.sort);
    button.setAttribute(
      "aria-sort",
      index < 0 ? "none" : order[index].direction > 0 ? "ascending" : "descending"
    );
    // מספר העמודה בסדר המיון – רק כשממיינים לפי יותר מעמודה אחת
    if (index >= 0 && order.length > 1) button.dataset.rank = String(index + 1);
    else delete button.dataset.rank;
  }
}

function setFormValue(field, value) {
  const input = getFormField(field);
  if (!input) return;
  if (input.type === "date") input.value = dateInputValue(value);
  else input.value = value === undefined || value === null ? "" : String(value);
}

function renderAmenityFields(record) {
  const container = $("amenityFields");
  container.replaceChildren();
  const amenityValues = record.amenities && typeof record.amenities === "object"
    ? record.amenities
    : {};
  const keys = new Set([...AMENITIES.map(([key]) => key), ...Object.keys(amenityValues)]);
  for (const key of keys) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = AMENITY_LABELS[key] || key;
    const select = document.createElement("select");
    select.dataset.amenity = key;
    for (const [value, caption] of [["", "לא ידוע"], ["true", "כן"], ["false", "לא"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = caption;
      select.appendChild(option);
    }
    select.value = typeof amenityValues[key] === "boolean" ? String(amenityValues[key]) : "";
    label.append(text, select);
    container.appendChild(label);
  }
}

function renderPriceHistory(record) {
  const container = $("priceHistory");
  container.replaceChildren();
  const history = validPriceHistory(record);
  if (!history.length) {
    container.textContent = "אין עדיין היסטוריית מחירים. המחיר הנוכחי יישמר כנקודת בסיס בביקור הבא בעמוד.";
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  for (const label of ["תאריך", "מחיר"]) {
    const th = document.createElement("th");
    th.textContent = label;
    heading.appendChild(th);
  }
  head.appendChild(heading);
  const body = document.createElement("tbody");
  for (let index = history.length - 1; index >= 0; index--) {
    const point = history[index];
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = priceHistoryDate(point, index, history);
    const price = document.createElement("td");
    price.textContent = displayPrice(point.price);
    row.append(date, price);
    body.appendChild(row);
  }
  table.append(head, body);
  container.appendChild(table);
}

function openRecord(key) {
  const record = cache[key];
  if (!record) return;
  selectedKey = key;
  dirtyFields.clear();
  $("saveButton").disabled = true;
  $("saveStatus").textContent = "";
  $("saveStatus").dataset.error = "false";
  $("detailsPanel").hidden = false;
  $("detailsBackdrop").hidden = false;
  $("detailsTitle").textContent = record.title || key;
  const url = record.url || record.listingUrl || "";
  const link = $("openListingLink");
  if (/^https?:\/\//i.test(url)) {
    link.href = url;
    link.hidden = false;
  } else {
    link.removeAttribute("href");
    link.hidden = true;
  }

  const values = {
    title: record.title,
    notes: record.notes,
    address: record.address,
    city: record.city,
    neighborhood: record.neighborhood,
    url,
    price: record.price,
    maxPrice: record.maxPrice,
    sqm: record.sqm,
    maxSqm: record.maxSqm,
    pricePerSqm: LRCacheData.pricePerSqm(record),
    rooms: record.rooms,
    listingCreatedAt: record.listingCreatedAt,
    listingUpdatedAt: record.listingUpdatedAt,
    railMeters: record.railMeters,
    railStation: record.railStation,
    latitude: record.coordinates && record.coordinates.lat,
    longitude: record.coordinates && record.coordinates.lon,
    railApprox: record.railApprox,
    brokerage: record.brokerage,
  };
  for (const [field, value] of Object.entries(values)) setFormValue(field, value);
  renderAmenityFields(record);
  renderPriceHistory(record);
  $("rawRecord").textContent = JSON.stringify(record, null, 2);
  renderRows();
}

function closeDetails() {
  $("detailsPanel").hidden = true;
  $("detailsBackdrop").hidden = true;
  selectedKey = null;
  renderRows();
}

function parseFieldValue(field, input) {
  if (field === "railApprox" || field === "brokerage") {
    return input.value === "" ? null : input.value === "true";
  }
  if (input.type === "number" || input.dataset.thousands !== undefined) {
    if (input.value === "") return null;
    const value = Number(input.value);
    if (!Number.isFinite(value)) throw new Error("יש להזין מספר תקין.");
    if (value < 0 && !["latitude", "longitude"].includes(field)) {
      throw new Error("אין להזין ערך שלילי בשדה הזה.");
    }
    if (field === "latitude" && Math.abs(value) > 90) throw new Error("קו רוחב חייב להיות בין ‎-90 ל־90.");
    if (field === "longitude" && Math.abs(value) > 180) throw new Error("קו אורך חייב להיות בין ‎-180 ל־180.");
    return value;
  }
  if (input.type === "date") return input.value || null;
  const value = input.value.trim();
  if (field === "url" && value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("הקישור אינו תקין.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("יש להזין קישור http או https.");
    }
  }
  return value;
}

async function saveRecord(event) {
  event.preventDefault();
  if (!selectedKey || dirtyFields.size === 0 || writing) return;
  const button = $("saveButton");
  const status = $("saveStatus");
  button.disabled = true;
  writing = true;
  status.textContent = "שומר…";
  status.dataset.error = "false";

  try {
    const latest = await storageGet();
    const previous = latest[selectedKey];
    if (!previous || typeof previous !== "object") {
      throw new Error("הרשומה נמחקה מהמטמון. רענן את העמוד.");
    }
    const updated = { ...previous };
    const overrides = new Set(Array.isArray(previous.manualOverrides) ? previous.manualOverrides : []);
    let coordinates = previous.coordinates && typeof previous.coordinates === "object"
      ? { ...previous.coordinates }
      : {};

    for (const field of dirtyFields) {
      if (field === "amenities") {
        const amenities = { ...(previous.amenities || {}) };
        for (const select of $("amenityFields").querySelectorAll("select[data-amenity]")) {
          amenities[select.dataset.amenity] =
            select.value === "" ? null : select.value === "true";
        }
        updated.amenities = amenities;
        overrides.add("amenities");
      } else if (field === "latitude" || field === "longitude") {
        const value = parseFieldValue(field, getFormField(field));
        const coordinate = field === "latitude" ? "lat" : "lon";
        if (value === null) delete coordinates[coordinate];
        else coordinates[coordinate] = value;
        updated.coordinates = coordinates;
        overrides.add("coordinates");
      } else {
        const value = parseFieldValue(field, getFormField(field));
        updated[field] = value;
        overrides.add(field);
      }
    }
    if (
      Number.isFinite(coordinates.lat) &&
      Number.isFinite(coordinates.lon) &&
      (Math.abs(coordinates.lat) > 90 || Math.abs(coordinates.lon) > 180)
    ) {
      throw new Error("הקואורדינטות מחוץ לטווח התקין.");
    }
    updated.manualOverrides = [...overrides];
    updated.updatedAt = Date.now();
    latest[selectedKey] = updated;
    await storageSet({ [CACHE_KEY]: latest });
    cache = latest;
    openRecord(selectedKey);
    renderListingDeletionPreview();
    status.textContent = "השינויים נשמרו";
  } catch (error) {
    console.error("[lightrail-ext] failed to edit cached record", error);
    status.textContent = error.message || "שמירת השינויים נכשלה.";
    status.dataset.error = "true";
    button.disabled = false;
  } finally {
    writing = false;
  }
}

async function deleteRecord(key) {
  const record = cache[key];
  if (!record || !window.confirm(`למחוק לצמיתות את הרשומה "${record.title || key}"?`)) return;
  try {
    const latest = await storageGet();
    if (!Object.prototype.hasOwnProperty.call(latest, key)) {
      throw new Error("הרשומה כבר אינה קיימת במטמון.");
    }
    delete latest[key];
    await storageSet({ [CACHE_KEY]: latest });
    notifySyncDeleted([key]);
    cache = latest;
    if (selectedKey === key) closeDetails();
    else renderRows();
    renderListingDeletionPreview();
  } catch (error) {
    console.error("[lightrail-ext] failed to delete cached record", error);
    $("saveStatus").textContent = error.message || "מחיקת הרשומה נכשלה.";
    $("saveStatus").dataset.error = "true";
  }
}

async function deleteMatchingListings() {
  const status = $("deletePreviewStatus");
  if (writing || deleteInProgress) return;
  if (dirtyFields.size) {
    status.dataset.error = "true";
    status.textContent = "יש לשמור או לבטל שינויים פתוחים בפרטי מודעה לפני מחיקה.";
    return;
  }
  if (refreshQueue.length || refreshStarting || refreshTabId !== null) {
    status.dataset.error = "true";
    status.textContent = "יש לעצור או להמתין לסיום הרענון לפני מחיקת מודעות.";
    return;
  }
  const { filters, error } = readListingDeletionFilters();
  if (error || !LRCacheData.hasListingDeletionFilters(filters)) {
    renderListingDeletionPreview();
    return;
  }

  writing = true;
  deleteInProgress = true;
  $("deleteMatchingListings").disabled = true;
  status.dataset.error = "false";
  status.textContent = "בודק מחדש את המודעות השמורות…";
  let outcome = "";
  let outcomeError = false;
  try {
    const latest = await storageGet();
    const matches = LRCacheData.filterListingsForDeletion(latest, filters);
    if (!matches.length) {
      cache = latest;
      outcome = "לא נמצאו מודעות שמתאימות למסננים במידע העדכני.";
      renderRows();
      return;
    }
    const count = matches.length.toLocaleString("he-IL");
    const confirmed = window.confirm(
      `למחוק לצמיתות ${count} מודעות שמורות?\n\n` +
      "המחיקה אינה ניתנת לביטול. פרויקטים אינם מושפעים."
    );
    if (!confirmed) {
      outcome = "המחיקה בוטלה. שום מודעה לא נמחקה.";
      return;
    }

    const confirmedKeys = new Set(matches.map(([key]) => key));
    const latestAfterConfirmation = await storageGet();
    const latestMatches = LRCacheData.filterListingsForDeletion(latestAfterConfirmation, filters);
    const latestKeys = new Set(latestMatches.map(([key]) => key));
    if (
      confirmedKeys.size !== latestKeys.size ||
      [...confirmedKeys].some((key) => !latestKeys.has(key))
    ) {
      cache = latestAfterConfirmation;
      renderRows();
      outcome = "המידע השתנה בזמן האישור, לכן לא נמחקו מודעות. בדוק שוב את ההתאמות ואשר מחדש.";
      outcomeError = true;
      return;
    }

    for (const key of confirmedKeys) delete latestAfterConfirmation[key];
    await storageSet({ [CACHE_KEY]: latestAfterConfirmation });
    notifySyncDeleted(confirmedKeys);
    cache = latestAfterConfirmation;
    const removedKeys = confirmedKeys;
    if (selectedKey && removedKeys.has(selectedKey)) closeDetails();
    else renderRows();
    outcome = `המחיקה הושלמה. נמחקו ${count} מודעות.`;
  } catch (error) {
    console.error("[lightrail-ext] failed to bulk-delete cached listings", error);
    outcome = `מחיקת המודעות נכשלה: ${error.message || "שגיאה לא ידועה"}`;
    outcomeError = true;
  } finally {
    writing = false;
    deleteInProgress = false;
    renderListingDeletionPreview();
    if (outcome) {
      status.textContent = outcome;
      status.dataset.error = String(outcomeError);
    }
  }
}

async function clearPriceHistories() {
  const status = $("exportStatus");
  const button = $("clearPriceHistory");
  if (writing || dirtyFields.size) {
    status.textContent = "יש לשמור או לבטל שינויים פתוחים לפני ניקוי היסטוריית המחירים.";
    status.dataset.error = "true";
    return;
  }
  if (!Object.values(cache).some(
    (record) => Array.isArray(record && record.priceHistory) && record.priceHistory.length
  )) {
    status.textContent = "לא נמצאו היסטוריות מחירים לניקוי.";
    status.dataset.error = "false";
    return;
  }
  if (!window.confirm(
    "לנקות את היסטוריית המחירים מכל המודעות והפרויקטים? המחיר האחרון וכל יתר פרטי המטמון יישארו ללא שינוי."
  )) {
    return;
  }

  button.disabled = true;
  status.dataset.error = "false";
  status.textContent = "מנקה היסטוריות מחירים…";
  writing = true;
  try {
    const latest = await storageGet();
    const result = LRCacheData.clearPriceHistories(latest);
    if (!result.clearedCount) {
      cache = latest;
      status.textContent = "לא נותרו היסטוריות מחירים לניקוי.";
      renderRows();
      return;
    }
    await storageSet({ [CACHE_KEY]: result.cache });
    cache = result.cache;
    status.textContent = `היסטוריית המחירים אופסה ב־${result.clearedCount.toLocaleString("he-IL")} רשומות. המחיר האחרון ושאר הנתונים נשמרו.`;
    if (selectedKey && cache[selectedKey]) openRecord(selectedKey);
    else renderRows();
    renderListingDeletionPreview();
  } catch (error) {
    console.error("[lightrail-ext] failed to clear cached price histories", error);
    status.textContent = error.message || "ניקוי היסטוריית המחירים נכשל.";
    status.dataset.error = "true";
  } finally {
    writing = false;
    button.disabled = false;
  }
}

function setRefreshStatus(text, error = false) {
  const status = $("refreshStatus");
  status.textContent = text;
  status.dataset.error = String(error);
}

function reportRefreshRun(type, result) {
  chrome.runtime.sendMessage(
    {
      type,
      ...(result && typeof result === "object" ? result : { result }),
    },
    (response) => {
      const error = chrome.runtime.lastError;
      if (error) console.error("[lightrail-ext] failed to report refresh run state", error.message);
      else if (response && response.ok === false) {
        console.error("[lightrail-ext] failed to report refresh run state", response.error);
      }
    }
  );
}

async function loadRefreshSchedule() {
  try {
    const [schedule, runtime] = await Promise.all([
      storageGet(REFRESH_SCHEDULE_KEY),
      storageGet(REFRESH_RUNTIME_KEY),
    ]);
    const alarm = await new Promise((resolve, reject) => {
      chrome.alarms.get(REFRESH_ALARM_NAME, (value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(value);
      });
    });
    $("refreshScheduleEnabled").checked = Boolean(schedule && schedule.enabled);
    $("refreshScheduleHours").value = String(
      Math.max(1, Math.min(168, Math.round(Number(schedule && schedule.everyHours) || 5)))
    );
    if (schedule && Number.isFinite(schedule.delaySeconds)) {
      refreshDelaySec = Math.max(
        MIN_REFRESH_DELAY_SEC,
        Math.min(MAX_REFRESH_DELAY_SEC, Math.round(schedule.delaySeconds))
      );
      $("refreshDelay").value = String(refreshDelaySec);
    }
    $("refreshScope").value = schedule && schedule.uncheckedOnly ? "unchecked" : "filtered";
    if (schedule && schedule.enabled) $("refreshSite").value = normalizeRefreshSite(schedule.site);
    const nextRun = alarm && Number.isFinite(alarm.scheduledTime)
      ? new Date(alarm.scheduledTime).toLocaleString("he-IL")
      : "";
    if (runtime && runtime.running === true) {
      $("scheduleStatus").textContent = `מחזור רענון פעיל עכשיו · ${nextRun ? `הבא: ${nextRun}` : `כל ${$("refreshScheduleHours").value} שעות`}`;
    } else if (runtime && Number.isFinite(runtime.lastFinishedAt)) {
      const date = new Date(runtime.lastFinishedAt).toLocaleString("he-IL");
      $("scheduleStatus").textContent = `${schedule && schedule.enabled ? "התזמון פעיל" : "התזמון כבוי"}${nextRun ? ` · הבא: ${nextRun}` : ""} · רענון אחרון: ${date} · ${runtime.lastResult || "הסתיים"}`;
    } else {
      $("scheduleStatus").textContent = schedule && schedule.enabled
        ? `התזמון פעיל · כל ${$("refreshScheduleHours").value} שעות${nextRun ? ` · הבא: ${nextRun}` : ""}`
        : "רענון אוטומטי כבוי.";
    }
  } catch (error) {
    console.error("[lightrail-ext] failed to load refresh schedule", error);
    $("scheduleStatus").textContent = error.message || "טעינת התזמון נכשלה.";
    $("scheduleStatus").dataset.error = "true";
  }
}

// "אילו מודעות לרענן?" – אפשר לצמצם לאתר אחד (all / yad2 / madlan)
const REFRESH_SITE_NAMES = { all: "", yad2: "יד2", madlan: "מדלן" };
function normalizeRefreshSite(value) {
  return value === "yad2" || value === "madlan" ? value : "all";
}

async function saveRefreshSchedule() {
  const enabled = $("refreshScheduleEnabled").checked;
  const hours = Math.max(1, Math.min(168, Math.round(Number($("refreshScheduleHours").value) || 5)));
  const delaySeconds = Math.max(
    MIN_REFRESH_DELAY_SEC,
    Math.min(MAX_REFRESH_DELAY_SEC, Math.round(Number($("refreshDelay").value) || 30))
  );
  $("refreshScheduleHours").value = String(hours);
  $("refreshDelay").value = String(delaySeconds);
  const button = $("saveRefreshSchedule");
  button.disabled = true;
  $("scheduleStatus").dataset.error = "false";
  $("scheduleStatus").textContent = "שומר תזמון…";
  try {
    const schedule = {
      enabled,
      everyHours: hours,
      delaySeconds,
      uncheckedOnly: $("refreshScope").value === "unchecked",
      site: normalizeRefreshSite($("refreshSite").value),
      updatedAt: Date.now(),
    };
    await storageSet({
      [REFRESH_SCHEDULE_KEY]: schedule,
      [REFRESH_DELAY_KEY]: delaySeconds,
    });
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "lightrail:refresh-schedule-updated" },
        (result) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (!result || !result.ok) reject(new Error(result && result.error || "עדכון התזמון נכשל."));
          else resolve(result);
        }
      );
    });
    await loadRefreshSchedule();
    if (enabled) {
      const siteName = REFRESH_SITE_NAMES[normalizeRefreshSite($("refreshSite").value)];
      $("scheduleStatus").textContent += ` · ${$("refreshScope").value === "unchecked" ? "מודעות לא נבדקו בלבד" : "כל המודעות השמורות"}${siteName ? ` · רק ${siteName}` : ""} · ${delaySeconds} שניות בין מודעות`;
    } else {
      $("scheduleStatus").textContent = "התזמון בוטל. רענון ידני עדיין זמין.";
    }
  } catch (error) {
    console.error("[lightrail-ext] failed to save refresh schedule", error);
    $("scheduleStatus").dataset.error = "true";
    $("scheduleStatus").textContent = error.message || "שמירת התזמון נכשלה.";
  } finally {
    button.disabled = false;
  }
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function lastRefreshedAt(key, record) {
  const logged = Number(refreshLog[key]) || 0;
  const checked = record && Number.isFinite(record.listingStatusCheckedAt) ? record.listingStatusCheckedAt : 0;
  return Math.max(logged, checked);
}

// נרשם בכל טעינת דף ברענון; רשומות של מודעות שכבר לא במטמון נמחקות מהיומן
async function logListingRefreshed(key) {
  refreshLog[key] = Date.now();
  for (const loggedKey of Object.keys(refreshLog)) {
    if (!cache[loggedKey]) delete refreshLog[loggedKey];
  }
  try {
    await storageSet({ [REFRESH_LOG_KEY]: refreshLog });
  } catch (error) {
    console.warn("[lightrail-ext] failed to save refresh log", error);
  }
}

async function saveListingStatus(key, status, attemptId, index) {
  if (!["active", "removed"].includes(status)) return;
  if (!refreshQueue.length || refreshAttemptId !== attemptId || refreshIndex !== index) return;
  // כתיבה אחרת באמצע – לא מוותרים על הסטטוס, מנסים שוב בעוד רגע
  if (writing) {
    setTimeout(() => saveListingStatus(key, status, attemptId, index), 400);
    return;
  }
  try {
    const latest = await storageGet();
    if (
      !refreshQueue.length ||
      refreshAttemptId !== attemptId ||
      refreshIndex !== index ||
      !latest[key] ||
      !["yad2", "madlan"].includes(recordSite(key))
    ) {
      return;
    }
    const checkedAt = Date.now();
    // updatedAt חייב להתעדכן: הסנכרון מכריע לפיו, ובלי זה הגרסה שבענן (בלי הסטטוס) "ניצחה" וחזרה
    // לכאן בסבב הבא. ביד2 זה עבד במקרה כי עמוד המודעה שומר אותה באותו רגע; מודעת מדלן שהוסרה – לא.
    latest[key] = {
      ...latest[key],
      listingStatus: status,
      listingStatusCheckedAt: checkedAt,
      updatedAt: checkedAt,
    };
    writing = true;
    await storageSet({ [CACHE_KEY]: latest });
    cache = latest;
    renderRows();
    renderListingDeletionPreview();
    ensureListingStatusKept(key, status, checkedAt);
    // שקיפות: מה נמצא במודעה שנפתחה
    const statusLine = $("refreshStatus");
    const note = status === "removed" ? " · המודעה הוסרה מהאתר ✓ (סומנה „הוסרה”)" : " · המודעה פעילה ✓";
    if (statusLine && !statusLine.textContent.includes(note)) statusLine.textContent += note;
  } catch (error) {
    console.error("[lightrail-ext] failed to save listing status", error);
    setRefreshStatus(`הדף נטען, אך סטטוס המודעה לא נשמר: ${error.message}`, true);
  } finally {
    writing = false;
  }
}

// העמוד שנפתח ברענון שומר בעצמו את כל המטמון מהזיכרון שלו. במדלן מודעה שהוסרה מנתבת לעמוד חיפוש
// עם עשרות כרטיסים, שכתיבה שלו ממש אחרי שלנו דרסה את הסטטוס. בודקים שוב אחרי כמה שניות ומחזירים אותו.
function ensureListingStatusKept(key, status, checkedAt, attempt = 0) {
  const delays = [2500, 6000, 12000];
  if (attempt >= delays.length) return;
  setTimeout(async () => {
    try {
      if (writing) return ensureListingStatusKept(key, status, checkedAt, attempt);
      const latest = await storageGet();
      const current = latest[key];
      if (!current) return;
      const kept = current.listingStatus === status && current.listingStatusCheckedAt >= checkedAt;
      if (!kept && !(current.listingStatusCheckedAt > checkedAt)) {
        latest[key] = { ...current, listingStatus: status, listingStatusCheckedAt: checkedAt, updatedAt: Date.now() };
        writing = true;
        try {
          await storageSet({ [CACHE_KEY]: latest });
        } finally {
          writing = false;
        }
        cache = latest;
        renderRows();
      }
      ensureListingStatusKept(key, status, checkedAt, attempt + 1);
    } catch (error) {
      console.warn("[lightrail-ext] could not verify listing status", error);
    }
  }, delays[attempt]);
}

// דיווח "המודעה הוסרה" שהעמוד שולח בעצמו (מדלן מנתבת מהר מאוד לעמוד חיפוש) – רק מלשונית הרענון,
// ומשויך למודעה שנפתחה בה עכשיו
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "lightrail:listing-status-notice" || message.status !== "removed") return;
  if (!refreshQueue.length || !sender.tab || sender.tab.id !== refreshTabId) return;
  const [key] = refreshQueue[refreshIndex] || [];
  if (!key || recordSite(key) !== "madlan") return;
  const expectedId = key.slice(key.indexOf(":") + 1);
  if (message.id && message.id !== expectedId) return;
  saveListingStatus(key, "removed", refreshAttemptId, refreshIndex);
});

function checkCurrentListingStatus(tabId, key, record, retries = 8) {
  const expectedId = key.slice(key.indexOf(":") + 1);
  const url = refreshableListingUrl(key, record);
  let urlId;
  try {
    const parsedUrl = new URL(url);
    const match = recordSite(key) === "madlan"
      ? parsedUrl.pathname.match(/\/(?:listings|bulletin)\/([^/]+)/)
      : parsedUrl.pathname.match(/^\/realestate\/item\/[^/]+\/([^/]+)/);
    urlId = match && match[1];
  } catch {
    return;
  }
  if (!urlId || urlId !== expectedId) return;

  const attemptId = refreshAttemptId;
  const index = refreshIndex;
  chrome.tabs.sendMessage(tabId, { type: "lightrail:get-listing-status" }, (result) => {
    const error = chrome.runtime.lastError;
    if (error) {
      if (
        retries > 0 &&
        refreshQueue.length &&
        refreshAttemptId === attemptId &&
        refreshIndex === index
      ) {
        setTimeout(() => {
          checkCurrentListingStatus(tabId, key, record, retries - 1);
        }, 250);
        return;
      }
      console.warn("[lightrail-ext] could not check listing status", error.message);
      return;
    }
    // עוד אין סטטוס (העמוד עדיין נטען, או מדלן עוד לא סיימה לנתב) – בודקים שוב בעוד רגע
    if (!result && retries > 0 && refreshQueue.length && refreshAttemptId === attemptId && refreshIndex === index) {
      setTimeout(() => checkCurrentListingStatus(tabId, key, record, retries - 1), 1500);
      return;
    }
    // מדלן מנתבת מודעה שהוסרה לעמוד חיפוש – התוצאה מגיעה בלי מזהה, מהלשונית שבה פתחנו את המודעה הזו
    const redirectedRemoval = result && result.redirected && result.status === "removed" && recordSite(key) === "madlan";
    if (!result || (result.id !== expectedId && !redirectedRemoval)) return;
    saveListingStatus(key, result.status, attemptId, index);
  });
}

function updateRefreshButtons() {
  const active = refreshQueue.length > 0;
  $("startRefresh").disabled = active || refreshStarting;
  $("pauseRefresh").disabled = !active;
  $("stopRefresh").disabled = !active;
  $("pauseRefresh").textContent = refreshPaused ? "המשך" : "השהיה";
}

function applyFontScale(value) {
  fontScale = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, Math.round(value * 10) / 10));
  document.body.style.zoom = String(fontScale);
  $("fontScaleValue").textContent = `${Math.round(fontScale * 100)}%`;
  // האחוז לא מוצג בכותרת (חוסך מקום) – מופיע במעבר עכבר
  const scaleText = `גודל הטקסט: ${Math.round(fontScale * 100)}%`;
  $("fontScaleValue").closest(".font-controls").title = scaleText;
  $("decreaseFont").title = `הקטנת הטקסט (${scaleText})`;
  $("increaseFont").title = `הגדלת הטקסט (${scaleText})`;
  $("decreaseFont").disabled = fontScale <= MIN_FONT_SCALE;
  $("increaseFont").disabled = fontScale >= MAX_FONT_SCALE;
}

async function changeFontScale(delta) {
  const status = $("fontScaleStatus");
  status.textContent = "";
  applyFontScale(fontScale + delta);
  try {
    await storageSet({ [FONT_SCALE_KEY]: fontScale });
  } catch (error) {
    console.error("[lightrail-ext] failed to save cache manager font scale", error);
    status.textContent = `גודל הטקסט השתנה, אך לא נשמר: ${error.message}`;
  }
}

// "שעה ו־50 דקות", "2 שעות ו־5 דקות", "12 דקות", "פחות מדקה"
function durationText(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return "פחות מדקה";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hoursText = hours === 1 ? "שעה" : hours === 2 ? "שעתיים" : `${hours.toLocaleString("he-IL")} שעות`;
  const minutesText = minutes === 1 ? "דקה" : `${minutes} דקות`;
  if (!hours) return minutesText;
  return minutes ? `${hoursText} ו־${minutesText}` : hoursText;
}

// הערכת זמן שנותר: (מספר הפריטים שנותרו) × (ההשהיה + זמן הטעינה הממוצע שנמדד עד עכשיו)
function remainingText(remaining, delaySec, workMs, workCount) {
  if (!(remaining > 0)) return "";
  const perItem = delaySec * 1000 + (workCount ? workMs / workCount : 0);
  const ms = remaining * perItem;
  return ` נותרו ${remaining.toLocaleString("he-IL")} · ${ms < 60000 ? "פחות מדקה" : `עוד כ־${durationText(ms)}`}.`;
}

function refreshRemainingText() {
  return remainingText(refreshQueue.length - refreshIndex - 1, refreshDelaySec, refreshLoadMs, refreshLoadCount);
}

function delayBetweenPages() {
  if (refreshPaused || !refreshQueue.length) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    advanceWhenDealsSaved(Date.now());
  }, refreshDelaySec * 1000);
}

// לא עוברים למודעה הבאה כל עוד הדף הנוכחי אוסף ושומר עסקאות אמת (יד2: כל העמודים, מדלן: "בסביבה").
// בודקים כל 2 שניות; עד 5 דקות כשהאיסוף רץ, ועד 30 שניות כשמדלן עוד לא התחילה לעבור ל"בסביבה".
function advanceWhenDealsSaved(waitStartedAt) {
  if (refreshPaused || !refreshQueue.length) return;
  const attemptId = refreshAttemptId;
  const next = () => {
    refreshLoadMs += Date.now() - waitStartedAt; // זמן ההמתנה נכנס להערכת הזמן שנותר
    refreshIndex++;
    openNextListing();
  };
  if (refreshTabId == null) return next();
  chrome.tabs.sendMessage(refreshTabId, { type: "lightrail:deals-status" }, (status) => {
    void chrome.runtime.lastError;
    if (attemptId !== refreshAttemptId || refreshPaused || !refreshQueue.length) return;
    const waited = Date.now() - waitStartedAt;
    const keepWaiting = status && (
      (status.busy && waited < REFRESH_DEALS_MAX_WAIT_MS) ||
      (status.pending && waited < REFRESH_DEALS_PENDING_WAIT_MS)
    );
    if (!keepWaiting) return next();
    setRefreshStatus(
      `הדף ${refreshIndex + 1}/${refreshQueue.length}: ממתין לסיום איסוף ושמירת עסקאות האמת (${Math.round(waited / 1000)} שניות)…${refreshRemainingText()}`
    );
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      advanceWhenDealsSaved(waitStartedAt);
    }, 2000);
  });
}

function skipRefreshListing(error, resetTab = false) {
  if (!refreshQueue.length) return;
  refreshSkippedCount++;
  console.warn(
    "[lightrail-ext] skipping listing during refresh",
    error && error.message ? error.message : error
  );
  clearTimeout(loadTimeout);
  loadTimeout = null;
  refreshAttemptId++;
  if (resetTab) refreshTabId = null;
  currentPageLoaded = true;
  const [key, record] = refreshQueue[refreshIndex];
  const title = record && record.title ? record.title : key;
  if (refreshPaused) {
    setRefreshStatus(
      `המודעה ${refreshIndex + 1}/${refreshQueue.length} דולגה (${title}); הרענון מושהה. אפשר להמשיך.`,
      true
    );
    return;
  }
  if (refreshIndex + 1 >= refreshQueue.length) {
    refreshIndex++;
    openNextListing();
    return;
  }
  setRefreshStatus(
    `המודעה ${refreshIndex + 1}/${refreshQueue.length} דולגה (${title}). ממשיך למודעה הבאה בעוד ${refreshDelaySec} שניות.${refreshRemainingText()}`,
    true
  );
  delayBetweenPages();
}

function onRefreshTabUpdated(tabId, changeInfo, tab) {
  if (!refreshQueue.length || tabId !== refreshTabId || changeInfo.status !== "complete") return;
  const pageUrl = changeInfo.url || (tab && tab.url) || "";
  if (/^(?:chrome-error:|chrome:\/\/)/i.test(pageUrl)) {
    skipRefreshListing(new Error("הדף לא נטען או אינו זמין."));
    return;
  }
  clearTimeout(loadTimeout);
  loadTimeout = null;
  currentPageLoaded = true;
  if (refreshItemStartedAt) {
    refreshLoadMs += Math.min(Date.now() - refreshItemStartedAt, REFRESH_LOAD_TIMEOUT_MS);
    refreshLoadCount++;
    refreshItemStartedAt = 0;
  }
  const [key, record] = refreshQueue[refreshIndex];
  logListingRefreshed(key);
  if (["yad2", "madlan"].includes(recordSite(key))) {
    checkCurrentListingStatus(tabId, key, record);
  }
  if (refreshPaused) {
    setRefreshStatus(`הדף ${refreshIndex + 1}/${refreshQueue.length} נטען; הרענון מושהה.`);
    return;
  }
  setRefreshStatus(
    `הדף ${refreshIndex + 1}/${refreshQueue.length} נטען. ממתין ${refreshDelaySec} שניות לפני הבא…${refreshRemainingText()}`
  );
  delayBetweenPages();
}

function startLoadTimeout() {
  clearTimeout(loadTimeout);
  loadTimeout = setTimeout(() => {
    loadTimeout = null;
    if (!refreshQueue.length || refreshPaused || currentPageLoaded) return;
    skipRefreshListing(new Error("הדף לא נטען בזמן שהוקצב."));
  }, REFRESH_LOAD_TIMEOUT_MS);
}

function openNextListing() {
  if (!refreshQueue.length) return;
  if (refreshIndex >= refreshQueue.length) {
    const skippedCount = refreshSkippedCount;
    refreshQueue = [];
    refreshSkippedCount = 0;
    currentPageLoaded = false;
    updateRefreshButtons();
    const result = skippedCount
      ? `הרענון הסתיים. ${skippedCount} מודעות דולגו עקב שגיאה.`
      : "הרענון הסתיים.";
    setRefreshStatus(result);
    reportRefreshRun("lightrail:refresh-run-finished", result);
    refreshRunScheduled = false;
    return;
  }
  const attemptId = ++refreshAttemptId;
  const [key, record] = refreshQueue[refreshIndex];
  const url = refreshableListingUrl(key, record);
  if (!url) {
    refreshIndex++;
    openNextListing();
    return;
  }
  currentPageLoaded = false;
  refreshItemStartedAt = Date.now();
  setRefreshStatus(`פותח מודעה ${refreshIndex + 1}/${refreshQueue.length}: ${record.title || key}`);
  const onError = (error, resetTab) => {
    if (attemptId !== refreshAttemptId || !refreshQueue.length) return;
    skipRefreshListing(error, resetTab);
  };
  if (refreshTabId === null) {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const error = chrome.runtime.lastError;
      if (attemptId !== refreshAttemptId || !refreshQueue.length) return;
      if (error || !tab || !Number.isInteger(tab.id)) {
        onError(new Error(error && error.message || "לא ניתן לפתוח כרטיסייה לרענון."), true);
        return;
      }
      refreshTabId = tab.id;
      startLoadTimeout();
    });
    return;
  }
  chrome.tabs.update(refreshTabId, { url, active: false }, (tab) => {
    const error = chrome.runtime.lastError;
    if (attemptId !== refreshAttemptId || !refreshQueue.length) return;
    if (error || !tab) {
      onError(new Error(error && error.message || "לא ניתן לעבור למודעה הבאה."), true);
      return;
    }
    startLoadTimeout();
  });
}

async function startRefresh(options = {}) {
  if (refreshQueue.length || refreshStarting) return;
  refreshStarting = true;
  updateRefreshButtons();
  const delayInput = $("refreshDelay");
  const parsedDelay = Number(delayInput.value);
  refreshDelaySec = Number.isFinite(parsedDelay)
    ? Math.max(MIN_REFRESH_DELAY_SEC, Math.min(MAX_REFRESH_DELAY_SEC, Math.round(parsedDelay)))
    : 30;
  delayInput.value = String(refreshDelaySec);
  try {
    await storageSet({ [REFRESH_DELAY_KEY]: refreshDelaySec });
  } catch (error) {
    console.error("[lightrail-ext] failed to save refresh delay", error);
    setRefreshStatus(error.message || "שמירת זמן ההמתנה נכשלה.", true);
    refreshStarting = false;
    updateRefreshButtons();
    return;
  }
  const uncheckedOnly = options.uncheckedOnly === true || $("refreshScope").value === "unchecked";
  const site = normalizeRefreshSite(options.site || $("refreshSite").value);
  const siteName = REFRESH_SITE_NAMES[site];
  // תמיד לפי מסנני טבלת המודעות (לא לפי הטבלה האחרונה שצוירה – מסך "חיפוש מודעה" בלי מסננים ריק)
  const sourceRecords = options.scheduled === true
    ? Object.entries(cache)
    : filterRecordsFor(false).list;
  // מודעות "לא רלוונטיות" (חסרים בהן מאפייני חובה) לא נפתחות שוב – חוסך אלפי טעינות דף
  let irrelevantSkipped = 0;
  refreshQueue = sourceRecords.filter(([key, record]) => {
    if (
      recordType(record) !== "listing" ||
      !refreshableListingUrl(key, record) ||
      (site !== "all" && recordSite(key) !== site) ||
      (uncheckedOnly &&
        (!["yad2", "madlan"].includes(recordSite(key)) || ["active", "removed"].includes(record.listingStatus)))
    ) return false;
    if (listingRelevance(record).irrelevant) {
      irrelevantSkipped++;
      return false;
    }
    return true;
  });
  // קודם מודעות שלא רועננו אף פעם, אחר כך מהישנה לחדשה: עצירה והפעלה מחדש ממשיכות מאיפה שלא הגענו
  try {
    const storedLog = await storageGet(REFRESH_LOG_KEY);
    refreshLog = storedLog && typeof storedLog === "object" ? storedLog : {};
  } catch (error) {
    console.warn("[lightrail-ext] failed to load refresh log", error);
  }
  refreshQueue.sort(([leftKey, left], [rightKey, right]) =>
    lastRefreshedAt(leftKey, left) - lastRefreshedAt(rightKey, right)
  );
  const refreshedToday = refreshQueue.filter(([key, record]) =>
    lastRefreshedAt(key, record) >= startOfToday()
  ).length;
  refreshIndex = 0;
  refreshSkippedCount = 0;
  refreshLoadMs = 0;
  refreshLoadCount = 0;
  refreshPaused = false;
  refreshRunScheduled = options.scheduled === true;
  const irrelevantNote = irrelevantSkipped
    ? ` ${irrelevantSkipped.toLocaleString("he-IL")} מודעות לא רלוונטיות לא ירועננו.`
    : "";
  if (!refreshQueue.length) {
    const message = (uncheckedOnly
        ? `אין מודעות${siteName ? ` ${siteName}` : ""} בסטטוס „לא נבדקה” עם קישור תקין.`
        : `אין בתוצאות המסוננות מודעות${siteName ? ` ${siteName}` : ""} עם קישור תקין.`) + irrelevantNote;
    setRefreshStatus(message, true);
    refreshStarting = false;
    updateRefreshButtons();
    if (refreshRunScheduled) {
      reportRefreshRun("lightrail:refresh-run-finished", message);
      refreshRunScheduled = false;
    }
    return;
  }
  refreshStarting = false;
  updateRefreshButtons();
  const scopeText = uncheckedOnly
    ? "מודעות יד2 שלא נבדקו"
    : `מודעות${siteName ? ` ${siteName}` : ""}`;
  const todayNote = refreshedToday
    ? ` ${refreshedToday.toLocaleString("he-IL")} שכבר רועננו היום יגיעו בסוף.`
    : "";
  setRefreshStatus(`מתחיל רענון של ${refreshQueue.length} ${scopeText}, קודם אלו שלא רועננו זמן רב; ההמתנה היא ${refreshDelaySec} שניות אחרי כל טעינה.${todayNote}${irrelevantNote}`);
  reportRefreshRun("lightrail:refresh-run-started", { scheduled: refreshRunScheduled });
  openNextListing();
}

function stopRefresh(showStatus = true) {
  const wasRunning = refreshQueue.length > 0;
  refreshAttemptId++;
  clearTimeout(refreshTimer);
  clearTimeout(loadTimeout);
  refreshTimer = null;
  loadTimeout = null;
  refreshQueue = [];
  refreshIndex = 0;
  refreshSkippedCount = 0;
  refreshPaused = false;
  currentPageLoaded = false;
  updateRefreshButtons();
  if (showStatus) setRefreshStatus("הרענון נעצר. כרטיסיית המודעה נשארה פתוחה.");
  if (wasRunning) {
    reportRefreshRun("lightrail:refresh-run-finished", "הרענון נעצר על ידי המשתמש");
  }
  refreshRunScheduled = false;
}

function toggleRefreshPause() {
  if (!refreshQueue.length) return;
  refreshPaused = !refreshPaused;
  if (refreshPaused) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    setRefreshStatus("הרענון מושהה. אפשר להמשיך או לעצור.");
  } else if (currentPageLoaded) {
    setRefreshStatus(`המשך: ממתין ${refreshDelaySec} שניות לפני המודעה הבאה…${refreshRemainingText()}`);
    delayBetweenPages();
  } else {
    setRefreshStatus("הרענון ממשיך וממתין לסיום טעינת הדף הנוכחי.");
    startLoadTimeout();
  }
  updateRefreshButtons();
}

// ---------- דפדוף בעמודי חיפוש ----------
// פותח עמוד אחרי עמוד בכרטיסייה אחת, מחכה לטעינה מלאה, מבקש מסקריפט התוכן לגלול לאט עד למטה,
// ורק אז ממתין את ההשהיה ועובר לעמוד הבא. סקריפט התוכן שומר את הכרטיסים שעוברים מולו.
const WALKER_SETTINGS_KEY = "lightrailWalker";
const WALKER_LOAD_TIMEOUT_MS = 60000;
const WALKER_AFTER_LOAD_MS = 1500;
const walker = {
  urls: [], index: 0, tabId: null, attempt: 0, phase: "idle", paused: false,
  sawLoading: false, timer: null, loadTimer: null, delaySec: 5, speed: "normal",
  cards: 0, skipped: 0, pageStartedAt: 0, workMs: 0, workCount: 0,
};

function walkerRemainingText() {
  return remainingText(walker.urls.length - walker.index - 1, walker.delaySec, walker.workMs, walker.workCount);
}

function walkerActive() {
  return walker.urls.length > 0;
}

function setWalkerStatus(text, error = false) {
  const status = $("walkerStatus");
  status.textContent = text;
  status.dataset.error = error ? "true" : "false";
}

function updateWalkerButtons() {
  const active = walkerActive();
  $("startWalker").disabled = active;
  $("pauseWalker").disabled = !active;
  $("stopWalker").disabled = !active;
  $("pauseWalker").textContent = walker.paused ? "המשך" : "השהיה";
  for (const id of ["walkerUrl", "walkerFrom", "walkerTo"]) $(id).disabled = active;
}

function walkerPageLabel() {
  const current = walker.urls[walker.index];
  return `עמוד ${current ? current.page : "?"} (${walker.index + 1}/${walker.urls.length})`;
}

function saveWalkerSettings() {
  try {
    localStorage.setItem(WALKER_SETTINGS_KEY, JSON.stringify({
      url: $("walkerUrl").value.trim(),
      from: $("walkerFrom").value,
      to: $("walkerTo").value,
      speed: $("walkerSpeed").value,
      delay: $("walkerDelay").value,
    }));
  } catch {}
}

function loadWalkerSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(WALKER_SETTINGS_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.url === "string") $("walkerUrl").value = saved.url;
    if (saved.from) $("walkerFrom").value = saved.from;
    if (saved.to) $("walkerTo").value = saved.to;
    if (LRPageWalker.SPEEDS[saved.speed]) $("walkerSpeed").value = saved.speed;
    if (saved.delay !== undefined && saved.delay !== "") $("walkerDelay").value = saved.delay;
  } catch {}
}

function readWalkerDelay() {
  const value = Number($("walkerDelay").value);
  walker.delaySec = Number.isFinite(value) ? Math.max(0, Math.min(600, Math.round(value))) : 5;
  $("walkerDelay").value = String(walker.delaySec);
  walker.speed = LRPageWalker.SPEEDS[$("walkerSpeed").value] ? $("walkerSpeed").value : "normal";
}

function startWalker() {
  if (walkerActive()) return;
  const built = LRPageWalker.buildPageUrls($("walkerUrl").value, $("walkerFrom").value, $("walkerTo").value);
  if (built.error) {
    setWalkerStatus(built.error, true);
    return;
  }
  readWalkerDelay();
  saveWalkerSettings();
  Object.assign(walker, {
    urls: built.urls, index: 0, paused: false, phase: "idle", cards: 0, skipped: 0, pageStartedAt: 0, workMs: 0, workCount: 0,
  });
  updateWalkerButtons();
  openWalkerPage();
}

function finishWalker(message) {
  walker.attempt++;
  clearTimeout(walker.timer);
  clearTimeout(walker.loadTimer);
  Object.assign(walker, { urls: [], index: 0, phase: "idle", paused: false, timer: null, loadTimer: null });
  updateWalkerButtons();
  setWalkerStatus(message);
}

function walkerSummary() {
  const skipped = walker.skipped ? ` ${walker.skipped} עמודים דולגו עקב שגיאה.` : "";
  return `נסרקו ${walker.cards.toLocaleString("he-IL")} כרטיסי מודעות.${skipped}`;
}

function openWalkerPage() {
  if (!walkerActive()) return;
  if (walker.index >= walker.urls.length) {
    finishWalker(`הדפדוף הסתיים. ${walkerSummary()}`);
    loadCache();
    return;
  }
  const attempt = ++walker.attempt;
  const { url } = walker.urls[walker.index];
  walker.phase = "loading";
  walker.sawLoading = false;
  walker.pageStartedAt = Date.now();
  setWalkerStatus(`טוען ${walkerPageLabel()}…`);
  clearTimeout(walker.loadTimer);
  walker.loadTimer = setTimeout(() => {
    if (attempt !== walker.attempt || walker.phase !== "loading") return;
    skipWalkerPage("העמוד לא נטען בזמן שהוקצב.");
  }, WALKER_LOAD_TIMEOUT_MS);
  const done = (tab) => {
    const error = chrome.runtime.lastError;
    if (attempt !== walker.attempt) return;
    if (error || !tab || !Number.isInteger(tab.id)) {
      walker.tabId = null;
      skipWalkerPage(error && error.message || "לא ניתן לפתוח את העמוד.");
      return;
    }
    walker.tabId = tab.id;
  };
  if (walker.tabId === null) chrome.tabs.create({ url, active: true }, done);
  else chrome.tabs.update(walker.tabId, { url }, done);
}

function skipWalkerPage(reason) {
  if (!walkerActive()) return;
  walker.skipped++;
  clearTimeout(walker.loadTimer);
  console.warn("[lightrail-ext] page walker skipped a page", reason);
  setWalkerStatus(`${walkerPageLabel()} דולג: ${reason}`, true);
  scheduleNextWalkerPage();
}

function scheduleNextWalkerPage() {
  walker.phase = "waiting";
  if (walker.paused) return;
  clearTimeout(walker.timer);
  const isLast = walker.index + 1 >= walker.urls.length;
  walker.timer = setTimeout(() => {
    walker.timer = null;
    walker.index++;
    openWalkerPage();
  }, isLast ? 0 : walker.delaySec * 1000);
}

function onWalkerTabUpdated(tabId, changeInfo) {
  if (!walkerActive() || tabId !== walker.tabId || walker.phase !== "loading") return;
  if (changeInfo.status === "loading") walker.sawLoading = true;
  if (changeInfo.status !== "complete" || !walker.sawLoading) return;
  clearTimeout(walker.loadTimer);
  walker.phase = "scrolling";
  const attempt = walker.attempt;
  setWalkerStatus(`${walkerPageLabel()} נטען. גולל עד למטה…`);
  setTimeout(() => {
    if (attempt === walker.attempt) scrollWalkerPage(attempt, 6);
  }, WALKER_AFTER_LOAD_MS);
}

function scrollWalkerPage(attempt, retries) {
  chrome.tabs.sendMessage(walker.tabId, { type: "lightrail:walker-scroll", speed: walker.speed }, (result) => {
    const error = chrome.runtime.lastError;
    if (attempt !== walker.attempt || !walkerActive()) return;
    if (error || !result) {
      // סקריפט התוכן עוד לא מוכן, או שהעמוד עבר לכתובת אחרת באמצע
      if (retries > 0) {
        setTimeout(() => {
          if (attempt === walker.attempt) scrollWalkerPage(attempt, retries - 1);
        }, 1000);
      } else {
        skipWalkerPage("לא ניתן לגלול בעמוד (התוסף לא פעיל בו?).");
      }
      return;
    }
    if (result.reason === "stopped") return;
    if (walker.pageStartedAt) {
      walker.workMs += Date.now() - walker.pageStartedAt;
      walker.workCount++;
      walker.pageStartedAt = 0;
    }
    walker.cards += Number(result.cards) || 0;
    if (!result.cards) {
      // אין מודעות: סוף התוצאות, או בדיקת "אני לא רובוט". עוצרים עד שהמשתמש מחליט
      walker.paused = true;
      walker.phase = "empty";
      updateWalkerButtons();
      setWalkerStatus(
        `ב${walkerPageLabel()} לא נמצאו מודעות – אולי הגעתם לסוף התוצאות או שהאתר מבקש אימות. ` +
        "אם צריך, השלימו את האימות בכרטיסייה ולחצו „המשך” (העמוד ייסרק שוב), או „עצירה”.",
        true
      );
      return;
    }
    const isLast = walker.index + 1 >= walker.urls.length;
    setWalkerStatus(
      `${walkerPageLabel()} נסרק (${result.cards} מודעות${result.reason === "timeout" ? ", הגלילה נעצרה אחרי זמן מרבי" : ""}).` +
      (walker.paused ? " הדפדוף מושהה." : isLast ? "" : ` ממתין ${walker.delaySec} שניות לעמוד הבא…${walkerRemainingText()}`)
    );
    scheduleNextWalkerPage();
  });
}

function toggleWalkerPause() {
  if (!walkerActive()) return;
  walker.paused = !walker.paused;
  readWalkerDelay();
  updateWalkerButtons();
  if (walker.paused) {
    clearTimeout(walker.timer);
    walker.timer = null;
    setWalkerStatus(walker.phase === "waiting"
      ? "הדפדוף מושהה."
      : "הדפדוף יושהה אחרי שהעמוד הנוכחי ייסרק.");
    return;
  }
  if (walker.phase === "empty") {
    walker.phase = "scrolling";
    setWalkerStatus(`סורק שוב את ${walkerPageLabel()}…`);
    scrollWalkerPage(++walker.attempt, 3);
  } else if (walker.phase === "waiting") {
    setWalkerStatus(`ממשיך: ממתין ${walker.delaySec} שניות לעמוד הבא…${walkerRemainingText()}`);
    scheduleNextWalkerPage();
  } else {
    setWalkerStatus("הדפדוף ממשיך.");
  }
}

function stopWalker(message = "הדפדוף נעצר. הכרטיסייה נשארה פתוחה.") {
  if (!walkerActive()) return;
  if (walker.tabId !== null) {
    chrome.tabs.sendMessage(walker.tabId, { type: "lightrail:walker-stop-scroll" }, () => void chrome.runtime.lastError);
  }
  finishWalker(`${message} ${walkerSummary()}`);
  loadCache();
}

// מעדכן רק את מה שמוצג כרגע; תצוגות אחרות נבנות כשעוברים אליהן
function applyCacheToViews() {
  renderRows();
  if (activeTab === "delete") renderListingDeletionPreview();
  if (activeTab === "dashboard") renderDashboard();
  if (selectedKey && cache[selectedKey]) openRecord(selectedKey);
  else if (selectedKey) closeDetails();
}

// ---------- עסקאות אמת באזור ----------
// האינדקס נבנה פעם אחת לכל טעינה של העסקאות; ההשוואה לכל מודעה נשמרת לפי אובייקט הרשומה
let dealsIndex = null;
let dealsVersion = 0;
let dealsTotal = 0;
let realDealsMemo = new WeakMap();

let dealsStore = {};

async function loadDeals() {
  try {
    const store = await LRDeals.loadAll(chrome.storage.local);
    dealsStore = store;
    dealsTotal = Object.keys(store).length;
    $("dealsCount").textContent = dealsTotal.toLocaleString("he-IL");
    dealsIndex = LRDeals.buildIndex(store);
  } catch (error) {
    console.warn("[lightrail-ext] failed to load real deals", error);
    dealsIndex = null;
  }
  dealsVersion++;
  realDealsMemo = new WeakMap();
}

function realDealsFor(record) {
  if (!dealsIndex || !record || typeof record !== "object" || recordType(record) === "project") return null;
  if (!realDealsMemo.has(record)) {
    realDealsMemo.set(record, LRDeals.compareListing(record, dealsIndex, LRCacheData.pricePerSqm(record)));
  }
  return realDealsMemo.get(record);
}

const realDealsAllMemo = { version: -1, map: new WeakMap() };
const NO_REAL_DEALS = Object.freeze({ building: null, street: null, neighborhood: null, city: null });
function realDealsAllFor(record) {
  if (!dealsIndex || !record || typeof record !== "object" || recordType(record) === "project") return NO_REAL_DEALS;
  if (realDealsAllMemo.version !== dealsVersion) {
    realDealsAllMemo.version = dealsVersion;
    realDealsAllMemo.map = new WeakMap();
  }
  if (!realDealsAllMemo.map.has(record)) {
    realDealsAllMemo.map.set(record, LRDeals.compareListingAll(record, dealsIndex, LRCacheData.pricePerSqm(record)));
  }
  return realDealsAllMemo.map.get(record);
}

// "−8% (12)" – כוכבית כשההשוואה היא לכל הגדלים (אין מספיק בגודל דומה)
function realLevelText(result) {
  if (!result || !Number.isFinite(result.diffPct)) return result ? `(${result.count})` : "";
  const sign = result.diffPct > 0 ? "+" : "";
  return `${sign}${result.diffPct}% (${result.count}${result.similar ? "" : "*"})`;
}

function realDealsText(result) {
  if (!result) return "";
  const sign = result.diffPct > 0 ? "+" : "";
  const where = `${LRDeals.LEVEL_LABELS[result.level]} (${result.count}${result.similar ? "" : ", כל הגדלים"})`;
  return Number.isFinite(result.diffPct) ? `${sign}${result.diffPct}% · ${where}` : where;
}

function realDealsTitle(result) {
  if (!result) return "אין מספיק עסקאות אמת שמורות ליד הכתובת הזו (צריך 3 בבניין או ברחוב, או 5 בשכונה). עסקאות נאספות כשפותחים מודעות ביד2 ובמדלן.";
  return `חציון ${displayPrice(result.medianPpsm)} למ״ר מ־${result.count} עסקאות ${LRDeals.LEVEL_LABELS[result.level]}, ${result.fromDate} עד ${result.toDate}. ` +
    (result.similar
      ? "רק עסקאות בגודל דומה (שטח ±35%, עד חדר הבדל). "
      : "אין מספיק עסקאות בגודל דומה, אז ההשוואה היא לכל הגדלים – פחות מדויקת. ") +
    "חיובי = המודעה יקרה מהעסקאות, שלילי = זולה מהן.";
}

// ---------- מסך "חיפוש עסקאות" ----------
const DEALS_PAGE_SIZE = 200;
// מיון לפי עד 3 עמודות, לפי סדר הלחיצה (כמו ORDER BY). ריק = ברירת המחדל: תאריך, החדש קודם.
// לחיצה על עמודה: מוסיפה אותה → הופכת כיוון → מסירה אותה.
const DEALS_SORT_MAX = 3;
const DEALS_SORT_DEFAULT = [{ key: "date", direction: -1 }];
let dealsSort = [];
const dealsSortOrder = () => (dealsSort.length ? dealsSort : DEALS_SORT_DEFAULT);
const DEALS_SORT_LABELS = { date: "תאריך", address: "כתובת", rooms: "חדרים", sqm: "מ״ר", price: "מחיר", ppsm: "₪ למ״ר" };
const DEALS_SORT_WORDS = {
  date: ["הישן קודם", "החדש קודם"],
  address: ["א→ת", "ת→א"],
};
function dealsSortDirectionText(key, direction) {
  const words = DEALS_SORT_WORDS[key] || ["מהנמוך לגבוה", "מהגבוה לנמוך"];
  return `${direction < 0 ? "▼" : "▲"} ${direction < 0 ? words[1] : words[0]}`;
}
// תיבת המיון בצד: הסדר הנוכחי, הפיכת כיוון, הסרה והוספה
function renderDealsSortBox(order) {
  const list = $("dealsSortList");
  if (!list) return;
  list.replaceChildren();
  order.forEach((sort, index) => {
    const item = el("li", "side-sort-item");
    item.append(el("span", "side-sort-rank", String(index + 1)), el("span", "side-sort-name", DEALS_SORT_LABELS[sort.key] || sort.key));
    const flip = el("button", "side-sort-dir", dealsSortDirectionText(sort.key, sort.direction));
    flip.type = "button";
    flip.title = "הפיכת כיוון המיון";
    flip.addEventListener("click", () => {
      const base = dealsSort.length ? dealsSort : DEALS_SORT_DEFAULT;
      dealsSort = base.map((s, i) => (i === index ? { ...s, direction: -s.direction } : s));
      renderDeals();
    });
    item.append(flip);
    if (dealsSort.length) {
      const remove = el("button", "side-sort-remove", "✕");
      remove.type = "button";
      remove.title = "הסרה מהמיון";
      remove.setAttribute("aria-label", `הסרת ${DEALS_SORT_LABELS[sort.key] || sort.key} מהמיון`);
      remove.addEventListener("click", () => {
        dealsSort = dealsSort.filter((_, i) => i !== index);
        renderDeals();
      });
      item.append(remove);
    } else {
      item.append(el("span", "side-sort-default", "ברירת מחדל"));
    }
    list.append(item);
  });
  const add = $("dealsSortAdd");
  for (const option of add.options) {
    if (option.value) option.disabled = dealsSort.some((sort) => sort.key === option.value);
  }
  add.disabled = dealsSort.length >= DEALS_SORT_MAX;
  add.value = "";
}
function toggleDealsSort(key) {
  const index = dealsSort.findIndex((sort) => sort.key === key);
  const initial = key === "address" ? 1 : -1;
  // במיון ברירת המחדל (תאריך) – לחיצה על תאריך הופכת אותו, כמו קודם
  if (!dealsSort.length && key === "date") {
    dealsSort = [{ key, direction: 1 }];
  } else if (index < 0) {
    dealsSort = [...dealsSort, { key, direction: initial }].slice(-DEALS_SORT_MAX);
  } else if (dealsSort[index].direction === initial) {
    dealsSort = dealsSort.map((sort, i) => (i === index ? { key, direction: -initial } : sort));
  } else {
    dealsSort = dealsSort.filter((_, i) => i !== index);
  }
}
let dealsLimit = DEALS_PAGE_SIZE;
let listingPlacesMemo = { cache: null, size: -1, places: new Map() };

// כמה מודעות שמורות יש בכל כתובת (עיר + רחוב + מספר בית)
function listingPlaces() {
  const size = Object.keys(cache).length;
  if (listingPlacesMemo.cache !== cache || listingPlacesMemo.size !== size) {
    const places = new Map();
    for (const record of Object.values(cache)) {
      if (!record || typeof record !== "object" || recordType(record) === "project") continue;
      const place = LRDeals.listingPlace(record);
      if (!place.city || !place.street || !place.house) continue;
      const key = `${place.city}|${place.street}|${place.house}`;
      places.set(key, (places.get(key) || 0) + 1);
    }
    listingPlacesMemo = { cache, size, places };
  }
  return listingPlacesMemo.places;
}

function readDealsFilters() {
  const filters = {
    query: $("dealsQuery").value,
    city: $("dealsCity").value,
    neighborhood: $("dealsHood").value,
    source: $("dealsSource").value,
  };
  for (const input of document.querySelectorAll("[data-deals-min], [data-deals-max]")) {
    if (input.value === "") continue;
    const isMin = input.dataset.dealsMin !== undefined;
    const name = isMin ? input.dataset.dealsMin : input.dataset.dealsMax;
    filters[name] = { ...(filters[name] || {}), [isMin ? "min" : "max"]: Number(input.value) };
  }
  return filters;
}

let dealsCitiesVersion = -1;
function fillDealsCities() {
  // רשימת הערים משתנה רק כשהעסקאות נטענות מחדש
  if (dealsCitiesVersion === dealsVersion) return;
  dealsCitiesVersion = dealsVersion;
  const select = $("dealsCity");
  const current = select.value;
  const cities = [...new Set(Object.values(dealsStore).map((deal) => deal && deal.city).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "he"));
  const known = [...select.options].slice(1).map((option) => option.value);
  if (known.join("|") === cities.join("|")) return;
  select.replaceChildren(new Option("כל הערים", ""), ...cities.map((city) => new Option(city, city)));
  select.value = cities.includes(current) ? current : "";
}

// שכונות לבחירה: של העיר שנבחרה (או של כל הערים, עם שם העיר). שכונה שנכתבה בכמה צורות מופיעה פעם אחת.
let dealsHoodsKey = "";
function fillDealsHoods() {
  const select = $("dealsHood");
  const cityValue = $("dealsCity").value;
  const key = `${dealsVersion}|${cityValue}`;
  if (dealsHoodsKey === key) return;
  dealsHoodsKey = key;
  const city = cityValue ? LRDeals.normCity(cityValue) : "";
  const hoods = new Map();
  for (const deal of Object.values(dealsStore)) {
    if (!deal || !deal.neighborhood) continue;
    const dealCity = LRDeals.normCity(deal.city);
    if (city && dealCity !== city) continue;
    const id = `${dealCity}|${LRDeals.normHood(deal.neighborhood)}`;
    const item = hoods.get(id) || { name: String(deal.neighborhood).trim(), city: deal.city, count: 0 };
    item.count++;
    hoods.set(id, item);
  }
  const current = select.value;
  const currentNorm = current ? LRDeals.normHood(current) : "";
  const items = [...hoods.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "he") || String(a.city).localeCompare(String(b.city), "he"));
  select.replaceChildren(new Option("כל השכונות", ""), ...items.map((item) => {
    const option = new Option(`${item.name}${city ? "" : ` · ${item.city}`} (${item.count.toLocaleString("he-IL")})`, item.name);
    option.dataset.city = item.city || "";
    return option;
  }));
  const keep = currentNorm && items.find((item) => LRDeals.normHood(item.name) === currentNorm);
  select.value = keep ? keep.name : "";
}

// בוחר שכונה (ואת העיר שלה, אם לא נבחרה עיר)
function setDealsHood(name, city = "") {
  if (city && !$("dealsCity").value) {
    $("dealsCity").value = [...$("dealsCity").options].some((option) => option.value === city) ? city : "";
  }
  fillDealsHoods();
  const wanted = name ? LRDeals.normHood(name) : "";
  const option = wanted ? [...$("dealsHood").options].find((item) => item.value && LRDeals.normHood(item.value) === wanted) : null;
  $("dealsHood").value = option ? option.value : "";
  return Boolean(option);
}

function renderDeals() {
  if (activeTab !== "deals") return;
  fillDealsCities();
  fillDealsHoods();
  // סינון, מיון וסיכום נשמרים לפי המסננים: חזרה ללשונית או "הצג עוד" לא מחשבים הכל מחדש
  const listKey = `${dealsVersion}|${JSON.stringify(readDealsFilters())}|${JSON.stringify(dealsSortOrder())}`;
  if (dealsListMemo.key !== listKey) {
    const list = LRDeals.sortDeals(LRDeals.filterDeals(dealsStore, readDealsFilters()), dealsSortOrder());
    dealsListMemo = { key: listKey, list, summary: LRDeals.summarizeDeals(list) };
  }
  const { list, summary } = dealsListMemo;
  const status = $("dealsSummary");
  status.replaceChildren();
  if (!dealsTotal) {
    status.textContent = "עוד לא נאספו עסקאות. פתחו מודעות ביד2 או במדלן – העסקאות שבסביבה נשמרות כאן אוטומטית.";
  } else {
    const strong = document.createElement("strong");
    strong.textContent = `${summary.count.toLocaleString("he-IL")} עסקאות`;
    status.append(
      strong,
      ` מתוך ${dealsTotal.toLocaleString("he-IL")}`,
      summary.count
        ? ` · חציון ${displayPrice(summary.medianPpsm)} למ״ר · מחיר חציוני ${displayPrice(summary.medianPrice)} · ${summary.fromDate || "?"} עד ${summary.toDate || "?"}`
        : ""
    );
  }
  const order = dealsSortOrder();
  renderDealsSortBox(order);
  for (const button of document.querySelectorAll("[data-deals-sort]")) {
    const index = order.findIndex((sort) => sort.key === button.dataset.dealsSort);
    const active = index >= 0;
    button.dataset.active = String(active);
    const arrow = active ? (order[index].direction < 0 ? "▼" : "▲") : "";
    // כשממיינים לפי כמה עמודות – גם המספר (1, 2, 3) של כל עמודה בסדר המיון
    const rank = active && order.length > 1 ? `${index + 1}` : "";
    button.textContent = button.textContent.replace(/ \d?[▲▼]$/, "") + (active ? ` ${rank}${arrow}` : "");
    const initial = button.dataset.dealsSort === "address" ? 1 : -1;
    const next = !dealsSort.length || order[index]?.direction === initial ? "הפיכת כיוון" : "הסרה מהמיון";
    button.title = active
      ? `${order.length > 1 ? `מיון ${index + 1} מתוך ${order.length} · ` : ""}לחיצה: ${next}`
      : `לחיצה: הוספה למיון (עד ${DEALS_SORT_MAX} עמודות, לפי סדר הלחיצה)`;
  }
  const places = listingPlaces();
  const rowsHost = $("dealsRows");
  const fragment = document.createDocumentFragment();
  for (const [, deal] of list.slice(0, dealsLimit)) {
    const row = document.createElement("tr");
    const cell = (text, className) => {
      const td = document.createElement("td");
      if (className) td.className = className;
      td.textContent = text === null || text === undefined ? "" : String(text);
      row.appendChild(td);
      return td;
    };
    cell(deal.date ? deal.date.split("-").reverse().join(".") : "");
    cell(`${deal.street} ${deal.house}, ${deal.city}`, "deal-address");
    cell(deal.neighborhood || "");
    cell(Number.isFinite(deal.rooms) ? deal.rooms : "");
    cell(Number.isFinite(deal.sqm) ? deal.sqm : "");
    cell(Number.isFinite(deal.floor) ? (Number.isFinite(deal.totalFloors) ? `${deal.floor}/${deal.totalFloors}` : deal.floor) : "");
    cell(displayPrice(deal.price));
    cell(displayPrice(LRDeals.dealPpsm(deal)));
    cell(Number.isFinite(deal.buildYear) ? deal.buildYear : "");
    cell((deal.sources || []).map((source) => (source === "yad2" ? "יד2" : source === "madlan" ? "מדלן" : source)).join(" + "), "deal-sources");
    const listingsCell = cell("", "deal-listings");
    const count = places.get(LRDeals.placeKey(deal.city, deal.street, deal.house)) || 0;
    if (count) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${count} מודעות`;
      button.title = "פתיחת המודעות השמורות בכתובת הזו";
      button.addEventListener("click", () => openSearchWith({ query: `${deal.street} ${deal.house}` }));
      listingsCell.appendChild(button);
    }
    fragment.appendChild(row);
  }
  rowsHost.replaceChildren(fragment);
  scheduleDealsStats(list);
  const more = $("dealsMore");
  const remaining = list.length - Math.min(list.length, dealsLimit);
  more.hidden = remaining <= 0;
  more.firstChild.textContent = `מוצגות ${Math.min(list.length, dealsLimit).toLocaleString("he-IL")} מתוך ${list.length.toLocaleString("he-IL")}`;
  more.lastChild.textContent = `הצג עוד ${Math.min(DEALS_PAGE_SIZE, remaining).toLocaleString("he-IL")}`;
}

// ---------- סטטיסטיקות על תוצאות חיפוש העסקאות ----------
// מוצגות כשמחפשים כתובת/עיר/שכונה או מסננים: מספרים מרכזיים, מחיר למ״ר לאורך זמן,
// מחיר חציוני לפי שנה, ופילוח לפי שנה, חדרים, קומה, שנת בנייה ובניין.
const SVG_NS = "http://www.w3.org/2000/svg";
let dealsStatsKey = "";
let dealsListMemo = { key: "", list: [], summary: null };
// ניתוח לפי רשימה (ולפי תקופה): אותה רשימה = אותה תוצאה, בלי לחשב שוב
let dealsAnalysisMemo = new WeakMap();
function analyzeDealsCached(list) {
  if (!dealsAnalysisMemo.has(list)) dealsAnalysisMemo.set(list, LRDeals.analyzeDeals(list));
  return dealsAnalysisMemo.get(list);
}

// הטבלה מוצגת מיד, והסטטיסטיקות (החישוב הכבד) נבנות רגע אחרי – כך המסך נפתח בלי המתנה
let dealsStatsTimer = 0;
function scheduleDealsStats(list) {
  clearTimeout(dealsStatsTimer);
  const host = $("dealsStats");
  const filtersKey = `${dealsVersion}|${JSON.stringify(readDealsFilters())}|${list.length}`;
  if (filtersKey === dealsStatsKey && !host.hidden) return;
  if (list.length && !host.hidden) host.setAttribute("aria-busy", "true");
  dealsStatsTimer = setTimeout(() => {
    host.removeAttribute("aria-busy");
    if (activeTab === "deals") renderDealsStats(list);
  }, 30);
}
const DEALS_PERIOD_KEY = "lightrailDealsPeriod";
const DEALS_PERIODS = [
  { years: 1, label: "שנה אחרונה" },
  { years: 2, label: "שנתיים" },
  { years: 3, label: "3 שנים" },
  { years: 0, label: "הכל" },
];
let dealsPeriodYears = (() => {
  try {
    const saved = Number(localStorage.getItem(DEALS_PERIOD_KEY));
    return DEALS_PERIODS.some((period) => period.years === saved) ? saved : 0;
  } catch {
    return 0;
  }
})();
// תאריך ההתחלה (YYYY-MM-DD) של N השנים האחרונות, נכון להיום
function dealsPeriodCutoff(years) {
  const now = new Date();
  const from = new Date(now.getFullYear() - years, now.getMonth(), now.getDate());
  const pad = (n) => String(n).padStart(2, "0");
  return `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
}
function dealsInPeriod(list, years) {
  if (!years) return list;
  const cutoff = dealsPeriodCutoff(years);
  return list.filter(([, deal]) => deal && /^\d{4}-\d{2}-\d{2}$/.test(String(deal.date)) && deal.date >= cutoff);
}

function dealsFiltersActive(filters) {
  return Object.entries(filters).some(([name, value]) =>
    name === "query" ? String(value || "").trim() !== "" : typeof value === "object" ? true : Boolean(value)
  );
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

// שנתות "עגולות" (1/2/5 כפול חזקה של 10) בערך count שנתות
function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((value) => value >= raw) || 10 * power;
  const ticks = [];
  // השנתה האחרונה תמיד מעל המקסימום, כדי שעמודה/נקודה לא תחרוג מהציר
  for (let value = Math.floor(min / step) * step; ; value += step) {
    ticks.push(Math.round(value));
    if (value >= max - step * 1e-9) break;
  }
  return ticks;
}

function shortShekels(value) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1e6) return `₪${(value / 1e6).toLocaleString("he-IL", { maximumFractionDigits: 2 })}M`;
  if (Math.abs(value) >= 1e3) return `₪${Math.round(value / 1e3).toLocaleString("he-IL")}K`;
  return `₪${Math.round(value)}`;
}

function signedPct(value) {
  if (!Number.isFinite(value)) return "—";
  // בידוד כיווניות: בלי זה הסימן + קופץ לסוף המספר בטקסט עברי
  return `\u2066${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("he-IL", { maximumFractionDigits: 1 })}%\u2069`;
}

// טווח מספרים תמיד משמאל לימין ("2.5–3", "₪20K – ₪24K"), בלי שהכיווניות העברית תהפוך חלק ממנו
function ltrText(text) {
  return `\u2066${text}\u2069`;
}

function dealDateText(date) {
  return date ? String(date).split("-").reverse().join(".") : "";
}

function showDealsTip(event, rows) {
  const tip = $("dealsTip");
  tip.replaceChildren(
    ...rows.map(([label, value, strong]) => {
      const line = document.createElement("div");
      line.className = "deals-tip-row";
      const v = document.createElement(strong ? "strong" : "span");
      v.textContent = value;
      const l = document.createElement("span");
      l.className = "deals-tip-label";
      l.textContent = label;
      line.append(v, l);
      return line;
    })
  );
  tip.hidden = false;
  const pad = 14;
  const { innerWidth, innerHeight } = window;
  const rect = tip.getBoundingClientRect();
  let left = event.clientX + pad;
  let top = event.clientY + pad;
  if (left + rect.width > innerWidth - 8) left = event.clientX - rect.width - pad;
  if (top + rect.height > innerHeight - 8) top = event.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideDealsTip() {
  $("dealsTip").hidden = true;
}

// מחיר למ״ר לאורך זמן: נקודה לכל עסקה, קו של החציון השנתי ורצועה של 50% האמצעיים
function dealsPpsmChart(stats, width) {
  const W = width, H = 300, M = { top: 14, right: 16, bottom: 30, left: 64 };
  const years = stats.byYear.filter((row) => Number.isFinite(row.medianPpsm));
  const firstYear = Math.min(...years.map((row) => row.year));
  const lastYear = Math.max(...years.map((row) => row.year));
  const ppsmValues = stats.points.map((point) => point.ppsm);
  // ציר Y לפי 2%–98% מהעסקאות, כדי שעסקה חריגה אחת לא תמחץ את כל הגרף
  let low = Math.min(LRDeals.quantile(ppsmValues, 0.02), ...years.map((row) => row.p25Ppsm));
  let high = Math.max(LRDeals.quantile(ppsmValues, 0.98), ...years.map((row) => row.p75Ppsm));
  const padding = Math.max((high - low) * 0.08, high * 0.02);
  low = Math.max(0, low - padding);
  high += padding;
  const ticks = niceTicks(low, high);
  low = Math.min(low, ticks[0]);
  high = Math.max(high, ticks[ticks.length - 1]);
  const x = (t) => M.left + ((t - firstYear) / (lastYear + 1 - firstYear)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - ((v - low) / (high - low)) * (H - M.top - M.bottom);
  const timeOf = (date) => {
    const [yy, mm, dd] = date.split("-").map(Number);
    return yy + ((mm - 1) * 30.4 + (dd - 1)) / 365;
  };

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "deals-chart", role: "img", "aria-label": "מחיר למ״ר לאורך זמן: נקודה לכל עסקה וקו של החציון השנתי" });
  for (const tick of ticks) {
    svg.append(
      svgEl("line", { x1: M.left, x2: W - M.right, y1: y(tick), y2: y(tick), class: "grid" }),
      svgEl("text", { x: M.left - 8, y: y(tick) + 4, "text-anchor": "end", class: "axis" }, shortShekels(tick))
    );
  }
  const yearStep = Math.ceil((lastYear - firstYear + 1) / 12);
  for (let year = firstYear; year <= lastYear; year += 1) {
    if ((year - firstYear) % yearStep) continue;
    svg.append(svgEl("text", { x: x(year + 0.5), y: H - 10, "text-anchor": "middle", class: "axis" }, String(year)));
  }
  // הרצועה והקו נשברים בשנה בלי עסקאות, כדי לא לצייר מגמה שלא נמדדה
  const segments = [];
  for (const row of years) {
    const segment = segments[segments.length - 1];
    if (segment && row.year === segment[segment.length - 1].year + 1) segment.push(row);
    else segments.push([row]);
  }
  for (const segment of segments) {
    if (segment.length > 1) {
      const top = segment.map((row) => `${x(row.year + 0.5)},${y(row.p75Ppsm)}`);
      const bottom = segment.slice().reverse().map((row) => `${x(row.year + 0.5)},${y(row.p25Ppsm)}`);
      svg.append(svgEl("polygon", { points: [...top, ...bottom].join(" "), class: "band" }));
    }
  }
  let outside = 0;
  const dots = svgEl("g", { class: "dots" });
  for (const point of stats.points) {
    if (point.ppsm < low || point.ppsm > high) { outside++; continue; }
    const t = timeOf(point.date);
    if (t < firstYear || t > lastYear + 1) continue;
    dots.append(svgEl("circle", { cx: x(t), cy: y(point.ppsm), r: 2.6 }));
  }
  svg.append(dots);
  for (const segment of segments) {
    if (segment.length > 1) {
      svg.append(svgEl("polyline", { points: segment.map((row) => `${x(row.year + 0.5)},${y(row.medianPpsm)}`).join(" "), class: "median-line" }));
    }
  }
  for (const row of years) {
    svg.append(svgEl("circle", { cx: x(row.year + 0.5), cy: y(row.medianPpsm), r: 4.5, class: "median-dot" }));
  }
  // סמן אנכי ותיבת מידע לשנה הקרובה לעכבר
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "crosshair", visibility: "hidden" });
  const hit = svgEl("rect", { x: M.left, y: M.top, width: W - M.left - M.right, height: H - M.top - M.bottom, class: "hit" });
  svg.append(cross, hit);
  hit.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const row = years.reduce((best, item) => (Math.abs(x(item.year + 0.5) - px) < Math.abs(x(best.year + 0.5) - px) ? item : best));
    cross.setAttribute("x1", x(row.year + 0.5));
    cross.setAttribute("x2", x(row.year + 0.5));
    cross.setAttribute("visibility", "visible");
    showDealsTip(event, [
      [`שנת ${row.year}`, "", false],
      ["חציון למ״ר", displayPrice(row.medianPpsm), true],
      ["50% האמצעיים", ltrText(`${displayPrice(row.p25Ppsm)} – ${displayPrice(row.p75Ppsm)}`)],
      ["מחיר חציוני", displayPrice(row.medianPrice)],
      ["עסקאות", row.count.toLocaleString("he-IL")],
    ]);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideDealsTip();
  });
  return { svg, outside };
}

// מחיר חציוני לפי שנה: עמודה לכל שנה, מאפס
function dealsPriceChart(stats, width) {
  const W = width, H = 220, M = { top: 14, right: 16, bottom: 30, left: 64 };
  const years = stats.byYear.filter((row) => Number.isFinite(row.medianPrice));
  const firstYear = years[0].year;
  const lastYear = years[years.length - 1].year;
  const span = lastYear - firstYear + 1;
  const ticks = niceTicks(0, Math.max(...years.map((row) => row.medianPrice)) * 1.08, 4);
  const high = ticks[ticks.length - 1];
  const slot = (W - M.left - M.right) / span;
  const barWidth = Math.max(6, Math.min(56, slot * 0.6));
  const y = (v) => H - M.bottom - (v / high) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "deals-chart", role: "img", "aria-label": "מחיר חציוני לפי שנה" });
  for (const tick of ticks) {
    svg.append(
      svgEl("line", { x1: M.left, x2: W - M.right, y1: y(tick), y2: y(tick), class: "grid" }),
      svgEl("text", { x: M.left - 8, y: y(tick) + 4, "text-anchor": "end", class: "axis" }, shortShekels(tick))
    );
  }
  const yearStep = Math.ceil(span / 12);
  for (const row of years) {
    const cx = M.left + (row.year - firstYear + 0.5) * slot;
    const top = y(row.medianPrice);
    const bottom = y(0);
    const r = Math.min(4, barWidth / 2, bottom - top);
    const left = cx - barWidth / 2;
    const right = cx + barWidth / 2;
    const bar = svgEl("path", {
      d: `M${left},${bottom} V${top + r} Q${left},${top} ${left + r},${top} H${right - r} Q${right},${top} ${right},${top + r} V${bottom} Z`,
      class: "bar",
      tabindex: 0,
      "aria-label": `${row.year}: ${displayPrice(row.medianPrice)}, ${row.count} עסקאות`,
    });
    const tip = (event) => showDealsTip(event, [
      [`שנת ${row.year}`, "", false],
      ["מחיר חציוני", displayPrice(row.medianPrice), true],
      ["שטח חציוני", Number.isFinite(row.medianSqm) ? `${row.medianSqm} מ״ר` : "—"],
      ["עסקאות", row.count.toLocaleString("he-IL")],
    ]);
    bar.addEventListener("pointermove", tip);
    bar.addEventListener("pointerleave", hideDealsTip);
    bar.addEventListener("focus", () => {
      const box = bar.getBoundingClientRect();
      tip({ clientX: box.left + box.width / 2, clientY: box.top });
    });
    bar.addEventListener("blur", hideDealsTip);
    svg.append(bar);
    if (!((row.year - firstYear) % yearStep)) {
      svg.append(svgEl("text", { x: cx, y: H - 10, "text-anchor": "middle", class: "axis" }, String(row.year)));
    }
  }
  return svg;
}

// ערך מיון לעמודה בטבלאות הסטטיסטיקה: לפי השדה שהעמודה מציגה (מספר אמיתי, לא הטקסט המעוצב),
// ואם אין שדה ידוע – מספר מתוך הטקסט, ואחרת הטקסט עצמו
const DEALS_SORT_FIELDS = [
  [/^עסקאות$/, (row) => row.count],
  [/^מחיר חציוני$/, (row) => row.medianPrice],
  [/^חציון למ״ר$/, (row) => row.medianPpsm],
  [/^50% האמצעיים/, (row) => row.p25Ppsm],
  [/^שטח/, (row) => row.medianSqm],
  [/^שינוי שנתי/, (row) => (row.change ? row.change.pct : null)],
  [/^עסקה אחרונה$/, (row) => row.lastDate || null],
  [/^שנה$/, (row) => row.year],
  [/^רבעון$/, (row) => row.key || row.label],
];

function dealsSortValue(column, row) {
  if (column.sort) return column.sort(row);
  const field = DEALS_SORT_FIELDS.find(([pattern]) => pattern.test(column.label));
  if (field) {
    const value = field[1](row);
    if (value !== undefined) return value;
  }
  const text = column.value(row);
  if (text === null || text === undefined || text === "") return null;
  const plain = String(text).replace(/[⁦-⁩‎‏]/g, "").replace(/−/g, "-");
  const number = plain.match(/^[^\d-]*(-?\d[\d,]*(?:\.\d+)?)/);
  return number ? Number(number[1].replace(/,/g, "")) : plain;
}

// טבלת סטטיסטיקה עם מיון: לחיצה על כותרת ממיינת לפי העמודה (שוב – הפוך). limit: כמה שורות להציג;
// המיון רץ על כל השורות ורק אז נחתכות, כך ש"הכי יקר" הוא הכי יקר מכולן ולא רק מהראשונות.
function dealsStatsTable(columns, rows, onRowClick, { limit = Infinity } = {}) {
  const table = document.createElement("table");
  table.className = "city-table deals-stats-table";
  const head = table.createTHead().insertRow();
  const body = table.createTBody();
  let sortIndex = -1;
  let direction = 1;
  const headers = [];

  const renderBody = () => {
    let list = rows;
    if (sortIndex >= 0) {
      const column = columns[sortIndex];
      list = [...rows].sort((a, b) => {
        const left = dealsSortValue(column, a);
        const right = dealsSortValue(column, b);
        const leftMissing = left === null || left === undefined || left === "" || Number.isNaN(left);
        const rightMissing = right === null || right === undefined || right === "" || Number.isNaN(right);
        if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
        const comparison = typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "he", { numeric: true });
        return comparison * direction;
      });
    }
    const shown = list.slice(0, limit);
    const fragment = document.createDocumentFragment();
    for (const row of shown) {
      const tr = document.createElement("tr");
      for (const column of columns) {
        const td = tr.insertCell();
        const value = column.value(row);
        td.textContent = value === null || value === undefined ? "—" : String(value);
        if (column.className) td.className = column.className;
        if (column.title) td.title = column.title(row);
      }
      if (onRowClick) {
        tr.tabIndex = 0;
        tr.addEventListener("click", () => onRowClick(row));
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter") onRowClick(row);
        });
      } else {
        tr.classList.add("static");
      }
      fragment.appendChild(tr);
    }
    body.replaceChildren(fragment);
    if (more) {
      more.hidden = rows.length <= limit;
      more.textContent = `מוצגות ${shown.length.toLocaleString("he-IL")} מתוך ${rows.length.toLocaleString("he-IL")} · המיון לפי כל השורות`;
    }
  };

  columns.forEach((column, index) => {
    const th = document.createElement("th");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sort-button deals-sort";
    button.textContent = column.label;
    button.title = "מיון לפי העמודה (לחיצה נוספת הופכת את הסדר)";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (sortIndex === index) direction = -direction;
      else {
        sortIndex = index;
        // עמודת שם (טקסט) – א׳ עד ת׳; מספרים – מהגדול לקטן
        direction = column.className === "city-name" && !/^(שנה|רבעון)$/.test(column.label) ? 1 : -1;
      }
      headers.forEach((other, otherIndex) => {
        other.setAttribute("aria-sort", otherIndex === sortIndex ? (direction > 0 ? "ascending" : "descending") : "none");
        other.firstChild.dataset.dir = otherIndex === sortIndex ? (direction > 0 ? "asc" : "desc") : "";
      });
      renderBody();
    });
    th.setAttribute("aria-sort", "none");
    th.appendChild(button);
    head.appendChild(th);
    headers.push(th);
  });

  // createCaption שם את הכיתוב במקום הנכון בטבלה; CSS מציג אותו מתחתיה
  const more = Number.isFinite(limit) ? table.createCaption() : null;
  if (more) more.className = "deals-table-more";
  renderBody();
  return table;
}

function renderDealsStats(list) {
  const host = $("dealsStats");
  const filters = readDealsFilters();
  // בלי מסננים: סקירה כללית של כל העסקאות (ערים, שכונות, פילוחים) – בלי גרף הנקודות הכבד
  const overview = !dealsFiltersActive(filters);
  if (!list.length) {
    host.hidden = true;
    host.replaceChildren();
    dealsStatsKey = "";
    return;
  }
  // "הצג עוד" ומיון לא משנים את הסטטיסטיקה – לא בונים מחדש
  const key = `${dealsVersion}|${JSON.stringify(filters)}|${list.length}`;
  if (key === dealsStatsKey && !host.hidden) return;
  dealsStatsKey = key;
  const stats = analyzeDealsCached(list);
  // הגרפים מצוירים ברוחב האמיתי (לא מתיחה של viewBox), כך שהטקסט נשאר בגודל קבוע
  host.hidden = false;
  // (רוחב הכרטיס פחות הריפוד; ההפרש הקטן כשמופיע פס גלילה נבלע ב-viewBox)
  const chartWidth = Math.max(320, host.clientWidth - 38);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const tile = (label, value, note) => {
    const card = el("div", "stat-tile");
    card.append(el("span", "stat-label", label), el("strong", "stat-value", value));
    if (note) card.append(el("span", "stat-note", note));
    return card;
  };
  const card = (title, note) => {
    const box = el("section", "dash-card");
    box.append(el("h3", "", title));
    if (note) box.append(el("p", "deals-card-note", note));
    return box;
  };
  const o = stats.overall;
  const parts = [];

  const tiles = el("div", "stat-row compact");
  tiles.append(
    tile("עסקאות", o.count.toLocaleString("he-IL"), stats.fromDate ? ltrText(`${dealDateText(stats.fromDate)} – ${dealDateText(stats.toDate)}`) : ""),
    tile("מחיר חציוני", displayPrice(o.medianPrice) || "—", Number.isFinite(o.medianSqm) ? `שטח חציוני ${o.medianSqm} מ״ר` : ""),
    tile("מחיר חציוני למ״ר", displayPrice(o.medianPpsm) || "—", Number.isFinite(o.p25Ppsm) ? `50% האמצעיים: ${ltrText(`${displayPrice(o.p25Ppsm)} – ${displayPrice(o.p75Ppsm)}`)}` : ""),
    tile(
      "שינוי במחיר למ״ר",
      stats.lastChange ? signedPct(stats.lastChange.pct) : "—",
      stats.lastChange
        ? `מ־${stats.lastChange.fromYear} ל־${stats.lastChange.toYear}` + (stats.annualChange ? ` · ממוצע ${signedPct(stats.annualChange.pct)} בשנה מאז ${stats.annualChange.fromYear}` : "")
        : "צריך לפחות 3 עסקאות בשנתיים שונות"
    ),
    tile(
      "עסקה אחרונה",
      stats.latest ? displayPrice(stats.latest.price) : "—",
      stats.latest
        ? `${dealDateText(stats.latest.date)} · ${stats.latest.street} ${stats.latest.house}` + (Number.isFinite(stats.latest.sqm) ? ` · ${stats.latest.sqm} מ״ר` : "")
        : ""
    ),
  );
  parts.push(tiles);

  if (overview) {
    parts.push(el("p", "deals-card-note", "סקירה של כל העסקאות שנאספו. חפשו עיר, רחוב או שכונה (או לחצו על שורה בטבלאות) כדי לראות גם גרף של כל העסקאות."));
  }
  const chartYears = stats.byYear.filter((row) => Number.isFinite(row.medianPpsm));
  // גרף הנקודות מצייר כל עסקה – עם עשרות אלפי עסקאות הוא מכביד, אז רק בחיפוש ממוקד
  if (!overview && chartYears.length && stats.points.length >= 2 && stats.points.length <= 6000) {
    const box = card("מחיר למ״ר לאורך זמן");
    const { svg, outside } = dealsPpsmChart(stats, chartWidth);
    const key = el("div", "split-legend deals-chart-key");
    const keyItem = (className, text) => {
      const item = el("span", "legend-item");
      item.append(el("i", `deals-key ${className}`), el("span", "", text));
      return item;
    };
    key.append(keyItem("dot", "עסקה"), keyItem("line", "חציון שנתי"), keyItem("band", "50% האמצעיים בכל שנה"));
    if (outside) key.append(el("span", "legend-item muted", `${outside.toLocaleString("he-IL")} עסקאות חריגות מחוץ לגרף`));
    box.append(svg, key);
    parts.push(box);
  }
  const priceYears = stats.byYear.filter((row) => Number.isFinite(row.medianPrice));
  if (priceYears.length >= 2) {
    const box = card("מחיר חציוני לפי שנה");
    box.append(dealsPriceChart(stats, chartWidth));
    parts.push(box);
  }

  // טבלה לפי שנה (גם כגרסה טקסטואלית של הגרפים)
  if (stats.byYear.length) {
    const box = card("לפי שנה");
    const rows = stats.byYear.slice().reverse();
    const previousOf = new Map(stats.byYear.map((row, index) => [row.year, stats.byYear[index - 1]]));
    box.append(dealsStatsTable([
      { label: "שנה", value: (row) => row.year, className: "city-name" },
      { label: "עסקאות", value: (row) => row.count.toLocaleString("he-IL") },
      { label: "מחיר חציוני", value: (row) => displayPrice(row.medianPrice) || null },
      { label: "חציון למ״ר", value: (row) => displayPrice(row.medianPpsm) || null },
      {
        label: "שינוי למ״ר",
        value: (row) => {
          const previous = previousOf.get(row.year);
          if (!previous || previous.year !== row.year - 1 || !previous.medianPpsm || !row.medianPpsm) return null;
          return signedPct(Math.round((row.medianPpsm / previous.medianPpsm - 1) * 1000) / 10);
        },
      },
      { label: "50% האמצעיים למ״ר", value: (row) => (Number.isFinite(row.p25Ppsm) ? ltrText(`${shortShekels(row.p25Ppsm)} – ${shortShekels(row.p75Ppsm)}`) : null) },
      { label: "שטח חציוני", value: (row) => (Number.isFinite(row.medianSqm) ? `${row.medianSqm} מ״ר` : null) },
    ], rows, (row) => {
      document.querySelector('[data-deals-min="year"]').value = row.year;
      document.querySelector('[data-deals-max="year"]').value = row.year;
      scheduleDealsRender();
    }));
    box.append(el("p", "deals-card-note", "לחיצה על שנה מסננת את העסקאות לשנה הזו."));
    parts.push(box);
  }

  // פילוחים ובניינים – לפי תקופה (שנה אחרונה / 2 / 3 / הכל)
  const periodSection = el("div", "deals-period-section");
  const periodBar = el("div", "deals-period-bar");
  const periodButtons = el("div", "timeline-filters");
  periodButtons.setAttribute("role", "group");
  periodButtons.setAttribute("aria-label", "תקופה לפילוחים");
  const periodBody = el("div", "deals-period-body");
  const periodNote = el("span", "deals-card-note");
  periodBar.append(el("span", "deals-period-label", "תקופה:"), periodButtons, periodNote);
  const periodLists = new Map(DEALS_PERIODS.map((period) => [period.years, dealsInPeriod(list, period.years)]));
  for (const period of DEALS_PERIODS) {
    const count = periodLists.get(period.years).length;
    const button = el("button", "", `${period.label} (${count.toLocaleString("he-IL")})`);
    button.type = "button";
    button.dataset.years = String(period.years);
    button.disabled = !count;
    button.addEventListener("click", () => {
      dealsPeriodYears = period.years;
      try { localStorage.setItem(DEALS_PERIOD_KEY, String(period.years)); } catch {}
      renderPeriod();
    });
    periodButtons.appendChild(button);
  }
  const renderPeriod = () => {
    let years = dealsPeriodYears;
    if (!periodLists.get(years) || !periodLists.get(years).length) years = 0;
    for (const button of periodButtons.children) button.setAttribute("aria-pressed", String(Number(button.dataset.years) === years));
    const periodList = periodLists.get(years);
    const periodStats = years ? analyzeDealsCached(periodList) : stats;
    periodNote.textContent = years
      ? `עסקאות מ־${dealDateText(dealsPeriodCutoff(years))} ואילך · ${periodList.length.toLocaleString("he-IL")} עסקאות`
      : "כל העסקאות בחיפוש";
    const sections = [];
    // פילוחים: חדרים, קומה, שנת בנייה
    const breakdownColumns = (label) => [
      { label, value: (row) => (/\d/.test(row.label) && !/[\u0590-\u05ff]/.test(row.label) ? ltrText(row.label) : row.label), className: "city-name" },
      { label: "עסקאות", value: (row) => row.count.toLocaleString("he-IL") },
      { label: "מחיר חציוני", value: (row) => (Number.isFinite(row.medianPrice) ? shortShekels(row.medianPrice) : null) },
      { label: "חציון למ״ר", value: (row) => (Number.isFinite(row.medianPpsm) ? shortShekels(row.medianPpsm) : null) },
      { label: "שטח", value: (row) => (Number.isFinite(row.medianSqm) ? row.medianSqm : null) },
    ];
    const grid = el("div", "dash-grid");
    for (const [title, rows, label] of [
      ["לפי מספר חדרים", periodStats.byRooms, "חדרים"],
      ["לפי קומה", periodStats.byFloor, "קומה"],
      ["לפי שנת בנייה", periodStats.byBuildYear, "נבנה"],
    ]) {
      if (!rows.length) continue;
      const box = card(title);
      box.append(dealsStatsTable(breakdownColumns(label), rows));
      grid.appendChild(box);
    }
    for (const [title, rows, label] of [
      ["לפי גודל דירה", periodStats.bySize, "שטח"],
      ["לפי סוג נכס", periodStats.byType, "סוג"],
    ]) {
      if (!rows.length || (rows.length === 1 && title === "לפי סוג נכס")) continue;
      const box = card(title);
      box.append(dealsStatsTable(breakdownColumns(label), rows));
      grid.appendChild(box);
    }
    if (grid.childElementCount) sections.push(grid);

    // ערים, שכונות ורחובות – עם שינוי שנתי בחציון למ״ר; לחיצה מסננת אליהם
    const changeColumn = {
      label: "שינוי שנתי למ״ר",
      value: (row) => (row.change ? signedPct(row.change.pct) : null),
      title: (row) => (row.change ? `חציון ${row.change.toYear} מול ${row.change.fromYear} (רק שנים עם 3+ עסקאות)` : "אין מספיק עסקאות בשתי שנים"),
    };
    const groupColumns = (label, nameOf) => [
      { label, value: nameOf, className: "city-name" },
      { label: "עסקאות", value: (row) => row.count.toLocaleString("he-IL") },
      { label: "חציון למ״ר", value: (row) => displayPrice(row.medianPpsm) || null },
      { label: "מחיר חציוני", value: (row) => (Number.isFinite(row.medianPrice) ? shortShekels(row.medianPrice) : null) },
      changeColumn,
      { label: "שטח", value: (row) => (Number.isFinite(row.medianSqm) ? row.medianSqm : null) },
      { label: "עסקה אחרונה", value: (row) => (row.lastDate ? dealDateText(row.lastDate) : null) },
    ];
    const filterTo = (city, query, neighborhood = "") => {
      $("dealsCity").value = [...$("dealsCity").options].some((option) => option.value === city) ? city : "";
      $("dealsQuery").value = query;
      setDealsHood(neighborhood);
      scheduleDealsRender();
    };
    if (periodStats.byCity.length > 1) {
      const box = card("לפי עיר", "לחיצה על עיר מציגה רק את העסקאות שלה.");
      box.append(dealsStatsTable(groupColumns("עיר", (row) => row.city), periodStats.byCity, (row) => filterTo(row.city, ""), { limit: 20 }));
      sections.push(box);
    }
    if (periodStats.byNeighborhood.length) {
      const multiCity = periodStats.byCity.length > 1;
      const missing = periodStats.overall.count - periodStats.withNeighborhood;
      const box = card(
        multiCity ? "לפי שכונה בכל עיר" : "לפי שכונה",
        "לחיצה על שכונה מציגה רק את העסקאות שלה." +
          (missing > 0 ? ` ${missing.toLocaleString("he-IL")} עסקאות בלי שכונה (בעיקר ממדלן, שלא מציינת שכונה) לא נכללות כאן.` : "")
      );
      const rows = multiCity
        ? [...periodStats.byNeighborhood].sort((a, b) => a.city.localeCompare(b.city, "he") || b.count - a.count)
        : periodStats.byNeighborhood;
      box.append(dealsStatsTable(
        groupColumns("שכונה", (row) => (multiCity ? `${row.neighborhood} · ${row.city}` : row.neighborhood)),
        rows,
        (row) => filterTo(row.city, "", row.neighborhood),
        { limit: multiCity ? 40 : 25 }
      ));
      sections.push(box);
    }
    if (periodStats.byStreet.length > 1) {
      const box = card("הרחובות עם הכי הרבה עסקאות", "לחיצה על רחוב מציגה רק את העסקאות שלו.");
      box.append(dealsStatsTable(
        groupColumns("רחוב", (row) => (periodStats.byCity.length > 1 ? `${row.street}, ${row.city}` : row.street)),
        periodStats.byStreet,
        (row) => filterTo(row.city, row.street),
        { limit: 15 }
      ));
      sections.push(box);
    }
    if (periodStats.byQuarter.length >= 2) {
      const box = card("לפי רבעון", "מגמה טרייה יותר משנתית. רבעון עם מעט עסקאות פחות מייצג.");
      const quarterRows = periodStats.byQuarter.slice().reverse();
      box.append(dealsStatsTable([
        { label: "רבעון", value: (row) => row.label, className: "city-name" },
        { label: "עסקאות", value: (row) => row.count.toLocaleString("he-IL") },
        { label: "חציון למ״ר", value: (row) => displayPrice(row.medianPpsm) || null },
        { label: "מחיר חציוני", value: (row) => (Number.isFinite(row.medianPrice) ? shortShekels(row.medianPrice) : null) },
        { label: "שטח", value: (row) => (Number.isFinite(row.medianSqm) ? row.medianSqm : null) },
      ], quarterRows));
      sections.push(box);
    }

    // בניינים: רק כשהחיפוש כולל יותר מבניין אחד
    if (periodStats.byBuilding.length > 1) {
      const box = card(
        periodStats.streetCount > 1 ? "הבניינים עם הכי הרבה עסקאות" : "לפי בניין ברחוב",
        "לחיצה על בניין מציגה רק את העסקאות שלו."
      );
      box.append(dealsStatsTable([
        { label: "כתובת", value: (row) => `${row.street} ${row.house}${periodStats.streetCount > 1 ? `, ${row.city}` : ""}`, className: "city-name" },
        { label: "עסקאות", value: (row) => row.count.toLocaleString("he-IL") },
        { label: "חציון למ״ר", value: (row) => displayPrice(row.medianPpsm) || null },
        { label: "מחיר חציוני", value: (row) => displayPrice(row.medianPrice) || null },
        { label: "עסקה אחרונה", value: (row) => (row.lastDate ? `${dealDateText(row.lastDate)} · ${shortShekels(row.lastPrice)}` : null) },
      ], periodStats.byBuilding, (row) => {
        $("dealsQuery").value = `${row.street} ${row.house}`;
        $("dealsCity").value = [...$("dealsCity").options].some((option) => option.value === row.city) ? row.city : "";
        setDealsHood("");
        scheduleDealsRender();
      }, { limit: 12 }));
      sections.push(box);
    }

    if (!sections.length) sections.push(el("p", "deals-card-note", "אין מספיק נתונים לפילוח בתקופה הזו."));
    periodBody.replaceChildren(...sections);
  };
  renderPeriod();
  periodSection.append(periodBar, periodBody);
  parts.push(periodSection);

  host.replaceChildren(...parts);
  host.hidden = false;
}

window.addEventListener("resize", debounce(() => {
  if (activeTab !== "deals" || $("dealsStats").hidden) return;
  dealsStatsKey = "";
  renderDeals();
}, 250));

const scheduleDealsRender = debounce(() => {
  dealsLimit = DEALS_PAGE_SIZE;
  renderDeals();
}, 200);

const scheduleDealsReload = debounce(async () => {
  await loadDeals();
  applyCacheToViews();
  renderDeals();
}, 1500);

async function loadCache() {
  $("refreshButton").disabled = true;
  try {
    const [storedCache] = await Promise.all([storageGet(), loadDeals()]);
    cache = await migrateEstimatedBaselineDates(storedCache);
    applyCacheToViews();
  } catch (error) {
    console.error("[lightrail-ext] failed to load cached records", error);
    $("recordCount").textContent = error.message || "טעינת המטמון נכשלה";
    $("recordCount").dataset.error = "true";
  } finally {
    $("refreshButton").disabled = false;
  }
}

async function exportCache(format) {
  const buttons = ["exportTxt", "exportCsv", "exportExcel", "exportFullCsv"].map($);
  const status = $("exportStatus");
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  status.dataset.error = "false";
  status.textContent = "מכין את המידע לייצוא…";
  const formatName = format === "excel" ? "Excel" : format === "full" ? "CSV מלא" : format.toUpperCase();
  try {
    const stored = await storageGet();
    const progress = (complete, total) => {
      status.textContent = total
        ? `מכין ${formatName}… ${complete.toLocaleString("he-IL")} / ${total.toLocaleString("he-IL")}`
        : `מכין קובץ ${formatName}…`;
    };
    if (format === "excel") {
      const deals = await LRDeals.loadAll(chrome.storage.local);
      LRCacheExport.downloadExcel(await LRCacheExport.buildExcel(stored, progress, Date.now(), deals));
    } else if (format === "csv") {
      LRCacheExport.downloadCsv(await LRCacheExport.buildCsv(stored, progress));
    } else if (format === "full") {
      const [deals, settings] = await Promise.all([LRDeals.loadAll(chrome.storage.local), storageGetAll("sync")]);
      LRCacheExport.downloadCsv(
        await LRCacheExport.buildFullCsv({ cache: stored, deals, settings }, progress),
        new Date(),
        "lightrail-full"
      );
    } else {
      LRCacheExport.downloadTxt(await LRCacheExport.buildTxt(stored, progress));
    }
    status.textContent = `הייצוא הושלם · ${Object.keys(stored).length.toLocaleString("he-IL")} רשומות`;
  } catch (error) {
    console.error(`[lightrail-ext] failed to export cache as ${formatName}`, error);
    status.dataset.error = "true";
    status.textContent = `ייצוא ${formatName} נכשל: ${error.message || "שגיאה לא ידועה"}`;
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}

// ייצוא של מה שמוצג כרגע לפי המסננים (ולא של כל המאגר)
async function exportCurrentCsv(buttonId, build, prefix) {
  const button = $(buttonId);
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const csv = await build((done, total) => {
      button.textContent = total ? `מכין… ${done.toLocaleString("he-IL")} / ${total.toLocaleString("he-IL")}` : "מכין…";
    });
    if (csv) LRCacheExport.downloadCsv(csv, new Date(), prefix);
  } catch (error) {
    console.error("[lightrail-ext] CSV export failed", error);
    alert(`הייצוא נכשל: ${error.message || "שגיאה לא ידועה"}`);
  } finally {
    button.textContent = label;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function exportSearchResultsCsv() {
  if (searchWaiting || !visibleRecords.length) {
    alert(searchWaiting ? "בחרו מסנן או הקלידו חיפוש כדי שיהיו תוצאות לייצא." : "אין תוצאות לייצוא.");
    return;
  }
  const subset = Object.fromEntries(visibleRecords);
  exportCurrentCsv("exportSearchCsv", (progress) => LRCacheExport.buildCsv(subset, progress), "listing-search");
}

function exportDealsResultsCsv() {
  const list = LRDeals.sortDeals(LRDeals.filterDeals(dealsStore, readDealsFilters()), dealsSortOrder());
  if (!list.length) {
    alert("אין עסקאות לייצוא לפי המסננים הנוכחיים.");
    return;
  }
  exportCurrentCsv("exportDealsCsv", (progress) => LRCacheExport.buildDealsCsv(list, progress), "real-deals");
}

function downloadBackup(backup) {
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lightrail-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const SYNC_LOCAL_KEYS = [LRSync.SETTINGS_KEY, LRSync.HASHES_KEY, LRSync.TOMBSTONES_KEY];

async function exportFullBackup() {
  const button = $("exportBackup");
  const status = $("exportStatus");
  button.disabled = true;
  status.dataset.error = "false";
  status.textContent = "מכין גיבוי מלא…";
  try {
    const [local, sync] = await Promise.all([
      storageGetAll("local"),
      storageGetAll("sync"),
    ]);
    // בקובץ הגיבוי המטמון נשמר כמפתח אחד (כמו תמיד), לא בחלקים
    const listingCache = LRListingStore.fold(local);
    LRListingStore.stripCacheKeys(local);
    local[CACHE_KEY] = listingCache;
    // פרטי החיבור לסנכרון (אסימון כניסה) ומצב הסנכרון לא נכנסים לקובץ גיבוי
    for (const key of SYNC_LOCAL_KEYS) delete local[key];
    const runtime = local[REFRESH_RUNTIME_KEY] || {};
    local[REFRESH_RUNTIME_KEY] = {
      managerTabId: null,
      running: false,
      scheduled: false,
      ...(Number.isFinite(runtime.lastFinishedAt) ? { lastFinishedAt: runtime.lastFinishedAt } : {}),
      ...(runtime.lastResult ? { lastResult: runtime.lastResult } : {}),
    };
    downloadBackup({
      format: "lightrail-extension-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      local,
      sync,
    });
    status.textContent = `הגיבוי המלא מוכן · ${Object.keys(local[CACHE_KEY]).length.toLocaleString("he-IL")} רשומות`;
  } catch (error) {
    console.error("[lightrail-ext] failed to export full backup", error);
    status.dataset.error = "true";
    status.textContent = `ייצוא הגיבוי נכשל: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function validateBackup(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.format !== "lightrail-extension-backup" ||
    value.version !== 1 ||
    !value.local ||
    typeof value.local !== "object" ||
    Array.isArray(value.local) ||
    !value.sync ||
    typeof value.sync !== "object" ||
    Array.isArray(value.sync)
  ) {
    throw new Error("הקובץ אינו גיבוי תקין של התוסף או שגרסתו אינה נתמכת.");
  }
  const importedCache = value.local[CACHE_KEY];
  if (!importedCache || typeof importedCache !== "object" || Array.isArray(importedCache)) {
    throw new Error("הגיבוי אינו מכיל מטמון מודעות תקין.");
  }
  for (const [key, record] of Object.entries(importedCache)) {
    if (!key || !record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("נמצאה רשומת מודעה לא תקינה בגיבוי.");
    }
  }
}

async function importFullBackup(file) {
  const button = $("importBackup");
  const status = $("exportStatus");
  const mode = $("backupImportMode").value;
  status.dataset.error = "false";
  status.textContent = "בודק את קובץ הגיבוי…";
  button.disabled = true;
  try {
    if (writing || dirtyFields.size || refreshQueue.length) {
      throw new Error("לפני ייבוא, יש לסיים רענון ולשמור או לבטל שינויים פתוחים.");
    }
    const backup = JSON.parse(await file.text());
    validateBackup(backup);
    const importedCount = Object.keys(backup.local[CACHE_KEY]).length;
    if (mode === "replace") {
      const confirmed = window.confirm(
        "החלפת כל המידע תמחק מהמחשב הזה את המטמון, יתר הנתונים המקומיים וההעדפות הנוכחיות, ותשחזר את הגיבוי. להמשיך?"
      );
      if (!confirmed) {
        status.textContent = "הייבוא בוטל.";
        return;
      }
    }

    const [currentLocal, currentSync] = await Promise.all([
      storageGetAll("local"),
      storageGetAll("sync"),
    ]);
    const currentRuntime = currentLocal[REFRESH_RUNTIME_KEY];
    if (currentRuntime && currentRuntime.running === true) {
      throw new Error("מתבצע כרגע רענון בכרטיסייה אחרת. יש לעצור אותו לפני ייבוא.");
    }
    const currentCache = LRListingStore.fold(currentLocal);
    const importedLocal = { ...backup.local };
    const importedCache = importedLocal[CACHE_KEY];
    LRListingStore.stripCacheKeys(importedLocal);
    const mergedLocal = mode === "replace"
      ? { ...importedLocal }
      : { ...LRListingStore.stripCacheKeys({ ...currentLocal }), ...importedLocal };
    // ייבוא לא מחליף ולא מוחק את חיבור הסנכרון של המחשב הזה
    for (const key of SYNC_LOCAL_KEYS) {
      if (key in currentLocal) mergedLocal[key] = currentLocal[key];
      else delete mergedLocal[key];
    }
    const mergedSync = mode === "replace"
      ? { ...backup.sync }
      : { ...currentSync, ...backup.sync };
    const finalCache = mode === "merge" ? { ...currentCache, ...importedCache } : importedCache;
    // המטמון נכתב בחלקים (כל 32 החלקים, כך שרשומות שלא בגיבוי נמחקות במצב החלפה)
    Object.assign(mergedLocal, LRListingStore.split(finalCache));
    const importedRuntime = backup.local[REFRESH_RUNTIME_KEY] || {};
    mergedLocal[REFRESH_RUNTIME_KEY] = {
      managerTabId: null,
      running: false,
      scheduled: false,
      ...(Number.isFinite(importedRuntime.lastFinishedAt)
        ? { lastFinishedAt: importedRuntime.lastFinishedAt }
        : {}),
      ...(importedRuntime.lastResult ? { lastResult: importedRuntime.lastResult } : {}),
    };

    await storageSetArea("local", mergedLocal);
    try {
      await storageSetArea("sync", mergedSync);
    } catch (error) {
      try {
        await restoreStorageArea("local", currentLocal, mergedLocal);
        await restoreStorageArea("sync", currentSync, mergedSync);
      } catch (rollbackError) {
        throw new Error(
          `שמירת ההעדפות נכשלה (${error.message}), וגם שחזור נתוני הגיבוי הקודמים נכשל (${rollbackError.message}).`
        );
      }
      throw error;
    }
    if (mode === "replace") {
      try {
        await storageRemove("local", Object.keys(currentLocal).filter((key) => !(key in mergedLocal)));
        await storageRemove("sync", Object.keys(currentSync).filter((key) => !(key in mergedSync)));
      } catch (error) {
        try {
          await restoreStorageArea("local", currentLocal, mergedLocal);
          await restoreStorageArea("sync", currentSync, mergedSync);
        } catch (rollbackError) {
          throw new Error(
            `ניקוי הנתונים הקודמים נכשל (${error.message}), וגם שחזור המידע הקודם נכשל (${rollbackError.message}).`
          );
        }
        throw error;
      }
    }
    cache = finalCache;
    renderRows();
    renderListingDeletionPreview();
    const scheduleResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "lightrail:refresh-schedule-updated" },
        (result) => resolve({
          result,
          error: chrome.runtime.lastError,
        })
      );
    });
    if (scheduleResult.error || !scheduleResult.result || !scheduleResult.result.ok) {
      throw new Error(
        `המידע יובא, אך עדכון תזמון הרענון נכשל: ${
          scheduleResult.error && scheduleResult.error.message ||
          scheduleResult.result && scheduleResult.result.error ||
          "שגיאה לא ידועה"
        }`
      );
    }
    await loadRefreshSchedule();
    status.textContent = `הייבוא הושלם · ${importedCount.toLocaleString("he-IL")} רשומות מהגיבוי`;
  } catch (error) {
    console.error("[lightrail-ext] failed to import full backup", error);
    status.dataset.error = "true";
    status.textContent = `ייבוא הגיבוי נכשל: ${error.message || "שגיאה לא ידועה"}`;
  } finally {
    button.disabled = false;
    $("backupFile").value = "";
  }
}

rows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-key]");
  if (!row) return;
  if (event.target.closest("a[data-record-link]")) return;
  const historyToggle = event.target.closest("button[data-history-toggle]");
  if (historyToggle) {
    event.stopPropagation();
    const key = historyToggle.dataset.historyToggle;
    if (expandedPriceHistory.has(key)) expandedPriceHistory.delete(key);
    else expandedPriceHistory.add(key);
    renderRows();
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button && button.dataset.action === "delete") {
    event.stopPropagation();
    deleteRecord(row.dataset.key);
  } else if (button && button.dataset.action === "deals") {
    event.stopPropagation();
    openDealsForRecord(cache[row.dataset.key]);
  } else if (button && button.dataset.action === "copy") {
    event.stopPropagation();
    copyListingText(row.dataset.key, button);
  } else {
    openRecord(row.dataset.key);
  }
});
rows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target.closest("button")) return;
  const row = event.target.closest("tr[data-key]");
  if (!row) return;
  event.preventDefault();
  openRecord(row.dataset.key);
});
for (const id of ["searchInput", "siteFilter", "typeFilter"]) {
  $(id).addEventListener("input", scheduleRenderRows);
  $(id).addEventListener("change", renderRows);
}
document.querySelectorAll("[data-multi-select]").forEach((details) => {
  details.addEventListener("change", () => updateMultiSelectSummary(details));
});
// סגירת רשימת הבחירה המרובה בלחיצה מחוץ לה או ב־Escape
document.addEventListener("click", (event) => {
  document.querySelectorAll("[data-multi-select][open]").forEach((details) => {
    if (!details.contains(event.target)) details.open = false;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll("[data-multi-select][open]").forEach((details) => {
    details.open = false;
    details.querySelector("summary").focus();
  });
});
for (const id of ["listingSearchQuery", "listingSearchCity", "listingSearchSite", "listingSearchType", "listingSearchStatus"]) {
  $(id).addEventListener("input", scheduleRenderRows);
  $(id).addEventListener("change", renderRows);
}
document.querySelectorAll("[data-range-min], [data-range-max]").forEach((input) => {
  input.addEventListener("input", scheduleRenderRows);
});
document.querySelectorAll("[data-search-range-min], [data-search-range-max], [data-search-date-min], [data-search-date-max]").forEach((input) => {
  input.addEventListener("input", scheduleRenderRows);
  input.addEventListener("change", renderRows);
});
document.querySelectorAll("[data-search-boolean]").forEach((input) => {
  input.addEventListener("change", renderRows);
});
$("searchAmenityFilters").addEventListener("change", renderRows);
$("clearAdvancedFilters").addEventListener("click", () => {
  document.querySelectorAll("[data-range-min], [data-range-max]").forEach((input) => {
    input.value = "";
  });
  renderRows();
});
$("clearSearchPreset").addEventListener("click", () => {
  searchPreset = null;
  renderRows();
});
$("clearListingSearch").addEventListener("click", () => {
  searchPreset = null;
  recordSorts = []; // גם המיונים חוזרים לברירת המחדל
  $("listingSearchQuery").value = "";
  $("listingSearchSite").value = "";
  setMultiSelectValues("listingSearchCity", []);
  $("listingSearchType").value = "";
  setMultiSelectValues("listingSearchStatus", []);
  document.querySelectorAll("[data-search-range-min], [data-search-range-max], [data-search-date-min], [data-search-date-max]").forEach((input) => {
    input.value = "";
  });
  document.querySelectorAll("[data-search-boolean], [data-search-amenity]").forEach((input) => {
    input.value = "";
  });
  renderRows();
});
$("listingDeletePanel").addEventListener("input", scheduleDeletionPreview);
$("listingDeletePanel").addEventListener("change", renderListingDeletionPreview);
$("clearListingDeleteFilters").addEventListener("click", () => {
  $("deleteListingQuery").value = "";
  $("deleteListingSite").value = "";
  setMultiSelectValues("deleteListingStatus", []);
  document.querySelectorAll("[data-delete-range-min], [data-delete-range-max], [data-delete-boolean], [data-delete-amenity]").forEach((input) => {
    input.value = "";
  });
  renderListingDeletionPreview();
});
$("deleteMatchingListings").addEventListener("click", deleteMatchingListings);
$("decreaseFont").addEventListener("click", () => changeFontScale(-FONT_SCALE_STEP));
$("increaseFont").addEventListener("click", () => changeFontScale(FONT_SCALE_STEP));
$("resetFont").addEventListener("click", () => changeFontScale(1 - fontScale));
$("togglePriceHistory").addEventListener("click", (event) => {
  showFullPriceHistory = !showFullPriceHistory;
  expandedPriceHistory.clear();
  const button = event.currentTarget;
  button.textContent = showFullPriceHistory ? "הצג עד 3 בכל שורה" : "הצג היסטוריה מלאה";
  button.setAttribute("aria-pressed", String(showFullPriceHistory));
  renderRows();
});
$("listingsTab").addEventListener("click", () => setActiveTab("listings"));
$("listingSearchTab").addEventListener("click", () => setActiveTab("search"));
$("listingDeleteTab").addEventListener("click", () => setActiveTab("delete"));
$("priceChangesTab").addEventListener("click", () => setActiveTab("priceChanges"));
$("dealsTab").addEventListener("click", () => setActiveTab("deals"));
$("dealsTab").addEventListener("keydown", handleTabKeydown);
$("dealsQuery").addEventListener("input", scheduleDealsRender);
for (const id of ["dealsCity", "dealsSource"]) $(id).addEventListener("change", scheduleDealsRender);
$("dealsHood").addEventListener("change", () => {
  // שכונה מרשימת "כל הערים" בוחרת גם את העיר שלה (אותו שם שכונה יכול להיות בכמה ערים)
  const option = $("dealsHood").selectedOptions[0];
  if (option && option.value && option.dataset.city && !$("dealsCity").value) setDealsHood(option.value, option.dataset.city);
  scheduleDealsRender();
});
document.querySelectorAll("[data-deals-min], [data-deals-max]").forEach((input) => {
  input.addEventListener("input", scheduleDealsRender);
});
document.querySelectorAll("[data-deals-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    toggleDealsSort(button.dataset.dealsSort);
    renderDeals();
  });
});
$("dealsSortAdd").addEventListener("change", (event) => {
  const key = event.target.value;
  if (!key || dealsSort.some((sort) => sort.key === key) || dealsSort.length >= DEALS_SORT_MAX) return;
  dealsSort = [...dealsSort, { key, direction: key === "address" ? 1 : -1 }];
  renderDeals();
});
$("clearDealsSearch").addEventListener("click", () => {
  $("dealsQuery").value = "";
  $("dealsCity").value = "";
  $("dealsHood").value = "";
  $("dealsSource").value = "";
  document.querySelectorAll("[data-deals-min], [data-deals-max]").forEach((input) => { input.value = ""; });
  dealsSort = []; // גם המיונים חוזרים לברירת המחדל
  scheduleDealsRender();
});
$("dealsMore").lastChild.addEventListener("click", () => {
  dealsLimit += DEALS_PAGE_SIZE;
  renderDeals();
});
$("refreshTab").addEventListener("click", () => setActiveTab("refresh"));
$("transferTab").addEventListener("click", () => setActiveTab("transfer"));
$("dashboardTab").addEventListener("click", () => setActiveTab("dashboard"));
$("dashboardTab").addEventListener("keydown", handleTabKeydown);
$("listingsTab").addEventListener("keydown", handleTabKeydown);
$("listingSearchTab").addEventListener("keydown", handleTabKeydown);
$("listingDeleteTab").addEventListener("keydown", handleTabKeydown);
$("priceChangesTab").addEventListener("keydown", handleTabKeydown);
$("refreshTab").addEventListener("keydown", handleTabKeydown);
$("transferTab").addEventListener("keydown", handleTabKeydown);
$("syncTab").addEventListener("click", () => setActiveTab("sync"));
$("syncTab").addEventListener("keydown", handleTabKeydown);
$("addressExportTab").addEventListener("click", () => setActiveTab("addressExport"));
$("addressExportTab").addEventListener("keydown", handleTabKeydown);

// ---------- ייצוא לפי כתובות ----------
function addressExportLines() {
  return $("addressExportInput").value.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
}

// תצוגה מקדימה: כמה נמצא בכל כתובת (בלי לבנות קובץ) – 6 שניות אחרי שמפסיקים להקליד, או בכפתור "בדיקה"
const ADDRESS_PREVIEW_DELAY_MS = 6000;
let addressPreviewTimer = null;
function scheduleAddressPreview() {
  clearTimeout(addressPreviewTimer);
  const status = $("addressExportStatus");
  status.dataset.error = "false";
  status.textContent = addressExportLines().length ? "הבדיקה תתחיל כמה שניות אחרי שתסיים להקליד (או לחץ „בדיקה”)." : "";
  addressPreviewTimer = setTimeout(() => runAddressExport(false).catch(() => {}), ADDRESS_PREVIEW_DELAY_MS);
}

// עסקאות נטענות פעם אחת ונשמרות עד שהן משתנות
let addressDealsMemo = { version: -1, deals: null };
async function addressExportDeals() {
  if (addressDealsMemo.version !== dealsVersion || !addressDealsMemo.deals) {
    addressDealsMemo = { version: dealsVersion, deals: await LRDeals.loadAll(chrome.storage.local) };
  }
  return addressDealsMemo.deals;
}

async function runAddressExport(download) {
  const status = $("addressExportStatus");
  const button = $("addressExportRun");
  const lines = addressExportLines();
  const summary = $("addressExportSummary");
  if (!lines.length) {
    summary.replaceChildren();
    status.textContent = download ? "יש להקליד לפחות כתובת אחת." : "";
    status.dataset.error = String(download);
    return;
  }
  clearTimeout(addressPreviewTimer);
  button.disabled = true;
  $("addressExportCheck").disabled = true;
  status.dataset.error = "false";
  status.textContent = download ? "אוסף מודעות, שינויי מחיר ועסקאות…" : "בודק…";
  try {
    const deals = await addressExportDeals();
    const result = await LRCacheExport.buildAddressCsv({ cache, deals, addresses: lines, countOnly: !download }, (done, total) => {
      if (download && total) status.textContent = `בונה את הקובץ… ${Math.round((done / total) * 100)}%`;
    });
    const unparsed = lines.length - result.queries.length;
    const n = (value) => value.toLocaleString("he-IL");
    summary.replaceChildren(...result.counts.map((item) => {
      const found = item.listings || item.deals;
      const row = el("li", found ? "" : "empty");
      row.append(
        el("strong", "", item.label),
        el("span", "", ` – ${n(item.listings)} מודעות · ${n(item.deals)} עסקאות`)
      );
      // לא נמצא כלום: מראים אילו רחובות דומים כן יש, ובאילו מספרי בתים
      const similar = (item.similar || []).filter((entry) => entry.listings || entry.deals);
      if (!found && similar.length) {
        const list = el("ul", "address-similar");
        for (const entry of similar) {
          list.append(el("li", "", `${entry.street}, ${entry.city}: ${n(entry.listings)} מודעות, ${n(entry.deals)} עסקאות` +
            (entry.houses.length ? ` · בתים: ${entry.houses.join(", ")}` : "")));
        }
        row.append(el("div", "address-similar-title", "רחובות דומים שקיימים במידע:"), list);
      } else if (!found) {
        row.append(el("div", "address-similar-title", "אין במידע רחוב עם השם הזה בעיר הזו."));
      }
      return row;
    }));
    const { listings, changes, deals: dealCount } = result.totals;
    const found = `נמצאו ${listings.toLocaleString("he-IL")} מודעות, ${changes.toLocaleString("he-IL")} שינויי מחיר ו-${dealCount.toLocaleString("he-IL")} עסקאות אמת` +
      (unparsed ? ` (${unparsed} שורות לא זוהו ככתובת)` : "");
    if (!download) {
      status.dataset.error = "false";
      status.textContent = found;
      return;
    }
    if (!listings && !dealCount) {
      status.dataset.error = "true";
      status.textContent = "לא נמצא מידע בכתובות האלה. בדקו את שם הרחוב (כמו שהוא מופיע במודעות) ואת העיר.";
      return;
    }
    LRCacheExport.downloadCsv(result.csv, new Date(), "addresses");
    status.textContent = `${found}. הקובץ ירד.`;
  } catch (error) {
    console.error("[lightrail-ext] address export failed", error);
    status.dataset.error = "true";
    status.textContent = error.message || "הייצוא נכשל.";
  } finally {
    button.disabled = false;
    $("addressExportCheck").disabled = false;
  }
}

$("addressExportInput").addEventListener("input", scheduleAddressPreview);
$("addressExportCheck").addEventListener("click", () => runAddressExport(false));
$("addressExportRun").addEventListener("click", () => runAddressExport(true));
for (const button of document.querySelectorAll("[data-settings]")) {
  button.addEventListener("click", () => setActiveTab(`settings-${button.dataset.settings}`));
  button.addEventListener("keydown", handleTabKeydown);
}
window.addEventListener("hashchange", () => {
  const view = viewFromHash();
  if (view && view !== activeTab) setActiveTab(view);
});
document.querySelectorAll("[data-price-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    priceTimelineFilter = button.dataset.priceFilter;
    renderPriceTimeline();
  });
});
document.querySelectorAll("[data-timeline-min], [data-timeline-max]").forEach((input) => {
  input.addEventListener("input", scheduleTimeline);
});
for (const input of document.querySelectorAll("#timelineBrokerage, [data-timeline-amenity]")) {
  input.addEventListener("change", renderPriceTimeline);
}
$("timelinePreferences").addEventListener("click", () => {
  timelinePreferencesEnabled = !timelinePreferencesEnabled;
  renderPriceTimeline();
});
$("clearTimelineFilters").addEventListener("click", () => {
  document.querySelectorAll("[data-timeline-min], [data-timeline-max]").forEach((input) => {
    input.value = "";
  });
  $("timelineBrokerage").value = "";
  document.querySelectorAll("[data-timeline-amenity]").forEach((input) => {
    input.value = "";
  });
  timelinePreferencesEnabled = false;
  renderPriceTimeline();
});
$("exportTxt").addEventListener("click", () => exportCache("txt"));
$("exportCsv").addEventListener("click", () => exportCache("csv"));
$("exportFullCsv").addEventListener("click", () => exportCache("full"));
$("exportSearchCsv").addEventListener("click", exportSearchResultsCsv);
$("exportDealsCsv").addEventListener("click", exportDealsResultsCsv);
$("exportExcel").addEventListener("click", () => exportCache("excel"));
$("clearPriceHistory").addEventListener("click", clearPriceHistories);
$("sortSelect").addEventListener("change", () => {
  if (!$("sortSelect").value) return;
  sort.key = $("sortSelect").value;
  sort.direction = ["updatedAt", "dealScore", "listingAgeDays", "sellerPressure"].includes(sort.key) ? -1 : 1;
  recordSorts = [];
  renderRows();
});
form.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (field && !event.target.readOnly) dirtyFields.add(field);
  if (event.target.matches("select[data-amenity]")) dirtyFields.add("amenities");
  $("saveButton").disabled = dirtyFields.size === 0;
});
form.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  if (field && !event.target.readOnly) dirtyFields.add(field);
  if (event.target.matches("select[data-amenity]")) dirtyFields.add("amenities");
  $("saveButton").disabled = dirtyFields.size === 0;
});
form.addEventListener("submit", saveRecord);
$("refreshButton").addEventListener("click", loadCache);
$("closeDetails").addEventListener("click", closeDetails);
$("detailsBackdrop").addEventListener("click", closeDetails);
$("deleteRecord").addEventListener("click", () => {
  if (selectedKey) deleteRecord(selectedKey);
});
$("startRefresh").addEventListener("click", startRefresh);
// בחירת האתר נזכרת בדפדפן הזה (נוחות בלבד; התזמון שומר את הבחירה שלו בנפרד)
try {
  $("refreshSite").value = normalizeRefreshSite(localStorage.getItem("lightrailRefreshSite"));
} catch {}
$("refreshSite").addEventListener("change", () => {
  try {
    localStorage.setItem("lightrailRefreshSite", normalizeRefreshSite($("refreshSite").value));
  } catch {}
});
$("pauseRefresh").addEventListener("click", toggleRefreshPause);
$("stopRefresh").addEventListener("click", () => stopRefresh());
$("refreshDelay").addEventListener("change", async () => {
  const value = Math.max(
    MIN_REFRESH_DELAY_SEC,
    Math.min(MAX_REFRESH_DELAY_SEC, Math.round(Number($("refreshDelay").value) || 30))
  );
  $("refreshDelay").value = String(value);
  refreshDelaySec = value;
  try {
    await storageSet({ [REFRESH_DELAY_KEY]: value });
    setRefreshStatus(`זמן ההמתנה נשמר: ${value} שניות אחרי טעינת כל דף.`);
  } catch (error) {
    console.error("[lightrail-ext] failed to save refresh delay", error);
    setRefreshStatus(error.message || "שמירת זמן ההמתנה נכשלה.", true);
  }
});
$("saveRefreshSchedule").addEventListener("click", saveRefreshSchedule);
$("exportBackup").addEventListener("click", exportFullBackup);
$("importBackup").addEventListener("click", () => $("backupFile").click());
$("backupFile").addEventListener("change", (event) => {
  const file = event.currentTarget.files && event.currentTarget.files[0];
  if (file) importFullBackup(file);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("detailsPanel").hidden) closeDetails();
});
chrome.tabs.onUpdated.addListener(onRefreshTabUpdated);
chrome.tabs.onUpdated.addListener(onWalkerTabUpdated);
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== walker.tabId) return;
  walker.tabId = null;
  stopWalker("כרטיסיית הדפדוף נסגרה, הדפדוף נעצר.");
});
loadWalkerSettings();
$("startWalker").addEventListener("click", startWalker);
$("pauseWalker").addEventListener("click", toggleWalkerPause);
$("stopWalker").addEventListener("click", () => stopWalker());
for (const id of ["walkerUrl", "walkerFrom", "walkerTo", "walkerSpeed", "walkerDelay"]) {
  $(id).addEventListener("change", saveWalkerSettings);
}
// מהירות והשהיה אפשר לשנות גם באמצע דפדוף
$("walkerSpeed").addEventListener("change", readWalkerDelay);
$("walkerDelay").addEventListener("change", readWalkerDelay);
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== refreshTabId) return;
  refreshTabId = null;
  if (refreshQueue.length && !currentPageLoaded) {
    skipRefreshListing(new Error("כרטיסיית הרענון נסגרה לפני טעינת הדף."), true);
  }
});
loadPurchaseTaxSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && PURCHASE_TAX_KEYS.some((key) => changes[key])) loadPurchaseTaxSettings(true);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    const updated = {
      requiredAmenities: timelinePreferences.requiredAmenities,
      removeBrokerage: timelinePreferences.removeBrokerage,
      calculateRail: timelinePreferences.calculateRail,
      requireRail: timelinePreferences.requireRail,
      nearM: timelinePreferences.nearM,
      calculatePpsm: timelinePreferences.calculatePpsm,
      maxPpsm: timelinePreferences.maxPpsm,
      irrelevantMissingPct: timelinePreferences.irrelevantMissingPct,
      dealBreakerAmenities: timelinePreferences.dealBreakerAmenities,
    };
    for (const key of Object.keys(updated)) {
      if (changes[key]) updated[key] = changes[key].newValue;
    }
    readTimelinePreferences(updated);
    if (timelinePreferencesEnabled) renderPriceTimeline();
    if (changes.requiredAmenities || changes.irrelevantMissingPct || changes.dealBreakerAmenities) {
      renderRows();
      renderListingDeletionPreview();
    }
    return;
  }
  if (area !== "local") return;
  if (changes[FONT_SCALE_KEY]) {
    const storedScale = Number(changes[FONT_SCALE_KEY].newValue);
    if (Number.isFinite(storedScale)) applyFontScale(storedScale);
  }
  if (changes[REFRESH_DELAY_KEY]) {
    const value = Number(changes[REFRESH_DELAY_KEY].newValue);
    if (Number.isFinite(value)) {
      refreshDelaySec = Math.max(MIN_REFRESH_DELAY_SEC, Math.min(MAX_REFRESH_DELAY_SEC, Math.round(value)));
      $("refreshDelay").value = String(refreshDelaySec);
    }
  }
  if (changes[REFRESH_RUNTIME_KEY]) loadRefreshSchedule();
  const cacheKeys = Object.keys(changes).filter(LRListingStore.isCacheKey);
  if (!cacheKeys.length || writing) return;
  if (dirtyFields.size) {
    $("saveStatus").textContent = "המטמון השתנה בחלון אחר. רענן לפני שמירה.";
    $("saveStatus").dataset.error = "true";
    return;
  }
  // בזמן גלישה/רענון כל עמוד מודעה כותב למטמון; מאחדים את השינויים לעדכון אחד
  // ומחילים רק את החלקים שהשתנו (מגיעים עם האירוע) במקום לקרוא שוב את כל המאגר
  for (const key of cacheKeys) pendingShardChanges[key] = changes[key].newValue;
  scheduleCacheReload();
});

let pendingShardChanges = {};
const scheduleCacheReload = debounce(async () => {
  const shardChanges = pendingShardChanges;
  pendingShardChanges = {};
  if (writing || dirtyFields.size) return;
  // המפתח הישן (לפני החלוקה לחלקים) – קוראים הכל מחדש
  if (LRListingStore.LEGACY_KEY in shardChanges) {
    loadCache();
    return;
  }
  const next = LRListingStore.applyShardChanges(cache, shardChanges);
  try {
    cache = await migrateEstimatedBaselineDates(next);
    applyCacheToViews();
  } catch (error) {
    console.error("[lightrail-ext] failed to apply cache change", error);
    loadCache();
  }
}, 1200);

initializeTimelineAmenityFilters();
initializeSearchAmenityFilters();
initializeDeleteAmenityFilters();
renderHeader();
loadTimelinePreferences();
// עסקאות האמת נטענות יחד עם המודעות – אחרת המונה, חיפוש העסקאות, עמודות "מול עסקאות אמת"
// ולוח הבקרה הראו 0 בכל פתיחה של העמוד, עד לחיצה על "רענון תצוגה"
Promise.all([storageGet(), storageGet(REFRESH_DELAY_KEY), storageGet(FONT_SCALE_KEY), loadDeals()])
  .then(async ([storedCache, storedDelay, storedFontScale]) => {
    cache = await migrateEstimatedBaselineDates(storedCache);
    if (Number.isFinite(storedDelay)) {
      refreshDelaySec = Math.max(
        MIN_REFRESH_DELAY_SEC,
        Math.min(MAX_REFRESH_DELAY_SEC, Math.round(storedDelay))
      );
      $("refreshDelay").value = String(refreshDelaySec);
    }
    if (Number.isFinite(storedFontScale)) applyFontScale(storedFontScale);
    await loadRefreshSchedule();
    renderRows();
    renderListingDeletionPreview();
    const initialView = viewFromHash();
    if (initialView && initialView !== activeTab) setActiveTab(initialView);
    // אם המשתמש עבר ללוח הבקרה או לציר המחירים לפני שהמידע נטען – בונים אותם עכשיו עם המידע
    else if (activeTab === "dashboard") renderDashboard();
    else if (activeTab === "priceChanges") renderPriceTimeline();
    else if (activeTab === "deals") renderDeals();
    const params = new URLSearchParams(location.search);
    if (params.get("scheduledRefresh") === "1") {
      const uncheckedOnly = params.get("uncheckedOnly") === "1";
      history.replaceState(null, "", location.pathname);
      setActiveTab("refresh");
      $("refreshScope").value = uncheckedOnly ? "unchecked" : "filtered";
      const schedule = await storageGet(REFRESH_SCHEDULE_KEY);
      // האתר נלקח מהתזמון השמור (גם תזמון ישן בלי שדה site = כל האתרים)
      const site = normalizeRefreshSite(params.get("site") || (schedule && schedule.site));
      $("refreshSite").value = site;
      if (schedule && schedule.enabled === true) {
        startRefresh({ scheduled: true, uncheckedOnly, site });
      } else {
        const message = "התזמון בוטל לפני תחילת הרענון.";
        setRefreshStatus(message);
        reportRefreshRun("lightrail:refresh-run-finished", message);
      }
    }
  })
  .catch((error) => {
    console.error("[lightrail-ext] failed to initialize cache manager", error);
    $("recordCount").textContent = error.message || "טעינת המטמון נכשלה";
    $("recordCount").dataset.error = "true";
  });

// ---------- סנכרון אונליין ----------
// כל העבודה מול השרת נעשית ב-background.js; העמוד רק שולח הוראות ומציג מצב.
function sendSyncMessage(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (result) => {
      const error = chrome.runtime.lastError;
      if (error) resolve({ ok: false, error: error.message });
      else resolve(result || { ok: false, error: "אין תשובה מהתוסף." });
    });
  });
}

// מפתח סודי (secret / service_role) עוקף את ההרשאות של הטבלה – לא מאפשרים לשמור אותו בתוסף
function isSecretSupabaseKey(key) {
  const text = String(key || "").trim();
  if (/^sb_secret_/i.test(text)) return true;
  const parts = text.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload && payload.role === "service_role";
  } catch {
    return false;
  }
}

function setSyncStatus(id, text, isError = false) {
  const element = $(id);
  element.textContent = text;
  element.dataset.error = String(Boolean(isError));
}

function syncSummary(result) {
  const parts = [];
  if (result.pulled) parts.push(`${result.pulled.toLocaleString("he-IL")} התקבלו`);
  if (result.pushed) parts.push(`${result.pushed.toLocaleString("he-IL")} נשלחו`);
  return parts.length ? parts.join(" · ") : "הכל מעודכן";
}

let syncPanelState = null;
async function renderSyncPanel() {
  if (!$("syncSetupSql").value) $("syncSetupSql").value = LRSync.SETUP_SQL;
  const state = await sendSyncMessage("lightrail:sync-status");
  if (!state.ok) return;
  syncPanelState = state;
  const connected = state.enabled && !state.needsLogin;
  $("syncConnectedCard").hidden = !connected;
  $("syncLoginCard").hidden = connected;
  // טבלת העסקאות חדשה: מי שכבר מחובר צריך להריץ שוב את פקודת ההקמה, אז מציגים אותה
  $("syncSetupCard").hidden = connected && !state.dealsNeedsSetup;
  if (!$("syncUrl").value) $("syncUrl").value = state.url;
  if (!$("syncApiKey").value) $("syncApiKey").value = state.apiKey;
  if (!$("syncEmail").value) $("syncEmail").value = state.email;
  if (state.intervalMin) $("syncInterval").value = String(state.intervalMin);
  const badge = $("syncBadge");
  scheduleCloudIndicators(0);
  if (connected) {
    let host = "";
    try {
      host = new URL(state.url).host;
    } catch {}
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("he-IL") : "עדיין לא";
    $("syncConnectedText").textContent = `מחובר כ-${state.email} לפרויקט ${host}. סנכרון אחרון: ${last}.` +
      (state.dealsNeedsSetup
        ? " טבלת עסקאות האמת עוד לא קיימת בפרויקט: יש להריץ שוב את פקודת ההקמה (למטה) ב-SQL Editor. המודעות ממשיכות להסתנכרן כרגיל."
        : state.lastDealsPushed || state.lastDealsPulled
          ? ` עסקאות אמת בסבב האחרון: ${state.lastDealsPushed} נשלחו, ${state.lastDealsPulled} התקבלו.`
          : "");
    // בזמן שסבב רץ לא מציגים את השגיאה של הסבב הקודם מעל "מסנכרן…"
    if (state.lastError && !$("syncNow").disabled) {
      setSyncStatus("syncConnectedStatus", `הסנכרון האחרון נכשל: ${state.lastError} אפשר ללחוץ על „סנכרון עכשיו” כדי לנסות שוב.`, true);
    }
    badge.textContent = state.lastError ? "שגיאת סנכרון" : "מחובר";
    badge.dataset.state = state.lastError ? "error" : "on";
  } else {
    badge.textContent = state.needsLogin ? "נדרשת התחברות מחדש" : "לא מחובר";
    badge.dataset.state = state.needsLogin ? "error" : "off";
    if (state.needsLogin) {
      setSyncStatus("syncLoginStatus", "פג תוקף הכניסה. הזן סיסמה והתחבר שוב – המידע לא נמחק.", true);
    }
  }
}

async function connectOnlineSync() {
  const button = $("syncConnect");
  const apiKey = $("syncApiKey").value.trim();
  if (isSecretSupabaseKey(apiKey)) {
    setSyncStatus("syncLoginStatus", "זה המפתח הסודי של הפרויקט. יש להזין את המפתח הציבורי (publishable / anon) בלבד.", true);
    return;
  }
  button.disabled = true;
  setSyncStatus("syncLoginStatus", "מתחבר ומעביר את המידע… (בפעם הראשונה זה יכול לקחת דקה)");
  try {
    const result = await sendSyncMessage("lightrail:sync-connect", {
      url: $("syncUrl").value,
      apiKey,
      email: $("syncEmail").value,
      password: $("syncPassword").value,
    });
    if (!result.ok) {
      setSyncStatus("syncLoginStatus", result.error || "ההתחברות נכשלה.", true);
      if (result.needsSetup) $("syncSetupSql").focus();
      return;
    }
    $("syncPassword").value = "";
    setSyncStatus("syncLoginStatus", "");
    await renderSyncPanel();
    setSyncStatus("syncConnectedStatus", `החיבור הצליח · ${syncSummary(result)}`);
  } finally {
    button.disabled = false;
  }
}

// ---------- התקדמות סבב הסנכרון ----------
// background.js כותב כל שלב (מה הוא עושה, כמה מתוך כמה) ל-lightrailSyncProgress; כאן הוא מוצג בזמן אמת.
const SYNC_PROGRESS_KEY = "lightrailSyncProgress";
// סבב ארוך הוא לא תקלה: רק אם אין שום התקדמות 3 דקות – הכפתור משתחרר (הסבב עצמו ממשיך ברקע)
const SYNC_STALL_MS = 180_000;
const SYNC_STEP_ICONS = { waiting: "○", running: "⏳", done: "✓", skipped: "–", failed: "✗", notRun: "○" };
const SYNC_STEP_STATUS = { waiting: "ממתין", running: "רץ עכשיו", done: "הושלם", skipped: "דולג", failed: "נכשל", notRun: "לא הגיע לשלב" };
const SYNC_DIRECTION = { pullListings: "⬇", pullDeals: "⬇", pushListings: "⬆", pushDeals: "⬆", settings: "⇅", session: "🔑" };
let syncProgressState = null;

function durationText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} שנ׳` : `${Math.floor(seconds / 60)} דק׳ ${seconds % 60} שנ׳`;
}

function renderSyncProgress(progress = syncProgressState) {
  syncProgressState = progress || null;
  const box = $("syncProgressBox");
  if (!progress || !Array.isArray(progress.steps)) {
    box.hidden = true;
    renderSyncTabBadge();
    return;
  }
  box.hidden = false;
  box.dataset.state = progress.running ? "running" : progress.ok ? "done" : "failed";
  const reasons = { alarm: "סבב אוטומטי", manual: "סנכרון עכשיו", push: "שליחת הגדרות", open: "בפתיחת העמוד" };
  const started = new Date(progress.startedAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("syncProgressTitle").textContent = progress.running
    ? `סבב סנכרון רץ (${reasons[progress.reason] || "סבב"}, התחיל ב-${started})`
    : progress.ok
      ? `הסבב האחרון הושלם (${started})`
      : `הסבב האחרון נכשל (${started})`;
  const end = progress.running ? Date.now() : progress.finishedAt || progress.updatedAt;
  const quietFor = Date.now() - (progress.updatedAt || progress.startedAt);
  $("syncProgressTime").textContent = `משך: ${durationText(end - progress.startedAt)}` +
    (progress.running && quietFor > 20_000 ? ` · ממתין לתשובת השרת ${durationText(quietFor)}` : "");
  $("syncSteps").replaceChildren(...progress.steps.map((step) => {
    const item = el("li", "sync-step");
    item.dataset.status = step.status;
    const head = el("div", "sync-step-head");
    head.append(
      el("span", "sync-step-icon", SYNC_STEP_ICONS[step.status] || "○"),
      el("span", "sync-step-label", `${SYNC_DIRECTION[step.id] || ""} ${step.label}`.trim()),
      el("span", "sync-step-status", SYNC_STEP_STATUS[step.status] || "")
    );
    item.append(head);
    if (step.detail) item.append(el("div", "sync-step-detail", step.detail));
    if (step.status === "running" && step.total > 0) {
      const bar = el("div", "sync-step-bar");
      const fill = el("span");
      fill.style.width = `${Math.min(100, Math.round((step.done / step.total) * 100))}%`;
      bar.append(fill);
      item.append(bar);
    }
    return item;
  }));
  renderSyncTabBadge();
}

async function loadSyncProgress() {
  const stored = await chrome.storage.local.get(SYNC_PROGRESS_KEY);
  renderSyncProgress(stored[SYNC_PROGRESS_KEY] || null);
}

// "משך" מתעדכן כל שנייה בזמן שסבב רץ
setInterval(() => {
  if (syncProgressState && syncProgressState.running) renderSyncProgress();
}, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SYNC_PROGRESS_KEY]) renderSyncProgress(changes[SYNC_PROGRESS_KEY].newValue || null);
});

// מחכה לסוף הסבב לפי ההתקדמות שנרשמת – לא לפי זמן קבוע. משתחרר רק אם אין התקדמות SYNC_STALL_MS.
function waitForSyncEnd(request) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      resolve(value);
    };
    request.then(done);
    const watch = setInterval(() => {
      const progress = syncProgressState;
      const lastActivity = progress && progress.running ? progress.updatedAt : 0;
      if (lastActivity && Date.now() - lastActivity > SYNC_STALL_MS) {
        done({
          ok: false,
          stalled: true,
          error: `אין התקדמות כבר ${durationText(Date.now() - lastActivity)} בשלב „${(progress.steps.find((step) => step.id === progress.current) || {}).label || ""}”. הסבב ממשיך ברקע, וכל מה שכבר הורד או נשלח נשמר – הסבב הבא ימשיך מאותה נקודה.`,
        });
      }
    }, 5000);
  });
}

async function runOnlineSyncNow(quiet = false) {
  const button = $("syncNow");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "מסנכרן…";
  // גם בסנכרון האוטומטי בפתיחת העמוד מראים שהוא רץ – אחרת השגיאה הישנה נשארת והכפתור נראה תקוע
  setSyncStatus("syncConnectedStatus", syncProgressState && syncProgressState.running
    ? "סבב קודם עדיין רץ – הסבב הזה יתחיל מיד אחריו. ההתקדמות מוצגת למטה."
    : "");
  try {
    const result = await waitForSyncEnd(sendSyncMessage("lightrail:sync-now", { reason: quiet ? "open" : "manual" }));
    if (result.skipped) {
      setSyncStatus("syncConnectedStatus", "");
      return;
    }
    if (result.skipped) return;
    // קודם מרעננים את הפאנל (הוא מציג את השגיאה הקודמת מההגדרות), ורק אז את תוצאת הסבב הזה
    await renderSyncPanel();
    setSyncStatus(
      "syncConnectedStatus",
      result.ok
        ? quiet ? "" : `הסנכרון הושלם · ${syncSummary(result)}`
        : result.stalled
          ? result.error
          : `הסנכרון נכשל: ${result.error} מה שכבר הורד או נשלח נשמר. אפשר ללחוץ שוב על „סנכרון עכשיו” – הסבב ימשיך מאותה נקודה.`,
      !result.ok
    );
  } finally {
    button.disabled = false;
    button.textContent = "סנכרון עכשיו";
  }
}

async function disconnectOnlineSync() {
  if (!window.confirm("לנתק את הסנכרון? המידע נשאר גם במחשב הזה וגם במסד הנתונים, ושינויים חדשים לא יסונכרנו עד להתחברות מחדש.")) return;
  await sendSyncMessage("lightrail:sync-disconnect");
  setSyncStatus("syncConnectedStatus", "");
  setSyncStatus("syncLoginStatus", "הסנכרון נותק. המידע במחשב הזה לא השתנה.");
  await renderSyncPanel();
}

// מחיקה שהמשתמש ביצע נשלחת גם למסד הנתונים (אם הסנכרון פעיל)
function notifySyncDeleted(keys) {
  const list = [...keys].filter(Boolean);
  if (list.length) sendSyncMessage("lightrail:sync-deleted", { keys: list });
}

$("syncConnect").addEventListener("click", connectOnlineSync);
$("syncNow").addEventListener("click", () => runOnlineSyncNow(false));
$("syncDisconnect").addEventListener("click", disconnectOnlineSync);
$("syncInterval").addEventListener("change", async () => {
  const result = await sendSyncMessage("lightrail:sync-interval", { minutes: Number($("syncInterval").value) });
  setSyncStatus(
    "syncConnectedStatus",
    result.ok ? `נשמר: סנכרון כל ${$("syncInterval").selectedOptions[0].textContent.replace(/^כל /, "")}` : result.error || "השמירה נכשלה.",
    !result.ok
  );
  scheduleCloudIndicators(0);
});
$("syncCopySql").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(LRSync.SETUP_SQL);
    $("syncCopySql").textContent = "הועתק ✓";
  } catch {
    $("syncSetupSql").select();
    $("syncCopySql").textContent = "סמן והעתק ידנית";
  }
  setTimeout(() => ($("syncCopySql").textContent = "העתקת הפקודה"), 2500);
});
$("syncPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectOnlineSync();
});

// ---------- חיווי ענן חי: עמודת "ענן", מונה ממתינים בתפריט ושורה במסך הרענון ----------
async function loadCloudSync() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      [LRSync.SETTINGS_KEY, LRSync.HASHES_KEY, LRSync.TOMBSTONES_KEY],
      (result) => resolve(result || {})
    )
  );
  const alarm = await new Promise((resolve) => {
    try {
      chrome.alarms.get("lightrail-online-sync", (value) => resolve(value || null));
    } catch {
      resolve(null);
    }
  });
  const settings = stored[LRSync.SETTINGS_KEY] || {};
  cloudSync = {
    enabled: Boolean(settings.enabled) && !settings.needsLogin,
    needsLogin: Boolean(settings.needsLogin),
    hashes: stored[LRSync.HASHES_KEY] || {},
    pendingDeletes: Array.isArray(stored[LRSync.TOMBSTONES_KEY]) ? stored[LRSync.TOMBSTONES_KEY].length : 0,
    nextSyncAt: alarm && alarm.scheduledTime ? alarm.scheduledTime : null,
    intervalMin: Number(settings.intervalMin) || 5,
    lastPushAt: settings.lastPushAt || null,
    lastSyncAt: settings.lastSyncAt || null,
    lastError: settings.lastError || "",
  };
}

function nextSyncText() {
  return cloudSync.nextSyncAt
    ? `בסנכרון הבא (${new Date(cloudSync.nextSyncAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })})`
    : "בסנכרון הבא";
}

function cloudPendingCount() {
  let pending = 0;
  for (const [key, record] of Object.entries(cache || {})) {
    if (cloudState(key, record) === "pending") pending++;
  }
  return pending;
}

function refreshCloudIndicators() {
  document.body.dataset.cloud = cloudSync.enabled ? "on" : "off";
  // תאי "ענן" בשורות שכבר מוצגות – בלי לבנות את הטבלה מחדש
  for (const row of rows.querySelectorAll("tr[data-key]")) {
    const td = row.querySelector("td.cloud-col");
    const record = cache[row.dataset.key];
    if (td && record) renderCloudCell(td, row.dataset.key, record);
  }
  const pending = cloudSync.enabled ? cloudPendingCount() : 0;
  const tabState = $("syncTabState");
  const line = $("refreshCloudStatus");
  if (!cloudSync.enabled) {
    tabState.hidden = !cloudSync.needsLogin;
    tabState.textContent = "!";
    tabState.title = cloudSync.needsLogin ? "נדרשת התחברות מחדש לסנכרון" : "";
    line.hidden = true;
    return;
  }
  cloudSync.waiting = pending + (cloudSync.pendingDeletes || 0);
  renderSyncTabBadge();
  line.hidden = false;
  line.dataset.state = cloudSync.lastError ? "error" : pending ? "pending" : "synced";
  const lastPush = cloudSync.lastPushAt ? ` · שליחה אחרונה: ${cloudTime(cloudSync.lastPushAt)}` : "";
  const deletes = cloudSync.pendingDeletes
    ? ` ו־${cloudSync.pendingDeletes.toLocaleString("he-IL")} מחיקות`
    : "";
  line.textContent = cloudSync.lastError
    ? `ענן: השליחה נכשלה (${cloudSync.lastError}) – ${pending.toLocaleString("he-IL")} ממתינות, ינסה שוב ${nextSyncText()}`
    : pending || cloudSync.pendingDeletes
      ? `ענן: ${pending.toLocaleString("he-IL")} מודעות${deletes} ברשימת הממתינות – יישלחו ${nextSyncText()}${lastPush}`
      : `ענן: כל המודעות נשמרו במסד הנתונים ✓${lastPush}`;
  // אותו מצב גם במסך הסנכרון
  $("syncQueueText").textContent = line.textContent.replace(/^ענן: /, "");
}

// התג ליד "סנכרון אונליין": בזמן סבב – מה קורה עכשיו (⬇ הורדה / ⬆ העלאה ואחוז); אחרת – ⬆ כמה מחכים להעלאה
function renderSyncTabBadge() {
  const tabState = $("syncTabState");
  if (!cloudSync.enabled) return;
  tabState.hidden = false;
  const progress = syncProgressState;
  const step = progress && progress.running ? progress.steps.find((item) => item.id === progress.current) : null;
  delete tabState.dataset.state;
  if (step) {
    const pct = step.total > 0 ? ` ${Math.min(100, Math.round((step.done / step.total) * 100))}%` : "";
    tabState.textContent = `${SYNC_DIRECTION[step.id] || "⇅"}${pct}`;
    tabState.dataset.state = "running";
    tabState.title = `סנכרון רץ עכשיו: ${step.label}${step.detail ? ` – ${step.detail}` : ""}`;
    return;
  }
  const waiting = cloudSync.waiting || 0;
  if (cloudSync.lastError) {
    tabState.textContent = "!";
    tabState.dataset.state = "error";
    tabState.title = `הסנכרון האחרון נכשל: ${cloudSync.lastError}`;
  } else if (waiting) {
    tabState.textContent = `⬆ ${waiting.toLocaleString("he-IL")}`;
    tabState.title = `${waiting.toLocaleString("he-IL")} שינויים מהמחשב הזה מחכים להעלאה לענן – יישלחו ${nextSyncText()}`;
  } else {
    tabState.textContent = "✓";
    tabState.title = "הכול מסונכרן: כל המודעות מהמחשב הזה שמורות בענן";
  }
}

let cloudIndicatorTimer = null;
function scheduleCloudIndicators(delay = 300) {
  clearTimeout(cloudIndicatorTimer);
  cloudIndicatorTimer = setTimeout(() => {
    loadCloudSync().then(refreshCloudIndicators).catch(() => {});
  }, delay);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some(LRDeals.isDealsKey)) scheduleDealsReload();
  if (changes[LRSync.SETTINGS_KEY] || changes[LRSync.HASHES_KEY]) scheduleCloudIndicators(300);
  // שינוי במטמון מגיע לטבלה אחרי עיכוב קצר – מעדכנים את החיווי אחריו
  else if (Object.keys(changes).some(LRListingStore.isCacheKey)) scheduleCloudIndicators(1500);
});

loadCloudSync().then(refreshCloudIndicators).catch(() => {});
loadSyncProgress().catch(() => {});

// בפתיחת העמוד: אם הסנכרון פעיל – מושכים מיד שינויים ממחשבים אחרים
renderSyncPanel().then(() => {
  if (syncPanelState && syncPanelState.enabled && !syncPanelState.needsLogin) runOnlineSyncNow(true);
});
