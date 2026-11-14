// רץ בעולם של העמוד (MAIN) באתר הנדל"ן הממשלתי. האתר מוריד בבקשה אחת עד 500 עסקאות לכל תצוגה
// (עיר / שכונה / רחוב / כתובת) ומדפדף ביניהן בדפדפן בלי לפנות שוב לשרת. הסקריפט רק קורא את מה
// שהעמוד כבר הוריד (רכיב DealsComp של Vue) ומעביר לסקריפט התוסף את השדות הדרושים – בלי לפנות
// לשרת, בלי אסימונים ובלי פרטים אישיים.
(() => {
  const FIELDS = ["address", "neighborhoodName", "dealDate", "dealAmount", "assetArea", "roomNum", "floor", "yearBuilt", "buildingFloors", "dealNature", "settlmentID"];
  let lastSignature = "";

  function dealsComponent() {
    const root = document.getElementById("app");
    const start = root && root._vnode;
    if (!start) return null;
    const seen = new Set();
    const stack = [start];
    let steps = 0;
    while (stack.length && steps++ < 5000) {
      const vnode = stack.pop();
      if (!vnode) continue;
      const component = vnode.component;
      if (component && !seen.has(component)) {
        seen.add(component);
        const name = component.type && (component.type.name || component.type.__name);
        if (name === "DealsComp") return component;
        stack.push(component.subTree);
      }
      if (Array.isArray(vnode.children)) for (const child of vnode.children) if (child && typeof child === "object") stack.push(child);
      if (vnode.suspense) stack.push(vnode.suspense.activeBranch);
    }
    return null;
  }

  function send() {
    let component = null;
    try {
      component = dealsComponent();
    } catch {
      return;
    }
    const data = component && component.data;
    const transactions = data && data.transactions;
    if (!Array.isArray(transactions) || !transactions.length) return;
    const first = transactions[0] || {};
    const last = transactions[transactions.length - 1] || {};
    const signature = [transactions.length, data.base_name, data.base_id, first.assetId, first.dealDate, last.assetId, last.dealDate].join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    const deals = transactions.map((deal) => {
      const out = {};
      for (const field of FIELDS) out[field] = deal ? deal[field] : null;
      return out;
    });
    window.postMessage({
      source: "lightrail-nadlan-data",
      deals,
      totalRows: Number(data.total_rows) || null,
      baseName: String(data.base_name || ""),
      baseId: String(data.base_id || ""),
    }, location.origin);
  }

  setInterval(send, 1500);
})();
