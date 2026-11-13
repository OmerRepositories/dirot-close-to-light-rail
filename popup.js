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
  disableHomeless: false,
  disableKomo: false,
  disableFacebook: false,
  saveListingData: true,
  listingIndexingMode: "encountered",
  indexCities: [],
  indexMinPrice: 0,
  indexMinSqm: 0,
  indexMaxSqm: 0,
  indexMaxPrice: 0,
  requiredAmenities: ["secureRoom"],
  irrelevantMissingPct: 50,
  dealBreakerAmenities: [],
  hideIrrelevant: false,
  showPriceChange: true,
  showListingAge: true,
  hideAds: true,
  blockedStreets: [],
  skipBlockedStreets: false,
  favoriteStreets: [],
  dealsPages: 10,
  showPurchaseTax: true,
  purchaseTaxTrack: "single",
  purchaseTaxTracks: null,
  // נשמרים לתאימות עם 1.31.0 (מסלול "דירה יחידה")
  purchaseTaxExemptUpTo: null,
  purchaseTaxBrackets: null,
};

const DEALS_PAGE_OPTIONS = [0, 1, 2, 3, 5, 10];

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

// popup.html משמש גם כחלון קופץ קטן (תפריט פתיחה) וגם כטופס ההגדרות המלא בתוך עמוד התוסף (?page=1#<קטגוריה>)
const PAGE_MODE = new URLSearchParams(location.search).has("page");
document.documentElement.classList.toggle("page-mode", PAGE_MODE);
document.documentElement.classList.toggle("popup-mode", !PAGE_MODE);

for (const tile of document.querySelectorAll("[data-open]")) {
  tile.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`cache-manager.html#${tile.dataset.open}`) });
    window.close();
  });
}
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

function selectFromHash() {
  const name = location.hash.slice(1);
  const tab = tabs.find((item) => item.getAttribute("aria-controls") === `panel-${name}`);
  if (tab) selectTab(tab);
}
if (PAGE_MODE) {
  selectFromHash();
  window.addEventListener("hashchange", selectFromHash);
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

const numberKeys = ["maxPpsm", "belowMedianPct", "nearM", "indexMinPrice", "indexMaxPrice", "indexMinSqm", "indexMaxSqm"];
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
  "disableHomeless",
  "disableKomo",
  "disableFacebook",
  "saveListingData",
  "hideAds",
  "skipBlockedStreets",
  "hideIrrelevant",
  "showPriceChange",
  "showListingAge",
  "showPurchaseTax",
];

// ---------- מדרגות מס רכישה ----------
const shekel = (value) => `₪${Math.round(value).toLocaleString("he-IL")}`;

// כל המסלולים בזיכרון; העורך מציג את המסלול הנבחר
let taxTracks = LRCacheData.purchaseTaxTracksFrom({});
let taxTrack = "single";

function renderTaxTrack(track) {
  const data = taxTracks[track];
  $("purchaseTaxExemptUpTo").value = String(data.exemptUpTo);
  $("purchaseTaxFlatAbove").value = data.flatAbove ? String(data.flatAbove.threshold) : "";
  $("purchaseTaxFlatRate").value = data.flatAbove ? String(data.flatAbove.rate) : "";
  renderTaxBrackets(data.brackets);
}

// מה שבעורך → המסלול הנבחר בזיכרון
function storeTaxEditor() {
  const exempt = Number($("purchaseTaxExemptUpTo").value);
  const threshold = Number($("purchaseTaxFlatAbove").value);
  const rate = Number($("purchaseTaxFlatRate").value);
  taxTracks[taxTrack] = {
    ...taxTracks[taxTrack],
    exemptUpTo: Number.isFinite(exempt) && exempt >= 0 ? exempt : 0,
    brackets: readTaxBrackets(),
    flatAbove: threshold > 0 && rate >= 0 && $("purchaseTaxFlatRate").value !== "" ? { threshold, rate } : null,
  };
}

function renderTaxBrackets(brackets) {
  const host = $("purchaseTaxBrackets");
  host.replaceChildren();
  brackets.forEach((bracket, index) => {
    const last = index === brackets.length - 1;
    const row = document.createElement("div");
    row.className = "tax-bracket";
    row.dataset.taxRow = String(index);
    // "מ־" ניתן לעריכה: הוא אותו גבול כמו ה"עד" של המדרגה הקודמת (או סכום הפטור במדרגה הראשונה),
    // ולכן שינוי שלו מעדכן גם את השדה ההוא – אין חורים או חפיפות בין מדרגות
    const from = document.createElement("input");
    from.type = "number";
    from.dataset.thousands = "";
    from.dataset.taxFrom = String(index);
    from.min = "0";
    from.className = "tax-from";
    from.setAttribute("aria-label", `מסכום – מדרגה ${index + 1}`);
    from.addEventListener("input", () => {
      const rows = document.querySelectorAll("[data-tax-row]");
      const target = index === 0
        ? $("purchaseTaxExemptUpTo")
        : rows[index - 1].querySelector("[data-tax-up-to]");
      target.value = from.value;
    });
    const upTo = document.createElement("input");
    upTo.type = "number";
    upTo.dataset.thousands = "";
    upTo.dataset.taxUpTo = "";
    upTo.min = "0";
    upTo.setAttribute("aria-label", `עד סכום – מדרגה ${index + 1}`);
    if (last) {
      upTo.disabled = true;
      upTo.placeholder = "ומעלה";
    } else {
      upTo.value = bracket.upTo === null ? "" : String(bracket.upTo);
    }
    const rateWrap = document.createElement("span");
    rateWrap.className = "tax-rate";
    const rate = document.createElement("input");
    rate.type = "number";
    rate.dataset.taxRate = "";
    rate.min = "0";
    rate.max = "100";
    rate.step = "0.1";
    rate.value = String(bracket.rate);
    rate.setAttribute("aria-label", `שיעור המס באחוזים – מדרגה ${index + 1}`);
    rateWrap.append(rate, "%");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tax-remove";
    remove.textContent = "✕";
    remove.title = "מחיקת המדרגה";
    remove.disabled = brackets.length <= 1;
    remove.addEventListener("click", () => {
      const current = readTaxBrackets();
      current.splice(index, 1);
      if (current.length) current[current.length - 1].upTo = null;
      renderTaxBrackets(current);
      save();
    });
    row.append(from, upTo, rateWrap, remove);
    host.appendChild(row);
  });
  if (window.LRNumberInput) LRNumberInput.enhanceAll(host);
  for (const input of host.querySelectorAll("input")) input.addEventListener("input", save);
  updateTaxPreview();
}

function readTaxBrackets() {
  return [...document.querySelectorAll("[data-tax-row]")].map((row, index, rows) => {
    const upTo = Number(row.querySelector("[data-tax-up-to]").value);
    return {
      upTo: index === rows.length - 1 || !(upTo > 0) ? null : upTo,
      rate: Math.max(0, Math.min(100, Number(row.querySelector("[data-tax-rate]").value) || 0)),
    };
  });
}

// "מ־" של כל שורה = ה"עד" של השורה הקודמת (או סכום הפטור), ודוגמה לחישוב
function updateTaxPreview() {
  const exempt = Number($("purchaseTaxExemptUpTo").value) || 0;
  let from = exempt;
  for (const row of document.querySelectorAll("[data-tax-row]")) {
    const fromInput = row.querySelector("[data-tax-from]");
    // לא דורסים את השדה שמקלידים בו עכשיו
    if (document.activeElement !== fromInput) fromInput.value = String(from);
    const upTo = Number(row.querySelector("[data-tax-up-to]").value);
    if (upTo > 0) from = upTo;
  }
  const threshold = Number($("purchaseTaxFlatAbove").value);
  const flatRate = Number($("purchaseTaxFlatRate").value);
  const settings = {
    exemptUpTo: exempt,
    brackets: readTaxBrackets(),
    flatAbove: threshold > 0 && $("purchaseTaxFlatRate").value !== "" ? { threshold, rate: flatRate } : null,
  };
  const example = [2_500_000, 3_500_000]
    .map((price) => {
      const result = LRCacheData.purchaseTax(price, settings);
      return result ? `${shekel(price)} → מס ${shekel(result.tax)} (${result.effectivePct}%), סה״כ ${shekel(result.total)}` : "";
    })
    .filter(Boolean)
    .join(" · ");
  $("purchaseTaxExample").textContent = example ? `לדוגמה: ${example}` : "";
}

function fill(s) {
  for (const k of numberKeys) $(k).value = s[k] ? s[k] : k === "nearM" ? s[k] : "";
  for (const k of boolKeys) $(k).checked = Boolean(s[k]);
  $("listingIndexingMode").value =
    s.listingIndexingMode === "opened" ? "opened" : "encountered";
  $("dealsPages").value = String(DEALS_PAGE_OPTIONS.includes(Number(s.dealsPages)) ? Number(s.dealsPages) : 10);
  const missingPct = String(Number.isFinite(Number(s.irrelevantMissingPct)) ? Number(s.irrelevantMissingPct) : 50);
  $("irrelevantMissingPct").value = [...$("irrelevantMissingPct").options].some((o) => o.value === missingPct)
    ? missingPct
    : "50";
  const required = Array.isArray(s.requiredAmenities)
    ? s.requiredAmenities
    : DEFAULTS.requiredAmenities;
  for (const input of document.querySelectorAll("[data-amenity]")) {
    input.checked = required.includes(input.dataset.amenity);
  }
  const breakers = Array.isArray(s.dealBreakerAmenities) ? s.dealBreakerAmenities : [];
  for (const input of document.querySelectorAll("[data-deal-breaker]")) {
    input.checked = breakers.includes(input.dataset.dealBreaker);
  }
  // לא דורסים את מה שהמשתמש מקליד כרגע (השמירה האוטומטית מחזירה את הערך המנוקה)
  if (document.activeElement !== $("blockedStreets")) {
    $("blockedStreets").value = (Array.isArray(s.blockedStreets) ? s.blockedStreets : []).join("\n");
  }
  if (document.activeElement !== $("favoriteStreets")) {
    $("favoriteStreets").value = (Array.isArray(s.favoriteStreets) ? s.favoriteStreets : []).join("\n");
  }
  renderFavoriteStreetSuggestions(Array.isArray(s.favoriteStreets) ? s.favoriteStreets : []);
  if (document.activeElement !== $("indexCities")) {
    $("indexCities").value = (Array.isArray(s.indexCities) ? s.indexCities : []).join("\n");
  }
  // לא בונים מחדש את המדרגות בזמן שמקלידים בהן (השמירה האוטומטית מחזירה אותן)
  if (!$("purchaseTaxSettings").contains(document.activeElement)) {
    taxTracks = LRCacheData.purchaseTaxTracksFrom(s);
    taxTrack = LRCacheData.PURCHASE_TAX_TRACK_KEYS.includes(s.purchaseTaxTrack) ? s.purchaseTaxTrack : "single";
    $("purchaseTaxTrack").value = taxTrack;
    renderTaxTrack(taxTrack);
  }
  syncDisabled();
}

// הצעות לרחובות מועדפים: הרחובות של המודעות שסימנת בלב (♥), הנפוצים קודם, שעוד לא ברשימה.
// לחיצה מוסיפה לרשימה.
let suggestionsFor = "";
function renderFavoriteStreetSuggestions(current) {
  const host = $("favoriteStreetSuggestions");
  if (!host) return;
  const signature = JSON.stringify(current);
  if (signature === suggestionsFor) return;
  suggestionsFor = signature;
  const rules = LRStreetFilter.parseRules(current);
  LRListingStore.read(chrome.storage.local).then((cache) => {
    const counts = new Map();
    for (const record of Object.values(cache)) {
      if (!record || record.favorite !== true) continue;
      const street = String(record.address || "").split(",")[0].replace(/\s+\d{1,4}\s*[א-ת]?\s*$/, "").trim();
      if (!street || LRStreetFilter.match(rules, street, record.city || "")) continue;
      const line = record.city ? `${street}, ${record.city}` : street;
      counts.set(line, (counts.get(line) || 0) + 1);
    }
    const lines = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
    host.replaceChildren();
    host.hidden = !lines.length;
    if (!lines.length) return;
    const title = document.createElement("span");
    title.className = "small";
    title.textContent = "הצעות מהמודעות שבמועדפים:";
    host.append(title);
    for (const [line, count] of lines) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "street-chip";
      chip.textContent = `+ ${line}${count > 1 ? ` (${count})` : ""}`;
      chip.title = "הוספה לרחובות המועדפים";
      chip.addEventListener("click", () => {
        const area = $("favoriteStreets");
        area.value = [...LRStreetFilter.parseInput(area.value), line].join("\n");
        save();
        renderFavoriteStreetSuggestions(LRStreetFilter.parseInput(area.value));
      });
      host.append(chip);
    }
  }).catch(() => {});
}

// כשמבטלים את הדרישה לרכבת, שדה המרחק לא רלוונטי
function syncDisabled() {
  const calculatePpsm = $("calculatePpsm").checked;
  const calculateRail = $("calculateRail").checked;
  $("ppsmSettings").disabled = !calculatePpsm;
  $("railSettings").disabled = !calculateRail;
  $("nearM").disabled = !$("requireRail").checked;
  $("listingIndexingMode").disabled = !$("saveListingData").checked;
  $("indexMaxPriceField").hidden = $("listingIndexingMode").value !== "encountered";
  $("indexMinPrice").disabled = !$("saveListingData").checked;
  $("indexCities").disabled = !$("saveListingData").checked;
  $("indexMaxPrice").disabled = !$("saveListingData").checked;
  $("indexMinSqm").disabled = !$("saveListingData").checked;
  $("indexMaxSqm").disabled = !$("saveListingData").checked;
  $("dealsPages").disabled = !$("saveListingData").checked;
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
  out.dealsPages = DEALS_PAGE_OPTIONS.includes(Number($("dealsPages").value)) ? Number($("dealsPages").value) : 10;
  out.irrelevantMissingPct = Number($("irrelevantMissingPct").value) || 0;
  out.requiredAmenities = [...document.querySelectorAll("[data-amenity]:checked")].map(
    (input) => input.dataset.amenity
  );
  out.dealBreakerAmenities = [...document.querySelectorAll("[data-deal-breaker]:checked")].map(
    (input) => input.dataset.dealBreaker
  );
  out.blockedStreets = LRStreetFilter.parseInput($("blockedStreets").value);
  out.favoriteStreets = LRStreetFilter.parseInput($("favoriteStreets").value);
  out.indexCities = LRStreetFilter.parseInput($("indexCities").value);
  storeTaxEditor();
  out.purchaseTaxTrack = taxTrack;
  out.purchaseTaxTracks = Object.fromEntries(
    Object.entries(taxTracks).map(([key, track]) => [key, { exemptUpTo: track.exemptUpTo, brackets: track.brackets, flatAbove: track.flatAbove }])
  );
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
  updateTaxPreview();
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
$("dealsPages").addEventListener("change", save);
$("irrelevantMissingPct").addEventListener("change", save);
$("blockedStreets").addEventListener("input", save);
$("favoriteStreets").addEventListener("input", save);
$("indexCities").addEventListener("input", save);
$("purchaseTaxExemptUpTo").addEventListener("input", save);
$("purchaseTaxFlatAbove").addEventListener("input", save);
$("purchaseTaxFlatRate").addEventListener("input", save);
$("purchaseTaxTrack").addEventListener("change", () => {
  storeTaxEditor();
  taxTrack = $("purchaseTaxTrack").value;
  renderTaxTrack(taxTrack);
  save();
});
$("addTaxBracket").addEventListener("click", () => {
  // מדרגה חדשה נכנסת לפני המדרגה הפתוחה ("ומעלה"), עם גבול מעל המדרגה הקודמת
  const brackets = readTaxBrackets();
  const open = brackets.pop() || { upTo: null, rate: 0 };
  const previous = brackets.length ? brackets[brackets.length - 1].upTo : Number($("purchaseTaxExemptUpTo").value) || 0;
  brackets.push({ upTo: Math.round((previous || 0) * 1.5) || 1_000_000, rate: open.rate }, open);
  renderTaxBrackets(brackets);
  save();
});
$("resetPurchaseTax").addEventListener("click", () => {
  // מחזיר רק את סוג הרוכש שנבחר לערכים המקוריים
  const original = LRCacheData.purchaseTaxTracksFrom({})[taxTrack];
  taxTracks[taxTrack] = original;
  renderTaxTrack(taxTrack);
  save();
});

function amenityOption(key, label, dataKey) {
  const option = document.createElement("label");
  option.className = "amenity-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset[dataKey] = key;
  const text = document.createElement("span");
  text.textContent = label;
  option.append(input, text);
  return { option, input };
}

// דיל ברייקר תמיד גם מאפיין חובה: סימון דיל ברייקר מסמן חובה, וביטול חובה מבטל את הדיל ברייקר
for (const [key, label] of AMENITIES) {
  const required = amenityOption(key, label, "amenity");
  const breaker = amenityOption(key, label, "dealBreaker");
  required.input.addEventListener("change", () => {
    if (!required.input.checked) breaker.input.checked = false;
    save();
  });
  breaker.input.addEventListener("change", () => {
    if (breaker.input.checked) required.input.checked = true;
    save();
  });
  $("requiredAmenities").appendChild(required.option);
  $("dealBreakerAmenities").appendChild(breaker.option);
}

$("reset").addEventListener("click", () => {
  fill(DEFAULTS);
  chrome.storage.sync.set(
    {
      ...DEFAULTS,
      requiredAmenities: [...DEFAULTS.requiredAmenities],
      dealBreakerAmenities: [],
      blockedStreets: [],
      favoriteStreets: [],
      indexCities: [],
      purchaseTaxTracks: null,
      purchaseTaxExemptUpTo: null,
      purchaseTaxBrackets: null,
    },
    () => flash("✓ אופס")
  );
});

function updateCacheStatus() {
  LRListingStore.read(chrome.storage.local).then((cache) => {
    const status = $("cacheStatus");
    const now = Date.now();
    const records = Object.values(cache).filter(
      (record) =>
        record &&
        Number.isFinite(record.updatedAt) &&
        now - record.updatedAt < LISTING_CACHE_TTL_MS
    );
    status.textContent = `${records.length} מודעות שמורות`;
    $("launcherCount").textContent = `${records.length.toLocaleString("he-IL")} מודעות שמורות · חיפוש ושינויי מחירים`;
    status.dataset.error = "false";
  }, () => {
    const status = $("cacheStatus");
    status.textContent = "לא ניתן לקרוא את המטמון";
    status.dataset.error = "true";
  });
}

$("clearListingCache").addEventListener("click", () => {
  $("clearListingCache").disabled = true;
  chrome.storage.local.remove(LRListingStore.ALL_KEYS, () => {
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

chrome.storage.local.onChanged.addListener((changes) => {
  if (Object.keys(changes).some(LRListingStore.isCacheKey)) updateCacheStatus();
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
    const stored = await LRListingStore.read(chrome.storage.local);
    const count = Object.keys(stored).length;
    const formatName = format === "excel" ? "Excel" : format.toUpperCase();
    const progress = (complete, total) => {
      status.textContent = total
        ? `מכין ${formatName}… ${complete.toLocaleString("he-IL")} / ${total.toLocaleString("he-IL")}`
        : `מכין קובץ ${formatName}…`;
    };
    if (format === "excel") {
      // עסקאות האמת של כל הערים לגיליון "עסקאות"
      const deals = await LRDeals.loadAll(chrome.storage.local).catch(() => ({}));
      const excel = await LRCacheExport.buildExcel(stored, progress, Date.now(), deals);
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
