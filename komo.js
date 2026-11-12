// קומו (komo.co.il) – נבדק 2026-11-12.
// כרטיס בחיפוש: .modaa__box / .modaaRowAd עם h2.title "עיר, שכונה, רחוב מספר", .price ו-.description
// ("דירות 4.0 חדרים (100 מ"ר) קומה: 6 מתוך 8"). הקישור: /code/nadlan/details/?modaaNum=<id>.
// עמוד מודעה: #addressModaaWTitleArea ("דירה למכירה, רוטשילד 119" + "המרכז השקט, פתח תקווה"),
// .modaaWPrice, .firstInfoBlockWrap.rooms/.floor/.mr, "קומות בבניין", תגית .mefarsemNew (מפרטי / מתיווך),
// ומאפיינים ul.modaaWNewUl li – עם מחלקה "add" כשהמאפיין קיים. אין קואורדינטות.
var LRKomo = (() => {
  // המזהה נמצא בפרמטר, לכן "הנתיב" של מודעה כולל אותו (כדי שכל מודעה תזוהה בנפרד)
  const LISTING_HREF = /\/code\/nadlan\/details\/modaaNum=\d+/i;
  const clean = (value) => String(value || "").replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  const number = (value) => {
    const match = clean(value).match(/-?\d+(?:[.,]\d+)?/);
    return match ? Number(match[0].replace(",", ".")) : null;
  };

  function idFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (!/\/code\/nadlan\/details\/?$/i.test(parsed.pathname)) return null;
      const id = parsed.searchParams.get("modaaNum");
      return id && /^\d+$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  // "נתיב" מודעה לזיהוי כרטיסים: /code/nadlan/details/modaaNum=123
  function listingPathFromUrl(url) {
    const id = idFromUrl(url);
    if (id) return `/code/nadlan/details/modaaNum=${id}`;
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return null;
    }
  }
  const isPage = () => Boolean(idFromUrl(location.href));

  function cardOf(root) {
    if (!root || root === document) return null;
    return (root.closest && root.closest(".modaa__box, .modaaRowAd")) || root;
  }

  function listingId(root) {
    if (root === document) return idFromUrl(location.href);
    const link = root.querySelector ? root.querySelector('a[href*="modaaNum="]') : null;
    return link ? idFromUrl(link.href) : (root.matches && root.matches('a[href*="modaaNum="]') ? idFromUrl(root.href) : null);
  }

  function listingUrl(root) {
    const id = listingId(root);
    return id ? `https://www.komo.co.il/code/nadlan/details/?modaaNum=${id}` : null;
  }

  function pageAddress() {
    const box = document.querySelector("#addressModaaWTitleArea");
    if (!box) return null;
    const spans = [...box.querySelectorAll("span")].map((span) => clean(span.textContent)).filter(Boolean);
    // "דירה למכירה, רוטשילד 119" / "המרכז השקט, פתח תקווה"
    const street = spans[0] ? clean(spans[0].split(",").slice(1).join(",")) : "";
    const [hood, city] = (spans[1] || "").split(",").map(clean);
    return { street, hood: city ? hood : "", city: city || hood || "" };
  }

  function cardTitle(root) {
    const card = cardOf(root);
    const title = card && card.querySelector("h2.title, .title");
    return clean(title && title.textContent);
  }

  function readAddress(root, text, ctxCity, single) {
    if (root === document || single) {
      const address = pageAddress();
      if (address && address.city) {
        const parsed = LR.parseAddress(address.street ? `${address.street}, ${address.city}` : address.city, address.city);
        return { ...parsed, city: address.city, hood: address.hood || parsed.hood, coordinates: null };
      }
      return { ...LR.parseAny(text, ctxCity), coordinates: null };
    }
    // "פתח תקווה, תקומה, הקונגרס 12" = עיר, שכונה, רחוב
    const parts = cardTitle(root).split(",").map(clean).filter(Boolean);
    if (parts.length) {
      const city = parts[0];
      const street = parts.length > 2 ? parts.slice(2).join(", ") : parts.length === 2 && /\d/.test(parts[1]) ? parts[1] : "";
      const hood = parts.length > 2 ? parts[1] : parts.length === 2 && !/\d/.test(parts[1]) ? parts[1] : "";
      const parsed = LR.parseAddress(street ? `${street}, ${city}` : city, city || ctxCity);
      return { ...parsed, city, hood: hood || parsed.hood, coordinates: null };
    }
    return { ...LR.parseAddress(text, ctxCity), coordinates: null };
  }

  function pageInfo(kind) {
    const block = document.querySelector(`.firstInfoBlockWrap.${kind}`);
    return clean(block && block.querySelector(".firstInfo") ? block.querySelector(".firstInfo").textContent : block && block.textContent);
  }

  function extractPriceSqm(root, rawText) {
    if (root === document) {
      const priceElement = document.querySelector(".modaaWPrice");
      const sqm = number(pageInfo("mr"));
      return LR.extractPriceSqm(`${clean(priceElement && priceElement.textContent)}\n${sqm ? `${sqm} מ״ר` : ""}`);
    }
    const card = cardOf(root);
    const price = card && card.querySelector(".price");
    const description = card && card.querySelector(".description");
    return LR.extractPriceSqm(`${clean(price && price.textContent)}\n${clean(description && description.textContent)}`);
  }

  // "עודכן לפני: 3 ימים" / "לפני: 2 חודשים" / "לפני שנה" – תאריך עדכון משוער (ביום) כ-YYYY-MM-DD.
  // קומו לא מציגה תאריך פרסום; תאריך עדכון ישן = כנראה מודעה ישנה שלא הוסרה.
  function relativeUpdatedDate(text, now = new Date()) {
    const match = clean(text).match(/עודכן\s+לפני:?\s*(\d+)?\s*(דקות|דקה|שעות|שעה|ימים|יום|שבועות|שבוע|חודשים|חודש|שנים|שנה)/);
    if (!match) return null;
    const amount = match[1] ? Number(match[1]) : 1;
    const unit = match[2];
    const date = new Date(now.getTime());
    if (/דק|שע/.test(unit)) {
      // היום
    } else if (/יום|ימים/.test(unit)) date.setDate(date.getDate() - amount);
    else if (/שבוע/.test(unit)) date.setDate(date.getDate() - amount * 7);
    else if (/חודש/.test(unit)) date.setMonth(date.getMonth() - amount);
    else date.setFullYear(date.getFullYear() - amount);
    return date.toISOString().slice(0, 10);
  }

  function listingExportData(root) {
    if (root === document) {
      const rooms = number(pageInfo("rooms"));
      const floorText = pageInfo("floor");
      const floor = /קרקע/.test(floorText) ? 0 : number(floorText);
      const topElement = [...document.querySelectorAll(".secondInfoElement")].find((element) => /קומות בבניין/.test(element.textContent));
      const top = topElement ? number(topElement.querySelector(".secondInfoElementContent") ? topElement.querySelector(".secondInfoElementContent").textContent : "") : null;
      const address = pageAddress();
      return {
        rooms: Number.isFinite(rooms) ? rooms : null,
        floor: Number.isFinite(floor) ? floor : null,
        buildingTopFloor: Number.isFinite(top) ? top : null,
        neighborhood: address ? address.hood : null,
        previousPrice: null,
        listingCreatedAt: null,
        listingUpdatedAt: relativeUpdatedDate(
          (document.querySelector(".m_updateDate") && document.querySelector(".m_updateDate").textContent) || ""
        ),
      };
    }
    const card = cardOf(root);
    const description = clean(card && card.querySelector(".description") && card.querySelector(".description").textContent);
    const rooms = number((description.match(/(\d+(?:\.\d+)?)\s*חדרים/) || [])[1]);
    const floorMatch = description.match(/קומה:\s*(-?\d+|קרקע)(?:\s*מתוך\s*(\d+))?/);
    return {
      rooms: Number.isFinite(rooms) ? rooms : null,
      floor: floorMatch ? (floorMatch[1] === "קרקע" ? 0 : Number(floorMatch[1])) : null,
      buildingTopFloor: floorMatch && floorMatch[2] ? Number(floorMatch[2]) : null,
      previousPrice: null,
      listingCreatedAt: null,
      listingUpdatedAt: null,
    };
  }

  const AMENITY_CLASSES = {
    mamad: "secureRoom",
    maalit: "elevator",
    soragim: "grating",
    mahsan: "storage",
    mizug: "airConditioner",
    boiler: "sunBoiler",
    gisha: "accessible",
  };

  // li עם "add" = יש. אם אף מאפיין לא מסומן – המפרסם לא מילא, ולכן "לא ידוע" ולא "אין"
  function readAmenities(root) {
    if (root !== document) return null;
    const items = [...document.querySelectorAll("ul.modaaWNewUl li")];
    if (!items.length) return null;
    const anyMarked = items.some((item) => item.classList.contains("add"));
    const result = {};
    for (const item of items) {
      const key = [...item.classList].map((name) => AMENITY_CLASSES[name]).find(Boolean);
      if (!key) continue;
      result[key] = item.classList.contains("add") ? true : anyMarked ? false : null;
    }
    // חניה / מרפסות: "חניות 1", "מרפסות 2" (ריק = לא צוין)
    for (const element of document.querySelectorAll(".secondInfoElement")) {
      const title = clean(element.querySelector(".secondInfoElementTitle") && element.querySelector(".secondInfoElementTitle").textContent);
      const value = number(element.querySelector(".secondInfoElementContent") && element.querySelector(".secondInfoElementContent").textContent);
      if (title === "חניות" && value !== null) result.parking = value > 0;
      if (title === "מרפסות" && value !== null) result.balcony = value > 0;
    }
    return Object.keys(result).length ? result : null;
  }

  // תגית המפרסם בעמוד: "מתיווך" / "מפרטי"
  function brokerageFromData(root) {
    if (root !== document) return null;
    const tag = clean(document.querySelector(".mefarsemNew") && document.querySelector(".mefarsemNew").textContent);
    if (/מתיווך|תיווך/.test(tag)) return true;
    if (/מפרטי|פרטי/.test(tag)) return false;
    return null;
  }

  function brokerInfo() {
    return null; // קומו לא מציגה שם משרד בכרטיס/בעמוד באופן קבוע (נבדק 2026-11-12)
  }

  function listingPageStatus() {
    const id = idFromUrl(location.href);
    if (!id) return null;
    const text = String(document.body ? document.body.innerText || "" : "");
    if (/המודעה (?:הוסרה|אינה קיימת|לא נמצאה|אינה פעילה)/.test(text)) return { id, status: "removed" };
    return document.querySelector(".modaaWPrice") ? { id, status: "active" } : null;
  }

  function searchCityContext() {
    try {
      const city = new URLSearchParams(location.search).get("cityName");
      return city ? clean(city) : null;
    } catch {
      return null;
    }
  }

  return {
    LISTING_HREF,
    listingPathFromUrl,
    listingId,
    listingUrl,
    readAddress,
    extractPriceSqm,
    listingExportData,
    relativeUpdatedDate,
    readAmenities,
    brokerInfo,
    brokerageFromData,
    listingPageStatus,
    searchCityContext,
    isPage,
    projectExportData: () => null,
    isProjectCard: () => false,
    isProjectPage: () => false,
    isProjectListingPage: () => false,
  };
})();

if (typeof module !== "undefined") module.exports = LRKomo;
