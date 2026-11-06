// חלון ההגדרות: שומר אוטומטית ל-chrome.storage.sync. ה-content script מאזין לשינויים ומתעדכן מיד.
const DEFAULTS = {
  maxPpsm: 0,
  belowMedianPct: 10,
  calculatePpsm: true,
  calculateRail: true,
  requireRail: true,
  nearM: 800,
  highlight: true,
  avoidBrokerage: false,
  removeBrokerage: false,
  removeProjects: false,
  disableYad2: false,
  disableMadlan: false,
  disableFacebook: false,
  saveListingData: true,
  listingIndexingMode: "encountered",
  requiredAmenities: ["secureRoom"],
  hideAds: true,
  blockedStreets: [],
};

const AMENITIES = [
  ["parking", "חניה"],
  ["secureRoom", "ממ״ד"],
  ["elevator", "מעלית"],
  ["storage", "מחסן"],
  ["airConditioner", "מיזוג אוויר"],
  ["accessible", "נגיש לנכים"],
  ["balcony", "מרפסת"],
  ["sunBoiler", "דוד שמש"],
  ["grating", "סורגים"],
  ["garden", "גינה"],
  ["pool", "בריכה"],
];

const $ = (id) => document.getElementById(id);
const LISTING_CACHE_KEY = "yad2AmenityCache_v1";
const LISTING_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(item.getAttribute("aria-controls"));
    panel.hidden = !selected;
  }
  if (focus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    let nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowRight") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[nextIndex], true);
  });
}

const numberKeys = ["maxPpsm", "belowMedianPct", "nearM"];
const boolKeys = [
  "requireRail",
  "calculatePpsm",
  "calculateRail",
  "highlight",
  "avoidBrokerage",
  "removeBrokerage",
  "removeProjects",
  "disableYad2",
  "disableMadlan",
  "disableFacebook",
  "saveListingData",
  "hideAds",
];

function fill(s) {
  for (const k of numberKeys) $(k).value = s[k] ? s[k] : k === "nearM" ? s[k] : "";
  for (const k of boolKeys) $(k).checked = Boolean(s[k]);
  $("listingIndexingMode").value =
    s.listingIndexingMode === "opened" ? "opened" : "encountered";
  const required = Array.isArray(s.requiredAmenities)
    ? s.requiredAmenities
    : DEFAULTS.requiredAmenities;
  for (const input of document.querySelectorAll("[data-amenity]")) {
    input.checked = required.includes(input.dataset.amenity);
  }
  // לא דורסים את מה שהמשתמש מקליד כרגע (השמירה האוטומטית מחזירה את הערך המנוקה)
  if (document.activeElement !== $("blockedStreets")) {
    $("blockedStreets").value = (Array.isArray(s.blockedStreets) ? s.blockedStreets : []).join("\n");
  }
  syncDisabled();
}

// כשמבטלים את הדרישה לרכבת, שדה המרחק לא רלוונטי
function syncDisabled() {
  const calculatePpsm = $("calculatePpsm").checked;
  const calculateRail = $("calculateRail").checked;
  $("ppsmSettings").disabled = !calculatePpsm;
  $("railSettings").disabled = !calculateRail;
  $("nearM").disabled = !$("requireRail").checked;
  $("listingIndexingMode").disabled = !$("saveListingData").checked;
}

function read() {
  const out = {};
  for (const k of numberKeys) {
    const n = Number($(k).value);
    out[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (!out.nearM) out.nearM = DEFAULTS.nearM;
  out.belowMedianPct = Math.min(out.belowMedianPct, 90);
  for (const k of boolKeys) out[k] = $(k).checked;
  out.listingIndexingMode =
    $("listingIndexingMode").value === "opened" ? "opened" : "encountered";
  out.requiredAmenities = [...document.querySelectorAll("[data-amenity]:checked")].map(
    (input) => input.dataset.amenity
  );
  out.blockedStreets = LRStreetFilter.parseInput($("blockedStreets").value);
  return out;
}

let statusTimer = null;
function flash(msg) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1500);
}

let saveTimer = null;
function save() {
  syncDisabled();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set(read(), () => flash("✓ נשמר"));
  }, 250);
}

chrome.storage.sync.get(DEFAULTS, (s) => fill(s));

for (const k of [...numberKeys, ...boolKeys]) {
  $(k).addEventListener("input", save);
  $(k).addEventListener("change", save);
}
$("listingIndexingMode").addEventListener("change", save);
$("blockedStreets").addEventListener("input", save);

for (const [key, label] of AMENITIES) {
  const option = document.createElement("label");
  option.className = "amenity-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.amenity = key;
  input.addEventListener("change", save);
  const text = document.createElement("span");
  text.textContent = label;
  option.append(input, text);
  $("requiredAmenities").appendChild(option);
}

$("reset").addEventListener("click", () => {
  fill(DEFAULTS);
  chrome.storage.sync.set(
    { ...DEFAULTS, requiredAmenities: [...DEFAULTS.requiredAmenities], blockedStreets: [] },
    () => flash("✓ אופס")
  );
});

function updateCacheStatus() {
  chrome.storage.local.get(LISTING_CACHE_KEY, (stored) => {
    const status = $("cacheStatus");
    if (chrome.runtime.lastError) {
      status.textContent = "לא ניתן לקרוא את המטמון";
      status.dataset.error = "true";
      return;
    }
    const now = Date.now();
    const records = Object.values(stored[LISTING_CACHE_KEY] || {}).filter(
      (record) =>
        record &&
        Number.isFinite(record.updatedAt) &&
        now - record.updatedAt < LISTING_CACHE_TTL_MS
    );
    status.textContent = `${records.length} מודעות שמורות`;
    status.dataset.error = "false";
  });
}

$("clearListingCache").addEventListener("click", () => {
  $("clearListingCache").disabled = true;
  chrome.storage.local.remove(LISTING_CACHE_KEY, () => {
    $("clearListingCache").disabled = false;
    const status = $("cacheStatus");
    if (chrome.runtime.lastError) {
      status.textContent = "המחיקה נכשלה";
      status.dataset.error = "true";
      console.error("[lightrail-ext] failed to clear listing cache", chrome.runtime.lastError.message);
      return;
    }
    status.textContent = "המידע על המודעות נמחק";
    status.dataset.error = "false";
    setTimeout(updateCacheStatus, 1800);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[LISTING_CACHE_KEY]) updateCacheStatus();
});

updateCacheStatus();

$("openCacheManager").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("cache-manager.html") });
});

async function exportListingCache(format) {
  const buttons = [
    $("exportListingCacheTxt"),
    $("exportListingCacheCsv"),
    $("exportListingCacheExcel"),
  ];
  const status = $("exportStatus");
  const spinner = $("exportSpinner");
  buttons.forEach((button) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  status.dataset.error = "false";
  status.textContent = "טוען נתוני מטמון…";
  spinner.hidden = false;

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = await new Promise((resolve, reject) => {
      chrome.storage.local.get(LISTING_CACHE_KEY, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result && result[LISTING_CACHE_KEY] ? result[LISTING_CACHE_KEY] : {});
      });
    });
    const count = Object.keys(stored).length;
    const formatName = format === "excel" ? "Excel" : format.toUpperCase();
    const progress = (complete, total) => {
      status.textContent = total
        ? `מכין ${formatName}… ${complete.toLocaleString("he-IL")} / ${total.toLocaleString("he-IL")}`
        : `מכין קובץ ${formatName}…`;
    };
    if (format === "excel") {
      const excel = await LRCacheExport.buildExcel(stored, progress);
      LRCacheExport.downloadExcel(excel);
    } else if (format === "csv") {
      const csv = await LRCacheExport.buildCsv(stored, progress);
      LRCacheExport.downloadCsv(csv);
    } else {
      const txt = await LRCacheExport.buildTxt(stored, progress);
      LRCacheExport.downloadTxt(txt);
    }
    status.textContent = `הייצוא הושלם · ${count.toLocaleString("he-IL")} רשומות`;
  } catch (error) {
    console.error("[lightrail-ext] failed to export listing cache", error);
    status.dataset.error = "true";
    status.textContent = "ייצוא הנתונים נכשל";
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
    spinner.hidden = true;
  }
}

$("exportListingCacheCsv").addEventListener("click", () => exportListingCache("csv"));
$("exportListingCacheExcel").addEventListener("click", () => exportListingCache("excel"));
$("exportListingCacheTxt").addEventListener("click", () => exportListingCache("txt"));
