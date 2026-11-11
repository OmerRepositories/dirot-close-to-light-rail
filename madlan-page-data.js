// רץ בתוך הדף של מדלן (world: "MAIN"). טבלת "היסטוריית עסקאות" נטענת אחרי הדף (GraphQL) ולא נמצאת
// בנתוני הדף; השורות זמינות רק דרך React. כאן מעתיקים לטבלה (data-lr-deals) את העסקאות שהיא מציגה,
// רק השדות שצריך – בלי מוכר/קונה – כדי שסקריפט התוכן הרגיל ישמור אותן.
//
// הטבלה מציגה לשונית אחת בכל פעם: "בבניין וברחוב" או "בפרויקט" כברירת מחדל, ו"בסביבה" (עד 1000 עסקאות)
// נטענת רק בלחיצה. לכן, אחרי שהלשונית הראשונה נטענה ונשמרה, עוברים פעם אחת ל"בסביבה", מחכים שהעסקאות
// שלה ייטענו וחוזרים ללשונית המקורית. רק כשהטבלה לא על המסך, כדי לא להזיז משהו מול המשתמש.
(() => {
  const FIELDS = ["action", "isFinal", "address", "date", "price", "size", "beds", "floor", "totalFloors", "year"];
  const AREA_WAIT_MS = 10_000;
  let areaDoneFor = "";
  let areaRunning = false;

  function rowsFor(table) {
    const row = table.querySelector('[data-auto^="table-row-"]');
    if (!row) return null;
    const key = Object.keys(row).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? row[key] : null;
    for (let step = 0; fiber && step < 30; step++, fiber = fiber.return) {
      const data = fiber.memoizedProps && fiber.memoizedProps.data;
      if (Array.isArray(data) && data.length && data[0] && typeof data[0] === "object" && "action" in data[0]) return data;
    }
    return null;
  }

  // העסקאות מצטברות לכל מודעה מכל הלשוניות שנטענו: כשחוזרים ללשונית המקורית, עסקאות "בסביבה"
  // לא נמחקות מה-attribute לפני שסקריפט התוכן הספיק לשמור אותן
  let capturedFor = "";
  let captured = new Map();
  // אותן שורות (אותו מערך של React) באותה מודעה – אין מה לחשב שוב. הסריקה רצה בכל גלילה ושינוי בדף,
  // ובלי זה כל פעם הומרו לטקסט עד 1000 עסקאות
  let lastRows = null;
  let lastTable = null;

  function scan() {
    const table = document.querySelector('[data-auto="sold-listings-table"]');
    if (!table) return null;
    const rows = rowsFor(table);
    if (!rows) return null;
    if (rows === lastRows && table === lastTable && capturedFor === location.pathname && table.hasAttribute("data-lr-deals")) {
      return { table, rows };
    }
    lastRows = rows;
    lastTable = table;
    if (capturedFor !== location.pathname) {
      capturedFor = location.pathname;
      captured = new Map();
    }
    for (const row of rows) {
      if (!row || row.action !== "sale" || row.isFinal === false) continue;
      const deal = Object.fromEntries(FIELDS.map((field) => [field, row[field] ?? null]));
      captured.set(JSON.stringify(deal), deal);
    }
    const json = JSON.stringify([...captured.values()]);
    if (table.getAttribute("data-lr-deals") !== json) table.setAttribute("data-lr-deals", json);
    return { table, rows };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function inView(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }

  // הלשונית שמוצגת עכשיו: מבין הלשוניות שאינן "בסביבה", זו שהעיצוב שלה שונה מ"בסביבה" (שאינה נבחרת)
  function currentTab(table, areaTab) {
    const tabs = [...table.querySelectorAll('[data-auto="building"], [data-auto="project"]')];
    return tabs.find((tab) => tab.className !== areaTab.className) || tabs[0] || null;
  }

  async function loadAreaTab(state) {
    const { table } = state;
    const listing = location.pathname;
    if (areaRunning || areaDoneFor === listing) return;
    const areaTab = table.querySelector('[data-auto="area"]');
    if (!areaTab) {
      areaDoneFor = listing;
      document.documentElement.setAttribute("data-lr-deals-area-done", listing);
      return;
    }
    // הלשונית הראשונה כבר נטענה (יש לה שורות) ונשמרה – רק אז עוברים
    if (!table.hasAttribute("data-lr-deals") || inView(table)) return;
    const original = currentTab(table, areaTab);
    if (!original || original === areaTab) return;
    areaRunning = true;
    // סקריפט התוכן קורא את זה כדי שרענון אוטומטי לא יעבור למודעה הבאה באמצע
    document.documentElement.setAttribute("data-lr-deals-busy", "area");
    try {
      const before = state.rows;
      areaTab.click();
      // מחכים שהשורות יתחלפו בשורות של "בסביבה"
      const started = Date.now();
      let switched = null;
      while (Date.now() - started < AREA_WAIT_MS) {
        await sleep(400);
        const current = document.querySelector('[data-auto="sold-listings-table"]');
        const rows = current && rowsFor(current);
        if (rows && rows !== before) {
          switched = rows;
          break;
        }
      }
      if (switched) scan(); // שומר את עסקאות "בסביבה"
      await sleep(300);
      const again = document.querySelector('[data-auto="sold-listings-table"]');
      const back = again && again.querySelector(`[data-auto="${original.dataset.auto}"]`);
      if (back) back.click();
      areaDoneFor = listing;
    } finally {
      areaRunning = false;
      document.documentElement.removeAttribute("data-lr-deals-busy");
      document.documentElement.setAttribute("data-lr-deals-area-done", areaDoneFor);
    }
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        if (areaRunning) return;
        const state = scan();
        if (state) loadAreaTab(state);
      } catch (error) {
        console.warn("[lightrail-ext] deals scan failed", error);
      }
    }, 500);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  // הטבלה עשויה להיות על המסך בטעינה – כשהמשתמש גולל ממנה והלאה, מנסים שוב
  window.addEventListener("scroll", schedule, { passive: true });
  schedule();
})();
