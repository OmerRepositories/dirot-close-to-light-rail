// רץ בתוך הדף של מדלן (world: "MAIN"). טבלת "היסטוריית עסקאות" נטענת אחרי הדף (GraphQL) ולא נמצאת
// בנתוני הדף; השורות זמינות רק דרך React. כאן מעתיקים לטבלה (data-lr-deals) את העסקאות שהיא מציגה,
// רק השדות שצריך – בלי מוכר/קונה – כדי שסקריפט התוכן הרגיל ישמור אותן.
(() => {
  const FIELDS = ["action", "isFinal", "address", "date", "price", "size", "beds", "floor", "totalFloors", "year"];

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

  function scan() {
    const table = document.querySelector('[data-auto="sold-listings-table"]');
    if (!table) return;
    const rows = rowsFor(table);
    if (!rows) return;
    const deals = rows
      .filter((row) => row && row.action === "sale" && row.isFinal !== false)
      .map((row) => Object.fromEntries(FIELDS.map((field) => [field, row[field] ?? null])));
    const json = JSON.stringify(deals);
    if (table.getAttribute("data-lr-deals") !== json) table.setAttribute("data-lr-deals", json);
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { scan(); } catch (error) { console.warn("[lightrail-ext] deals scan failed", error); }
    }, 500);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
