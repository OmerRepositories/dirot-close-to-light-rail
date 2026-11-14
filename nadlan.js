// אתר הנדל"ן הממשלתי (nadlan.gov.il): שומר את עסקאות האמת שהעמוד מציג בטבלאות.
// רשות (כבוי כברירת מחדל). התוסף לא פונה ל-API של האתר ולא עוקף שום אימות – הוא קורא רק את מה שהעמוד
// עצמו הציג לגולש, ובלחיצה על "סרוק" לוחץ "הבא" כמו שהגולש היה עושה, בהפרש זמן שהמשתמש בחר.
// נעצר מיד אם העמוד לא מתקדם (למשל אימות מול האתר) – את האימות פותר הגולש בעצמו.
(() => {
  const DEFAULTS = { readNadlan: false, nadlanDelaySeconds: 3, nadlanMaxPages: 20, nadlanStopAfterKnown: 2 };
  const SETTLE_MS = 800;
  const PAGE_WAIT_MS = 12000;
  let cfg = { ...DEFAULTS };
  let observer = null;
  let panel = null;
  let scanning = false;
  let stopRequested = false;
  let readTimer = null;
  const savedKeys = new Set();
  let totals = { found: 0, added: 0, pages: 0 };
  // סריקה מלאה: כל העמודים, בלי מגבלה ובלי עצירה מוקדמת (נבחרת בכפתור, בנפרד מהגדרות הסריקה הרגילה)
  let fullMode = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fmt = (value) => Number(value || 0).toLocaleString("he-IL");

  // העיר והשכונה מכותרות העמוד: "עסקאות בכתובת <רחוב מספר>, <עיר>" ו"עסקאות נוספות בשכונה <שם> לפי רחובות"
  function pageContext() {
    let city = "";
    let neighborhood = "";
    for (const heading of document.querySelectorAll("h1, h2, h3")) {
      const text = heading.textContent.replace(/\s+/g, " ").trim();
      let match = text.match(/^עסקאות בכתובת .+,\s*([^,]+)$/) || text.match(/^עסקאות ביישוב (.+)$/);
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

  // כתיבה לאחסון של עיר גדולה היא כבדה, ולכן בסריקה ארוכה העסקאות נאספות ונכתבות בקבוצות
  const FLUSH_EVERY = 100;
  const FLUSH_MS = 20000;
  let lastFlushAt = Date.now();
  let pending = [];
  let writing = Promise.resolve();
  function flush() {
    if (!pending.length) return writing;
    const items = pending;
    pending = [];
    lastFlushAt = Date.now();
    writing = writing.then(() => LRDeals.saveItems(chrome.storage.local, items)).then((merged) => {
      totals.found += items.length;
      totals.added += merged.added;
      setStatus(`נשמרו ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות) ✓`);
    }, (error) => console.warn("[lightrail-ext] failed to save nadlan deals", error));
    return writing;
  }

  function readTables({ batch = false } = {}) {
    if (!cfg.readNadlan || typeof LRDeals === "undefined") return;
    const context = pageContext();
    if (!context) {
      setStatus("לא זוהתה עיר בעמוד – לא נשמרו עסקאות (נתמכים עמודי כתובת ועמודי יישוב)");
      return;
    }
    for (const table of dealTables()) {
      for (const row of table.querySelectorAll("tbody tr")) {
        const item = LRDeals.fromNadlan(rowCells(row), context);
        if (item && !savedKeys.has(item.key)) {
          savedKeys.add(item.key);
          pending.push(item);
        }
      }
    }
    if (!batch || pending.length >= FLUSH_EVERY || (pending.length && Date.now() - lastFlushAt > FLUSH_MS)) flush();
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

  // עסקאות שהיו שמורות לפני הסריקה (לעיר של העמוד) – כדי לזהות מתי הגענו למה שכבר נאסף
  let known = new Set();
  async function loadKnown() {
    known = new Set();
    const context = pageContext();
    if (!context || typeof LRDeals.loadCity !== "function") return;
    try {
      // "ידוע" = עסקה שכבר נאספה מהאתר הזה בעבר. עסקאות שהגיעו רק מיד2/מדלן לא נחשבות, כי הן מכסות
      // רק חלק מההיסטוריה – אחרת הסריקה הראשונה הייתה נעצרת אחרי כמה עמודים
      const store = await LRDeals.loadCity(chrome.storage.local, context.city);
      known = new Set(Object.keys(store).filter((key) => (store[key].sources || []).includes("nadlan")));
    } catch {}
  }

  // תאריכי העסקאות בעמוד הנוכחי של הטבלה (ISO), וכמה מהן עדיין לא שמורות
  function pageStats(table, context) {
    const dates = [];
    let fresh = 0;
    for (const row of table.querySelectorAll("tbody tr")) {
      const item = LRDeals.fromNadlan(rowCells(row), context);
      if (!item) continue;
      dates.push(item.deal.date);
      if (!known.has(item.key)) fresh++;
    }
    return { dates, fresh };
  }

  async function scanTable(table, index, count) {
    const root = tableRoot(table);
    const maxPages = fullMode ? 1000000 : Math.max(1, Number(cfg.nadlanMaxPages) || 20);
    // 0 = תמיד לעבור על כל העמודים; N = לעצור אחרי N עמודים רצופים בלי עסקאות חדשות (הטבלה ממוינת מהחדש לישן)
    const stopAfter = fullMode ? 0 : Math.max(0, Number(cfg.nadlanStopAfterKnown) || 0);
    const context = pageContext();
    let pages = 1;
    totals.pages++;
    let quietPages = 0;
    let lastDate = "9999-99-99";
    let descending = true;
    while (!stopRequested) {
      if (stopAfter && context && descending) {
        const { dates, fresh } = pageStats(table, context);
        for (const date of dates) {
          if (date > lastDate) descending = false;
          lastDate = date;
        }
        quietPages = fresh ? 0 : quietPages + 1;
        if (descending && quietPages >= stopAfter) {
          readTables({ batch: true });
          return "caught-up";
        }
      }
      readTables({ batch: true });
      const pager = pagerOf(root);
      const next = root.querySelector("button.nextBtn");
      if (!next || next.disabled || (pager && pager.page >= pager.total)) return "done";
      if (pages >= maxPages) return "cap";
      const before = firstRowText(table);
      next.click();
      const startedAt = Date.now();
      while (firstRowText(table) === before) {
        if (stopRequested) return "stopped";
        if (Date.now() - startedAt > PAGE_WAIT_MS) return "stuck";
        await sleep(300);
      }
      pages++;
      totals.pages++;
      setStatus(`טבלה ${index + 1} מתוך ${count} · עמוד ${pages} מתוך ${Math.min(maxPages, pager ? pager.total : maxPages)} · נשמרו ${fmt(totals.found + pending.length)}`);
      await sleep(Math.max(1, Number(cfg.nadlanDelaySeconds) || 3) * 1000);
    }
    return "stopped";
  }

  async function scanAll({ full = false } = {}) {
    if (scanning) return;
    fullMode = full;
    const tables = dealTables();
    if (!tables.length) {
      setStatus("לא נמצאו טבלאות עסקאות בעמוד");
      return;
    }
    scanning = true;
    stopRequested = false;
    renderPanel();
    let outcome = "done";
    let caughtUp = false;
    let capped = false;
    await loadKnown();
    for (let i = 0; i < tables.length && !stopRequested; i++) {
      outcome = await scanTable(tables[i], i, tables.length);
      if (outcome === "caught-up") caughtUp = true;
      if (outcome === "cap") capped = true;
      if (outcome === "stuck") break;
    }
    scanning = false;
    readTables();
    await flush();
    setStatus(
      outcome === "stuck"
        ? `העמוד לא התקדם – נעצרנו (ייתכן שהאתר מבקש אימות). נשמרו ${fmt(totals.found)} עסקאות.`
        : caughtUp && !stopRequested
          ? `הגענו לעסקאות שכבר נאספו מהאתר – הסריקה הסתיימה. נשמרו ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות) ✓`
        : capped && !stopRequested
          ? `נעצרנו במגבלת העמודים (${cfg.nadlanMaxPages}) – יש עוד עמודים בעיר. אפשר להגדיל את המגבלה בחלון התוסף. נשמרו ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות).`
        : stopRequested
          ? `נעצר. נשמרו ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות).`
          : `הסריקה הסתיימה: ${fmt(totals.found)} עסקאות (${fmt(totals.added)} חדשות) ✓`
    );
    renderPanel();
    return outcome === "stuck" ? "stuck" : stopRequested ? "stopped" : capped ? "cap" : caughtUp ? "caught-up" : "done";
  }

  // סריקה מתוזמנת: הרקע פותח את העמוד עם lrScan=1, והעמוד סורק ומדווח בסוף כדי שהלשונית תיסגר
  let autoScanStarted = false;
  function autoScanIfRequested() {
    if (autoScanStarted || !/[?&]lrScan=1(&|$)/.test(location.search)) return;
    autoScanStarted = true;
    (async () => {
      for (let i = 0; i < 40 && !dealTables().length; i++) await sleep(500);
      let outcome = "no-table";
      if (dealTables().length) outcome = await scanAll({ full: /[?&]lrFull=1(&|$)/.test(location.search) });
      try {
        chrome.runtime.sendMessage({ type: "lightrail:nadlan-scan-done", outcome, found: totals.found, added: totals.added, pages: totals.pages });
      } catch {}
    })();
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
    button.textContent = scanning ? "עצור" : "סרוק לפי ההגדרות";
    button.addEventListener("click", () => {
      if (scanning) stopRequested = true;
      else scanAll();
    });
    panel.append(title, statusEl, button);
    if (!scanning) {
      const full = document.createElement("button");
      full.type = "button";
      full.style.cssText = button.style.cssText;
      full.textContent = "רענון מלא – כל העמודים";
      full.title = "עובר על כל עמודי הטבלה, בלי מגבלת עמודים ובלי לעצור כשמגיעים לעסקאות שכבר נאספו";
      full.addEventListener("click", () => scanAll({ full: true }));
      panel.append(full);
    }
  }

  // רשימת היישובים הרשמית של האתר (id, שם, אוכלוסייה) – לבחירת ערים בעמוד הרענון. נטענת פעם בחודש
  const SETTLEMENTS_KEY = "lightrailNadlanSettlements";
  async function ensureSettlementIndex() {
    try {
      const stored = (await chrome.storage.local.get(SETTLEMENTS_KEY))[SETTLEMENTS_KEY];
      if (stored && Array.isArray(stored.items) && stored.items.length && Date.now() - (stored.at || 0) < 30 * 24 * 3600 * 1000) return;
      const response = await fetch("https://data.nadlan.gov.il/api/index/setl_types.json");
      if (!response.ok) return;
      const data = await response.json();
      const items = Object.entries(data)
        .filter(([, value]) => value && value.SETL_NAME)
        .map(([id, value]) => [Number(id), String(value.SETL_NAME), Number(value.POPULATION) || 0])
        .sort((x, y) => y[2] - x[2]);
      if (items.length) await chrome.storage.local.set({ [SETTLEMENTS_KEY]: { at: Date.now(), items } });
    } catch {}
  }

  function start() {
    if (observer) return;
    ensureSettlementIndex();
    renderPanel();
    observer = new MutationObserver(() => {
      if (!scanning) scheduleRead();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleRead();
    autoScanIfRequested();
  }

  // סוגרים את הלשונית באמצע סריקה – שומרים מה שנאסף עד עכשיו
  window.addEventListener("pagehide", () => {
    if (pending.length) flush();
  });

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
