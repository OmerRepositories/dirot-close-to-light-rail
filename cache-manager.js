const CACHE_KEY = "yad2AmenityCache_v1";
const REFRESH_DELAY_KEY = "cacheRefreshDelaySec";
const REFRESH_SCHEDULE_KEY = "lightrailRefreshSchedule";
const REFRESH_RUNTIME_KEY = "lightrailRefreshRuntime";
const REFRESH_ALARM_NAME = "lightrail-periodic-listing-refresh";
const FONT_SCALE_KEY = "cacheManagerFontScale";
const MIN_REFRESH_DELAY_SEC = 5;
const MAX_REFRESH_DELAY_SEC = 600;
const MIN_FONT_SCALE = 0.8;
const MAX_FONT_SCALE = 1.5;
const FONT_SCALE_STEP = 0.1;
const REFRESH_LOAD_TIMEOUT_MS = 90000;
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
let refreshQueue = [];
let refreshIndex = 0;
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
let fontScale = 1;
let showFullPriceHistory = false;
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
};
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
  };
}

function passesTimelineRange(event, field) {
  const minimum = document.querySelector(`[data-timeline-min="${field}"]`);
  const maximum = document.querySelector(`[data-timeline-max="${field}"]`);
  const min = minimum && minimum.value !== "" ? Number(minimum.value) : null;
  const max = maximum && maximum.value !== "" ? Number(maximum.value) : null;
  if (min === null && max === null) return true;
  const value = field === "price"
    ? Number.isFinite(event.currentPrice) ? event.currentPrice : event.toPrice
    : event[field];
  if (!Number.isFinite(value)) return false;
  return (min === null || value >= min) && (max === null || value <= max);
}

function passesTimelineFilters(event) {
  if (!["price", "railMeters", "pricePerSqm", "rooms"].every((field) => passesTimelineRange(event, field))) {
    return false;
  }
  const brokerageFilter = $("timelineBrokerage").value;
  if (brokerageFilter === "unknown") {
    if (typeof event.brokerage === "boolean") return false;
  } else if (brokerageFilter && String(event.brokerage) !== brokerageFilter) {
    return false;
  }
  for (const input of document.querySelectorAll("[data-timeline-amenity]")) {
    if (!input.value) continue;
    const value = event.amenities && event.amenities[input.dataset.timelineAmenity];
    if (input.value === "unknown" ? typeof value === "boolean" : String(value) !== input.value) {
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

const columns = [
  { key: "title", label: "מודעה / כתובת", sortKey: "title", className: "record-name" },
  { key: "notes", label: "הערה אישית", sortKey: "notes", className: "notes-column", title: "הערות שהוספת למודעה; לחיצה על השורה פותחת את מסך העריכה" },
  { key: "type", label: "סוג", sortKey: "recordType" },
  { key: "site", label: "אתר", sortKey: "site" },
  { key: "listingStatus", label: "סטטוס מודעה", sortKey: "listingStatus", title: "נבדק ברענון הדרגתי של יד2" },
  { key: "rooms", label: "חדרים", sortKey: "rooms", title: "מספר החדרים שזוהה במודעה" },
  { key: "price", label: "מחיר", sortKey: "price" },
  { key: "sqm", label: "מ״ר", sortKey: "sqm" },
  { key: "pricePerSqm", label: "מחיר למ״ר", sortKey: "pricePerSqm", title: "מחושב ממחיר חלקי שטח; אינו ניתן לעריכה" },
  { key: "railMeters", label: "רכבת (מ׳)", sortKey: "railMeters", title: "מרחק בקו אווירי; עשוי להיות משוער" },
  { key: "brokerage", label: "תיווך", boolean: true, title: "כן / לא / לא ידוע" },
  { key: "dealScore", label: "ציון שווה", sortKey: "dealScore", title: "ציון משוקלל: מאפיינים, מחיר למ״ר, קרבה לרכבת ותיווך" },
  ...AMENITIES.map(([key, label]) => ({
    key: `amenity:${key}`,
    amenity: key,
    label,
    boolean: true,
    title: "מאפיין הנכס: כן / לא / לא ידוע",
  })),
  { key: "updatedAt", label: "עדכון אחרון", sortKey: "updatedAt" },
  { key: "priceHistory", label: "היסטוריית מחיר", sortKey: "priceHistory", title: "מספר נקודות היסטוריית מחיר" },
  { key: "actions", label: "פעולות" },
];

function storageGet(key = CACHE_KEY) {
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

function storageSet(values) {
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

async function migrateEstimatedBaselineDates(sourceCache) {
  let latestCache = sourceCache;
  try {
    latestCache = await storageGet();
    const migration = LRCacheData.addEstimatedBaselineDates(latestCache);
    if (!migration.updatedCount) return latestCache;
    await storageSet({ [CACHE_KEY]: migration.cache });
    setRefreshStatus(
      `עודכנו ${migration.updatedCount.toLocaleString("he-IL")} תאריכי בסיס משוערים בהיסטוריית המחירים.`
    );
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

function displayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("he-IL") : String(value);
}

function displayPrice(value) {
  return Number.isFinite(value) ? `₪${Math.round(value).toLocaleString("he-IL")}` : "";
}

function displayHistoryDate(value) {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
    return "תאריך לא ידוע";
  }
  return new Intl.DateTimeFormat("he-IL-u-nu-latn", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
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
    label.setAttribute(
      "aria-sort",
      sort.key === column.sortKey
        ? sort.direction > 0
          ? "ascending"
          : "descending"
        : "none"
    );
    label.addEventListener("click", () => {
      if (sort.key === column.sortKey) sort.direction *= -1;
      else {
        sort.key = column.sortKey;
        sort.direction = ["title", "site", "recordType"].includes(sort.key) ? 1 : -1;
        if (["rooms", "price", "pricePerSqm", "railMeters"].includes(sort.key)) {
          sort.direction = 1;
        }
      }
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
      filter.addEventListener("input", renderRows);
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

function rowSortValue(key, record, priceRanks) {
  if (sort.key === "recordType") return recordType(record);
  if (sort.key === "site") return recordSite(key);
  if (sort.key === "pricePerSqm") return LRCacheData.pricePerSqm(record);
  if (sort.key === "dealScore") {
    return LRCacheData.dealScore(record, priceRanks.get(key) ?? 0.5);
  }
  if (sort.key === "priceHistory") {
    return validPriceHistory(record).length;
  }
  return record[sort.key];
}

function matchesBooleanFilter(record, filterKey, filterValue) {
  if (!filterValue) return true;
  const actual = filterKey === "brokerage"
    ? typeof record.brokerage === "boolean" ? String(record.brokerage) : "unknown"
    : typeof amenityValue(record, filterKey.slice("amenity:".length)) === "boolean"
      ? String(amenityValue(record, filterKey.slice("amenity:".length)))
      : "unknown";
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
  return record[key];
}

function activeNumericRanges() {
  const ranges = new Map();
  for (const input of document.querySelectorAll("[data-range-min], [data-range-max]")) {
    const key = input.dataset.rangeMin || input.dataset.rangeMax;
    const edge = input.dataset.rangeMin ? "min" : "max";
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

function columnFilterText(key, record, recordKey, priceRanks) {
  if (key === "title") return [record.title, record.address, record.city, record.neighborhood].filter(Boolean).join(" ");
  if (key === "notes") return record.notes || "";
  if (key === "type") return recordType(record) === "project" ? "פרויקט" : "מודעה";
  if (key === "site") return recordSite(recordKey);
  if (key === "listingStatus") {
    return recordSite(recordKey) === "yad2" && recordType(record) === "listing"
      ? record.listingStatus === "active"
        ? "פעילה"
        : record.listingStatus === "removed"
          ? "הוסרה"
          : "לא נבדקה"
      : "";
  }
  if (key === "price") return `${record.price ?? ""} ${displayPrice(record.price)}`;
  if (key === "sqm" || key === "rooms" || key === "railMeters") return String(record[key] ?? "");
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
    return String(LRCacheData.dealScore(record, priceRanks.get(recordKey) ?? 0.5) ?? "");
  }
  return "";
}

function renderBoolean(value) {
  const [label, state] = booleanText(value);
  const span = textCell(label, `boolean-value ${state}`);
  return span;
}

function renderRows() {
  const query = $("searchInput").value.trim().toLocaleLowerCase("he");
  const site = $("siteFilter").value;
  const type = $("typeFilter").value;
  const boolFilters = [...document.querySelectorAll("[data-boolean-filter]")]
    .map((select) => [select.dataset.booleanFilter, select.value])
    .filter(([, value]) => value);
  const columnFilters = [...document.querySelectorAll("[data-column-filter]")]
    .map((input) => [input.dataset.columnFilter, input.value.trim().toLocaleLowerCase("he")])
    .filter(([, value]) => value);
  const ranges = activeNumericRanges();
  const priceRanks = allPriceRanks(Object.entries(cache));
  visibleRecords = Object.entries(cache)
    .filter(([key, record]) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return false;
      if (site && recordSite(key) !== site) return false;
      if (type && recordType(record) !== type) return false;
      if (!boolFilters.every(([field, value]) => matchesBooleanFilter(record, field, value))) return false;
      if (!matchesNumericFilters(record, ranges)) return false;
      const haystack = `${key} ${JSON.stringify(record)}`.toLocaleLowerCase("he");
      if (query && !haystack.includes(query)) return false;
      return columnFilters.every(([field, value]) =>
        columnFilterText(field, record, key, priceRanks)
          .toLocaleLowerCase("he")
          .includes(value)
      );
    })
    .sort((left, right) => {
      const a = rowSortValue(left[0], left[1], priceRanks);
      const b = rowSortValue(right[0], right[1], priceRanks);
      const aMissing = a === null || a === undefined || a === "";
      const bMissing = b === null || b === undefined || b === "";
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : collator.compare(String(a), String(b));
      return comparison * sort.direction;
    });

  rows.replaceChildren();
  for (const [key, record] of visibleRecords) {
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
      } else if (column.key === "listingStatus") {
        td.className = "listing-status-cell";
        const status = document.createElement("span");
        const site = recordSite(key);
        if (site !== "yad2" || recordType(record) !== "listing") {
          status.className = "listing-status unknown";
          status.textContent = "—";
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
          status.textContent = "לא נבדקה";
        }
        td.appendChild(status);
      } else if (column.key === "title") {
        td.className = "record-name";
        const title = record.title || key;
        const address = [record.address, record.city].filter(Boolean).join(", ");
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
      } else if (column.key === "notes") {
        td.className = "notes-cell";
        td.textContent = record.notes || "";
        td.title = record.notes || "";
      } else if (column.key === "price") {
        td.textContent = displayPrice(record.price);
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
      } else if (column.key === "brokerage") {
        td.appendChild(renderBoolean(record.brokerage));
      } else if (column.key === "dealScore") {
        const score = LRCacheData.dealScore(record, priceRanks.get(key) ?? 0.5);
        td.textContent = score === null ? "—" : `${score} ★`;
        td.title = "ציון משוקלל לעזרה במיון בלבד, לא המלצת השקעה";
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
        actions.append(edit, remove);
        td.appendChild(actions);
      }
      row.appendChild(td);
    }
    rows.appendChild(row);
  }
  $("recordCount").textContent = `${visibleRecords.length.toLocaleString("he-IL")} מתוך ${Object.keys(cache).length.toLocaleString("he-IL")} רשומות`;
  $("emptyState").hidden = visibleRecords.length > 0;
  $("sortSelect").value = sort.key;
  renderHeaderSortState();
  renderPriceTimeline();
}

function renderPriceTimeline() {
  const timeline = $("priceTimeline");
  timeline.replaceChildren();
  const allEvents = LRCacheExport.getPriceTimelineEvents(cache);
  const changes = allEvents.filter((event) => event.kind === "increase" || event.kind === "decrease");
  const kindFilteredEvents = priceTimelineFilter === "all"
    ? allEvents
    : allEvents.filter((event) => event.kind === priceTimelineFilter);
  const events = kindFilteredEvents.filter(passesTimelineFilters);
  $("priceChangesCount").textContent = changes.length.toLocaleString("he-IL");
  $("timelineCount").textContent = `${events.length.toLocaleString("he-IL")} מתוך ${kindFilteredEvents.length.toLocaleString("he-IL")} אירועים`;
  $("emptyTimeline").hidden = events.length > 0;
  $("timelinePreferences").setAttribute("aria-pressed", String(timelinePreferencesEnabled));

  for (const change of events) {
    const item = document.createElement("li");
    item.className = `timeline-item ${change.kind}`;
    const card = document.createElement("article");
    card.className = "timeline-card";
    const metadata = document.createElement("div");
    metadata.className = "timeline-meta";
    const date = Number.isFinite(change.at) ? document.createElement("time") : document.createElement("span");
    if (Number.isFinite(change.at)) date.dateTime = new Date(change.at).toISOString();
    date.textContent = Number.isFinite(change.at) ? displayHistoryDate(change.at) : "תאריך לא ידוע";
    const site = document.createElement("span");
    site.className = "timeline-site";
    site.textContent = change.site === "yad2" ? "יד2" : change.site === "madlan" ? "מדלן" : change.site;
    metadata.append(date, site);

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
    if (change.baselineDateEstimated && Number.isFinite(change.baselineEstimatedAt)) {
      detail.textContent += ` (תאריך המחיר הקודם משוער: ${displayHistoryDate(change.baselineEstimatedAt)})`;
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
    item.appendChild(card);
    timeline.appendChild(item);
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
  });
}

function setActiveTab(tab) {
  const listingsActive = tab === "listings";
  $("listingsTab").classList.toggle("active", listingsActive);
  $("priceChangesTab").classList.toggle("active", !listingsActive);
  $("listingsTab").setAttribute("aria-selected", String(listingsActive));
  $("priceChangesTab").setAttribute("aria-selected", String(!listingsActive));
  $("listingsPanel").hidden = !listingsActive;
  $("priceChangesPanel").hidden = listingsActive;
}

function handleTabKeydown(event) {
  const tabs = [$("listingsTab"), $("priceChangesTab")];
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
  for (const button of document.querySelectorAll(".sort-button")) {
    const active = button.dataset.sort === sort.key;
    button.setAttribute(
      "aria-sort",
      active ? sort.direction > 0 ? "ascending" : "descending" : "none"
    );
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
  if (input.type === "number") {
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
    cache = latest;
    if (selectedKey === key) closeDetails();
    else renderRows();
  } catch (error) {
    console.error("[lightrail-ext] failed to delete cached record", error);
    $("saveStatus").textContent = error.message || "מחיקת הרשומה נכשלה.";
    $("saveStatus").dataset.error = "true";
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
      $("scheduleStatus").textContent += ` · ${$("refreshScope").value === "unchecked" ? "מודעות לא נבדקו בלבד" : "כל המודעות השמורות"} · ${delaySeconds} שניות בין מודעות`;
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

async function saveYad2ListingStatus(key, status, attemptId, index) {
  if (!["active", "removed"].includes(status)) return;
  if (
    !refreshQueue.length ||
    refreshAttemptId !== attemptId ||
    refreshIndex !== index ||
    writing
  ) {
    return;
  }
  try {
    const latest = await storageGet();
    if (
      !refreshQueue.length ||
      refreshAttemptId !== attemptId ||
      refreshIndex !== index ||
      !latest[key] ||
      recordSite(key) !== "yad2"
    ) {
      return;
    }
    latest[key] = {
      ...latest[key],
      listingStatus: status,
      listingStatusCheckedAt: Date.now(),
    };
    writing = true;
    await storageSet({ [CACHE_KEY]: latest });
    cache = latest;
    renderRows();
  } catch (error) {
    console.error("[lightrail-ext] failed to save Yad2 listing status", error);
    setRefreshStatus(`הדף נטען, אך סטטוס המודעה לא נשמר: ${error.message}`, true);
  } finally {
    writing = false;
  }
}

function checkCurrentYad2ListingStatus(tabId, key, record, retries = 4) {
  const expectedId = key.slice(key.indexOf(":") + 1);
  const url = refreshableListingUrl(key, record);
  let urlId;
  try {
    const parsedUrl = new URL(url);
    const match = parsedUrl.pathname.match(/^\/realestate\/item\/[^/]+\/([^/]+)/);
    urlId = match && match[1];
  } catch {
    return;
  }
  if (!urlId || urlId !== expectedId) return;

  const attemptId = refreshAttemptId;
  const index = refreshIndex;
  chrome.tabs.sendMessage(tabId, { type: "lightrail:get-yad2-listing-status" }, (result) => {
    const error = chrome.runtime.lastError;
    if (error) {
      if (
        retries > 0 &&
        refreshQueue.length &&
        refreshAttemptId === attemptId &&
        refreshIndex === index
      ) {
        setTimeout(() => {
          checkCurrentYad2ListingStatus(tabId, key, record, retries - 1);
        }, 250);
        return;
      }
      console.warn("[lightrail-ext] could not check Yad2 listing status", error.message);
      return;
    }
    if (!result || result.id !== expectedId) return;
    saveYad2ListingStatus(key, result.status, attemptId, index);
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

function delayBetweenPages() {
  if (refreshPaused || !refreshQueue.length) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshIndex++;
    openNextListing();
  }, refreshDelaySec * 1000);
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
    `המודעה ${refreshIndex + 1}/${refreshQueue.length} דולגה (${title}). ממשיך למודעה הבאה בעוד ${refreshDelaySec} שניות.`,
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
  const [key, record] = refreshQueue[refreshIndex];
  if (recordSite(key) === "yad2") {
    checkCurrentYad2ListingStatus(tabId, key, record);
  }
  if (refreshPaused) {
    setRefreshStatus(`הדף ${refreshIndex + 1}/${refreshQueue.length} נטען; הרענון מושהה.`);
    return;
  }
  setRefreshStatus(
    `הדף ${refreshIndex + 1}/${refreshQueue.length} נטען. ממתין ${refreshDelaySec} שניות לפני הבא…`
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
  const sourceRecords = options.scheduled === true
    ? Object.entries(cache)
    : visibleRecords;
  refreshQueue = sourceRecords.filter(([key, record]) =>
    recordType(record) === "listing" &&
    Boolean(refreshableListingUrl(key, record)) &&
    (!uncheckedOnly ||
      recordSite(key) === "yad2" &&
      !["active", "removed"].includes(record.listingStatus))
  );
  refreshIndex = 0;
  refreshSkippedCount = 0;
  refreshPaused = false;
  refreshRunScheduled = options.scheduled === true;
  if (!refreshQueue.length) {
    const message = uncheckedOnly
      ? "אין מודעות יד2 בסטטוס „לא נבדקה” עם קישור תקין."
      : "אין בתוצאות המסוננות מודעות עם קישור תקין.";
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
  const scopeText = uncheckedOnly ? "מודעות יד2 שלא נבדקו" : "מודעות";
  setRefreshStatus(`מתחיל רענון של ${refreshQueue.length} ${scopeText}; ההמתנה היא ${refreshDelaySec} שניות אחרי כל טעינה.`);
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
    setRefreshStatus(`המשך: ממתין ${refreshDelaySec} שניות לפני המודעה הבאה…`);
    delayBetweenPages();
  } else {
    setRefreshStatus("הרענון ממשיך וממתין לסיום טעינת הדף הנוכחי.");
    startLoadTimeout();
  }
  updateRefreshButtons();
}

async function loadCache() {
  $("refreshButton").disabled = true;
  try {
    const storedCache = await storageGet();
    cache = await migrateEstimatedBaselineDates(storedCache);
    renderRows();
    if (selectedKey && cache[selectedKey]) openRecord(selectedKey);
    else if (selectedKey) closeDetails();
  } catch (error) {
    console.error("[lightrail-ext] failed to load cached records", error);
    $("recordCount").textContent = error.message || "טעינת המטמון נכשלה";
    $("recordCount").dataset.error = "true";
  } finally {
    $("refreshButton").disabled = false;
  }
}

async function exportCache(format) {
  const buttons = ["exportTxt", "exportCsv", "exportExcel"].map($);
  const status = $("exportStatus");
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  status.dataset.error = "false";
  status.textContent = "מכין את המידע לייצוא…";
  const formatName = format === "excel" ? "Excel" : format.toUpperCase();
  try {
    const stored = await storageGet();
    const progress = (complete, total) => {
      status.textContent = total
        ? `מכין ${formatName}… ${complete.toLocaleString("he-IL")} / ${total.toLocaleString("he-IL")}`
        : `מכין קובץ ${formatName}…`;
    };
    if (format === "excel") {
      LRCacheExport.downloadExcel(await LRCacheExport.buildExcel(stored, progress));
    } else if (format === "csv") {
      LRCacheExport.downloadCsv(await LRCacheExport.buildCsv(stored, progress));
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
    local[CACHE_KEY] = local[CACHE_KEY] && typeof local[CACHE_KEY] === "object"
      ? local[CACHE_KEY]
      : {};
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
    const mergedLocal = mode === "replace"
      ? { ...backup.local }
      : { ...currentLocal, ...backup.local };
    const mergedSync = mode === "replace"
      ? { ...backup.sync }
      : { ...currentSync, ...backup.sync };
    if (mode === "merge") {
      mergedLocal[CACHE_KEY] = {
        ...(currentLocal[CACHE_KEY] || {}),
        ...backup.local[CACHE_KEY],
      };
    }
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
    cache = mergedLocal[CACHE_KEY];
    renderRows();
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
  $(id).addEventListener("input", renderRows);
  $(id).addEventListener("change", renderRows);
}
document.querySelectorAll("[data-range-min], [data-range-max]").forEach((input) => {
  input.addEventListener("input", renderRows);
});
$("clearAdvancedFilters").addEventListener("click", () => {
  document.querySelectorAll("[data-range-min], [data-range-max]").forEach((input) => {
    input.value = "";
  });
  renderRows();
});
$("decreaseFont").addEventListener("click", () => changeFontScale(-FONT_SCALE_STEP));
$("increaseFont").addEventListener("click", () => changeFontScale(FONT_SCALE_STEP));
$("resetFont").addEventListener("click", () => changeFontScale(1 - fontScale));
$("togglePriceHistory").addEventListener("click", (event) => {
  showFullPriceHistory = !showFullPriceHistory;
  expandedPriceHistory.clear();
  const button = event.currentTarget;
  button.textContent = showFullPriceHistory ? "⌃ הצג עד 3 בכל שורה" : "⤢ הצג היסטוריה מלאה";
  button.setAttribute("aria-pressed", String(showFullPriceHistory));
  renderRows();
});
$("listingsTab").addEventListener("click", () => setActiveTab("listings"));
$("priceChangesTab").addEventListener("click", () => setActiveTab("priceChanges"));
$("listingsTab").addEventListener("keydown", handleTabKeydown);
$("priceChangesTab").addEventListener("keydown", handleTabKeydown);
document.querySelectorAll("[data-price-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    priceTimelineFilter = button.dataset.priceFilter;
    renderPriceTimeline();
  });
});
document.querySelectorAll("[data-timeline-min], [data-timeline-max]").forEach((input) => {
  input.addEventListener("input", renderPriceTimeline);
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
$("exportExcel").addEventListener("click", () => exportCache("excel"));
$("clearPriceHistory").addEventListener("click", clearPriceHistories);
$("sortSelect").addEventListener("change", () => {
  if (!$("sortSelect").value) return;
  sort.key = $("sortSelect").value;
  sort.direction = sort.key === "updatedAt" || sort.key === "dealScore" ? -1 : 1;
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
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== refreshTabId) return;
  refreshTabId = null;
  if (refreshQueue.length && !currentPageLoaded) {
    skipRefreshListing(new Error("כרטיסיית הרענון נסגרה לפני טעינת הדף."), true);
  }
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
    };
    for (const key of Object.keys(updated)) {
      if (changes[key]) updated[key] = changes[key].newValue;
    }
    readTimelinePreferences(updated);
    if (timelinePreferencesEnabled) renderPriceTimeline();
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
  if (!changes[CACHE_KEY] || writing) return;
  if (dirtyFields.size) {
    $("saveStatus").textContent = "המטמון השתנה בחלון אחר. רענן לפני שמירה.";
    $("saveStatus").dataset.error = "true";
    return;
  }
  loadCache();
});

initializeTimelineAmenityFilters();
renderHeader();
loadTimelinePreferences();
Promise.all([storageGet(), storageGet(REFRESH_DELAY_KEY), storageGet(FONT_SCALE_KEY)])
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
    const params = new URLSearchParams(location.search);
    if (params.get("scheduledRefresh") === "1") {
      const uncheckedOnly = params.get("uncheckedOnly") === "1";
      history.replaceState(null, "", location.pathname);
      $("refreshScope").value = uncheckedOnly ? "unchecked" : "filtered";
      const schedule = await storageGet(REFRESH_SCHEDULE_KEY);
      if (schedule && schedule.enabled === true) {
        startRefresh({ scheduled: true, uncheckedOnly });
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
