// רץ בתוך הדף של יד2 (world: "MAIN"), כי רק משם אפשר לקרוא את הנתונים ש-React מחזיק לכל כרטיס.
// למה: כשעוברים לעמוד 2 ואילך בלי טעינה מחדש, __NEXT_DATA__ נשאר של העמוד הראשון (2 מתוך 44 כרטיסים),
// ואז התוסף נאלץ לנחש מחיר, שטח, תיווך ומיקום מהטקסט. כאן מעתיקים לכל קישור מודעה את הנתונים שלה
// כ-attribute (data-lr-item), שסקריפט התוכן הרגיל (yad2.js) קורא. רק שדות לא אישיים – בלי שם המפרסם,
// טלפון או טקסט חופשי.
(() => {
  const ID_RE = /\/realestate\/item\/[^/]+\/([^/?#]+)/;
  const MAX_FIBER_STEPS = 25;

  function itemFor(link, id) {
    const key = Object.keys(link).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? link[key] : null;
    for (let step = 0; fiber && step < MAX_FIBER_STEPS; step++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") continue;
      for (const value of Object.values(props)) {
        if (value && typeof value === "object" && String(value.token) === id && value.address) return value;
      }
    }
    return null;
  }

  const text = (part) => (part && typeof part.text === "string" ? { text: part.text } : undefined);
  const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : undefined);

  // אותו מבנה כמו בנתוני הדף, כדי ש-yad2.js יקרא אותו בלי קוד נפרד
  function sanitize(item, id) {
    const address = item.address || {};
    const details = item.additionalDetails || {};
    const coords = address.coords;
    const inProperty = item.inProperty && typeof item.inProperty === "object"
      ? Object.fromEntries(Object.entries(item.inProperty).filter(([, value]) => typeof value === "boolean"))
      : undefined;
    return {
      token: id,
      adType: typeof item.adType === "string" ? item.adType : undefined,
      price: num(item.price),
      priceBeforeTag: num(item.priceBeforeTag),
      address: {
        city: text(address.city),
        street: text(address.street),
        neighborhood: text(address.neighborhood),
        house: address.house ? { number: num(address.house.number), floor: num(address.house.floor) } : undefined,
        coords: coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)
          ? { lat: coords.lat, lon: coords.lon }
          : undefined,
      },
      additionalDetails: {
        roomsCount: num(details.roomsCount),
        squareMeter: num(details.squareMeter),
        buildingTopFloor: num(details.buildingTopFloor),
      },
      metaData: item.metaData && num(item.metaData.shelterDistance) !== undefined
        ? { shelterDistance: num(item.metaData.shelterDistance) }
        : undefined,
      inProperty,
    };
  }

  function scan() {
    for (const link of document.querySelectorAll('a[href*="/realestate/item/"]')) {
      const match = (link.getAttribute("href") || "").match(ID_RE);
      const id = match && match[1];
      if (!id) continue;
      // React משתמש שוב באותו קישור לכרטיס אחר כשמחליפים עמוד – לכן בודקים לפי המזהה, לא רק אם כבר סומן
      if (link.dataset.lrItemId === id && link.hasAttribute("data-lr-item")) continue;
      const item = itemFor(link, id);
      link.dataset.lrItemId = id;
      if (item) link.setAttribute("data-lr-item", JSON.stringify(sanitize(item, id)));
      else link.removeAttribute("data-lr-item");
    }
  }

  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { scan(); } catch (error) { console.warn("[lightrail-ext] page data scan failed", error); }
    }, 250);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
