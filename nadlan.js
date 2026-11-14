// אתר הנדל"ן הממשלתי (nadlan.gov.il): שומר את עסקאות האמת שהעמוד מציג בטבלאות.
// רשות (כבוי כברירת מחדל). התוסף לא פונה ל-API של האתר ולא עוקף שום אימות – הוא קורא רק את מה שהעמוד
// עצמו הציג לגולש, ובלחיצה על "סרוק" לוחץ "הבא" כמו שהגולש היה עושה, בהפרש זמן שהמשתמש בחר.
// נעצר מיד אם העמוד לא מתקדם (למשל אימות מול האתר) – את האימות פותר הגולש בעצמו.
(() => {
  const DEFAULTS = { readNadlan: false, nadlanDelaySeconds: 3, nadlanMaxPages: 20 };
  const SETTLE_MS = 800;
  const PAGE_WAIT_MS = 12000;
  let cfg = { ...DEFAULTS };
  let observer = null;
  let panel = null;
  let scanning = false;
  let stopRequested = false;
  let readTimer = null;
  const savedKeys = new Set();
  let totals = { found: 0, added: 0 };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fmt = (value) => Number(value || 0).toLocaleString("he-IL");

  // העיר והשכונה מכותרות העמוד: "עסקאות בכתובת <רחוב מספר>, <עיר>" ו"עסקאות נוספות בשכונה <שם> לפי רחובות"
  function pageContext() {
    let city = "";
    let neighborhood = "";
    for (const heading of document.querySelectorAll("h1, h2, h3")) {
      const text = heading.textContent.replace(/\s+/g, " ").trim();
      let match = text.match(/^עסקאות בכתובת .+,\s*([^,]+)$/);
      if (match && !city) city = match[1].trim();
      match = text.match(/^עסקאות נוספות בשכונה (.+?) לפי רחובות$/);
      if (match && !neighborhood) neighborhood = match[1].trim();
    }
    return city ? { city, neighborhood } : null;
  }

  function dealTables() {
    return [...document.querySelectorAll("table")].filter((table) => {
      const head = [...table.querySelectorAll("th")].map((cell) => cell.textContent.trim());
      return head.includes("תאריך העסקה") && head.includes("מחיר העסקה");
    });
  }

  const rowCells = (row) => [...row.children].map((cell) => cell.textContent.replace(/\s+/g, " ").trim());

  function readTables() {
    if (!cfg.readNadlan || typeof LRDeals === "undefined") return;
    const context = pageContext();
    if (!context) {
      setStatus("לא זוהתה עיר בעמוד – לא נשמרו עסקאות (נתמכים עמודי כתובת)");
      return;
    }
    const items = [];
    for (const table of dealTables()) {
      for (const row of table.querySelectorAll("tbody tr")) {
        const item = LRDeals.fromNadlan(rowCells(row), context);
        if (item && !savedKeys.has(item.key)) items.push(item);
      }
    }
    if (!items.length) return;
    for (const item of items) savedKeys.add(item.key);
    LRDeals.saveItems(chrome.storage.local, items).then((merged) => {
      totals.found += items.length;
      totals.added += merged.added;
      setStatus(`נשמרו ${fmt(totals.found)} עסקאות בעמוד הזה (${fmt(totals.added)} חדשות) ✓`);
    }, (error) => console.warn("[lightrail-ext] failed to save nadlan deals", error));
  }

  function scheduleRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(readTables, SETTLE_MS);
  }

  // ---------- סריקה אוטומטית של עמודי הטבלאות ----------
  const tableRoot = (table) => (table.parentElement && table.parentElement.parentElement) || table;
  const firstRowText = (table) => {
    const row = table.querySelector("tbody tr");
    return row ? row.textContent.replace(/\s+/g, " ").trim() : "";
  };
  function pagerOf(root) {
    for (const element of root.querySelectorAll("*")) {
      if (element.children.length) continue;
      const match = element.textContent.trim().match(/^(\d+) \/ (\d+)$/);
      if (match) return { page: Number(match[1]), total: Number(match[2]) };
    }
    return null;
  }

  async function scanTable(table, index, count) {
    const root = tableRoot(table);
    const maxPages = Math.max(1, Number(cfg.nadlanMaxPages) || 20);
    let pages = 1;
    while (!stopRequested) {
      readTables();
      const pager = pagerOf(root);
      const next = root.querySelector("button.nextBtn");
      if (!next || next.disabled || (pager && pager.page >= pager.total) || pages >= maxPages) return "done";
      const before = firstRowText(table);
      next.click();
      const startedAt = Date.now();
      while (firstRowText(table) === before) {
        if (stopRequested) return "stopped";
        if (Date.now() - startedAt > PAGE_WAIT_MS) return "stuck";
        await sleep(300);
      }
      pages++;
      setStatus(`טבלה ${index + 1} מתוך ${count} · עמוד ${pages}${pager ? ` מתוך ${pager.total}` : ""} · נשמרו ${fmt(totals.found)}`);
      await sleep(Math.max(1, Number(cfg.nadlanDelaySeconds) || 3) * 1000);
    }
    return "stopped";
  }

  async function scanAll() {
    if (scanning) return;
    const tables = dealTables();
    if (!tables.length) {
      setStatus("לא נמצאו טבלאות עסקאות בעמוד");
      return;
    }
    scanning = true;
    stopRequested = false;
    renderPanel();
    let outcome = "done";
    for (let i = 0; i < tables.length && !stopRequested; i++) {
      outcome = await scanTable(tables[i], i, tables.length);
      if (outcome === "stuck") break;
    }
    scanning = false;
    readTables();
    setStatus(
      outcome === "stuck"
        ? `העמוד לא התקדם – נעצרנו (ייתכן שהאתר מבקש אימות). נשמרו ${fmt(totals.found)} עסקאות.`
        : stopRequested
          ? `נעצר. נשמרו ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות).`
          : `הסריקה הסתיימה: ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות) ✓`
    );
    renderPanel();
  }

  // ---------- חלון קטן בפינה ----------
  let statusEl = null;
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }
  function renderPanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.dir = "rtl";
      panel.style.cssText =
        "position:fixed;bottom:12px;left:12px;z-index:2147483000;background:#1f2937;color:#fff;font:13px/1.4 system-ui,Arial,sans-serif;" +
        "padding:10px 12px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:320px;display:flex;flex-direction:column;gap:6px";
      document.body.appendChild(panel);
    }
    panel.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "קרבה לרכבת הקלה – קריאת עסקאות";
    statusEl = document.createElement("div");
    statusEl.textContent = "העסקאות שמוצגות בטבלאות נשמרות אוטומטית.";
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText = "padding:5px 10px;border-radius:6px;border:0;cursor:pointer;font:inherit";
    button.textContent = scanning ? "עצור" : "סרוק את כל עמודי הטבלאות";
    button.addEventListener("click", () => {
      if (scanning) stopRequested = true;
      else scanAll();
    });
    panel.append(title, statusEl, button);
  }

  function start() {
    if (observer) return;
    renderPanel();
    observer = new MutationObserver(() => {
      if (!scanning) scheduleRead();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleRead();
  }

  function stop() {
    stopRequested = true;
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(readTimer);
    if (panel) panel.remove();
    panel = null;
    statusEl = null;
  }

  function apply() {
    if (cfg.readNadlan) start();
    else stop();
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cfg = { ...DEFAULTS, ...(stored || {}) };
    apply();
  });
  chrome.storage.sync.onChanged.addListener((changes) => {
    for (const key of Object.keys(DEFAULTS)) if (changes[key]) cfg[key] = changes[key].newValue;
    apply();
  });
})();
