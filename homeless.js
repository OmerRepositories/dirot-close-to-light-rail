// הומלס (homeless.co.il) – נבדק 2026-11-12.
// תוצאות חיפוש: טבלה (tr[id^="ad_"], type="ad") עם עמודות לפי כותרת הטבלה: סוג הנכס, עיר, שכונה,
// רחוב (+מספר), חדרים, קומה, מחיר, כניסה, ת. עידכון. בטבלת המתווכים יש גם "שם הסוכנות". אין מ"ר.
// עמוד מודעה: /sale/viewad,<id>.aspx – כותרת "דירה 4 חדרים למכירה בפתח תקווה, פיקא 8, מרכז",
// "פרטים נוספים" (מ"ר / קומה X מתוך Y / מחיר) ומאפיינים .IconOption.on / .IconOption.off.
// אין קואורדינטות – המיקום מחושב מהכתובת.
var LRHomeless = (() => {
  const LISTING_HREF = /\/(?:sale|rent)\/viewad,\d+\.aspx/i;
  const ID_RE = /\/(?:sale|rent)\/viewad,(\d+)\.aspx/i;
  const clean = (value) => String(value || "").replace(/[‎‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
  const isPage = () => ID_RE.test(location.pathname);
  const number = (value) => {
    const match = clean(value).match(/-?\d+(?:[.,]\d+)?/);
    return match ? Number(match[0].replace(",", ".")) : null;
  };

  function listingId(root) {
    if (root === document) {
      const match = location.pathname.match(ID_RE);
      if (match) return match[1];
    }
    const row = root.closest ? root.closest('[id^="ad_"]') : null;
    const rowId = row && row.id.match(/^ad_(\d+)$/);
    if (rowId) return rowId[1];
    if (root.id && /^ad_\d+$/.test(root.id)) return root.id.slice(3);
    const link = root.querySelector ? root.querySelector('a[href*="viewad,"]') : null;
    const match = link && new URL(link.href, location.href).pathname.match(ID_RE);
    return match ? match[1] : null;
  }

  function listingUrl(root) {
    if (root === document && isPage()) return location.href.split("#")[0];
    const id = listingId(root);
    return id ? `https://www.homeless.co.il/sale/viewad,${id}.aspx` : null;
  }

  // עמודות השורה לפי כותרת הטבלה שלה (בטבלת המתווכים יש עמודה נוספת)
  function rowCells(row) {
    if (!row || row.tagName !== "TR") return null;
    const table = row.closest("table");
    const headerRow = table && [...table.querySelectorAll("tr")].find((tr) => tr.querySelector("th") || /סוג הנכס|נכס/.test(tr.textContent) && /מחיר/.test(tr.textContent) && !tr.id);
    const headers = headerRow ? [...headerRow.children].map((cell) => clean(cell.textContent)) : [];
    const values = [...row.children].map((cell) => clean(cell.innerText || cell.textContent));
    const pick = (...names) => {
      const index = headers.findIndex((header) => names.includes(header));
      return index >= 0 ? values[index] || "" : "";
    };
    return {
      type: pick("סוג הנכס", "נכס"),
      city: pick("עיר"),
      hood: pick("שכונה"),
      street: pick("רחוב"),
      rooms: pick("חדרים"),
      floor: pick("קומה"),
      price: pick("מחיר"),
      updated: pick("ת. עידכון", "ת. עדכון"),
      agency: pick("שם הסוכנות"),
      hasAgencyColumn: headers.includes("שם הסוכנות"),
    };
  }

  // כותרת העמוד: "<סוג> N חדרים למכירה ב<עיר>, <רחוב ומספר>, <שכונה>"
  function pageParts() {
    const h1 = document.querySelector("h1");
    const text = clean(h1 && h1.textContent);
    const match = text.match(/ל(?:מכירה|השכרה)\s+ב(.+)$/);
    if (!match) return null;
    const [city, street, hood] = match[1].split(",").map(clean);
    return { city: city || "", street: street || "", hood: hood || "" };
  }

  // "פרטים נוספים": מ"ר / קומה / מחיר – מהטקסט של הבלוק
  function pageDetails() {
    const text = String(document.body ? document.body.innerText || "" : "");
    const pick = (label) => {
      const match = text.match(new RegExp(`${label}\\s*:\\s*\\n?\\s*([^\\n]+)`));
      return match ? clean(match[1]) : "";
    };
    return { sqm: pick('מ"ר'), floor: pick("קומה"), price: pick("מחיר") };
  }

  function readAddress(root, text, ctxCity, single) {
    if (root === document || single) {
      const parts = pageParts();
      if (parts && parts.city) {
        const parsed = LR.parseAddress(parts.street ? `${parts.street}, ${parts.city}` : parts.city, parts.city);
        return { ...parsed, city: parts.city, hood: parts.hood || parsed.hood, coordinates: null };
      }
      return { ...LR.parseAny(text, ctxCity), coordinates: null };
    }
    const cells = rowCells(root.closest ? root.closest("tr") || root : root);
    if (cells && (cells.city || cells.street)) {
      // "פתח תקווה פז" = עיר + אזור (מילה אחרונה של אזור בלוח) – נשארת כמו שהיא; העיר מההקשר אם יש
      const city = ctxCity && cells.city.startsWith(ctxCity) ? ctxCity : cells.city;
      const parsed = LR.parseAddress(cells.street ? `${cells.street}, ${city}` : city, city || ctxCity);
      return { ...parsed, city: city || parsed.city, hood: cells.hood || parsed.hood, coordinates: null };
    }
    return { ...LR.parseAddress(text, ctxCity), coordinates: null };
  }

  function extractPriceSqm(root, rawText) {
    if (root === document) {
      const details = pageDetails();
      const price = number(String(details.price).replace(/,/g, ""));
      const sqm = number(details.sqm);
      if (price || sqm) return LR.extractPriceSqm(`${price ? `₪${price}` : ""}\n${sqm ? `${sqm} מ״ר` : ""}`);
      return LR.extractPriceSqm(rawText);
    }
    const cells = rowCells(root.closest ? root.closest("tr") || root : root);
    // בטבלה אין מ"ר – רק מחיר (המחיר למ"ר יחושב כשנפתח את המודעה)
    if (cells && cells.price) return LR.extractPriceSqm(cells.price);
    return LR.extractPriceSqm(rawText);
  }

  function listingExportData(root) {
    if (root === document) {
      const parts = pageParts();
      const h1 = clean(document.querySelector("h1") && document.querySelector("h1").textContent);
      const rooms = number((h1.match(/(\d+(?:\.\d+)?)\s*חדרים/) || [])[1]);
      const floorMatch = pageDetails().floor.match(/(-?\d+|קרקע)\s*(?:מתוך\s*(\d+))?/);
      const floor = floorMatch ? (floorMatch[1] === "קרקע" ? 0 : Number(floorMatch[1])) : null;
      return {
        rooms: Number.isFinite(rooms) ? rooms : null,
        floor: Number.isFinite(floor) ? floor : null,
        buildingTopFloor: floorMatch && floorMatch[2] ? Number(floorMatch[2]) : null,
        neighborhood: parts ? parts.hood : null,
        previousPrice: null,
        listingCreatedAt: null,
        listingUpdatedAt: null,
      };
    }
    const cells = rowCells(root.closest ? root.closest("tr") || root : root) || {};
    const rooms = number(cells.rooms);
    const floor = /קרקע/.test(cells.floor || "") ? 0 : number(cells.floor);
    const updated = (cells.updated || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return {
      rooms: Number.isFinite(rooms) ? rooms : null,
      floor: Number.isFinite(floor) ? floor : null,
      previousPrice: null,
      listingCreatedAt: null,
      listingUpdatedAt: updated ? `${updated[3]}-${updated[2].padStart(2, "0")}-${updated[1].padStart(2, "0")}` : null,
    };
  }

  const AMENITY_LABELS = [
    ["grating", /^סורגים/],
    ["elevator", /^מעלית/],
    ["balcony", /^מרפסת/],
    ["secureRoom", /^ממ"?ד/],
    ["storage", /^מחסן/],
    ["accessible", /^נגיש/],
    ["sunBoiler", /^דוד שמש/],
    ["parking", /^חני/],
    ["airConditioner", /^(?:מזגן|מיזוג)/],
  ];

  function readAmenities(root) {
    if (root !== document) return null;
    const options = [...document.querySelectorAll(".IconOption")];
    if (!options.length) return null;
    const result = {};
    for (const option of options) {
      const label = clean(option.textContent);
      const found = AMENITY_LABELS.find(([, re]) => re.test(label));
      if (!found) continue;
      result[found[0]] = option.classList.contains("on") ? true : option.classList.contains("off") ? false : null;
    }
    return Object.keys(result).length ? result : null;
  }

  // מתווך: בטבלת המתווכים (עמודת "שם הסוכנות") – בלי שמות של מפרסמים פרטיים
  function brokerInfo(root) {
    if (root === document) return null;
    const cells = rowCells(root.closest ? root.closest("tr") || root : root);
    if (!cells || !cells.hasAgencyColumn || !cells.agency) return null;
    return { office: cells.agency, agent: "" };
  }

  // שורה בטבלת המתווכים = תיווך; שורה בטבלה הרגילה = פרטי. בעמוד מודעה – לא ידוע (לפי הטקסט)
  function brokerageFromData(root) {
    if (root === document) return null;
    const cells = rowCells(root.closest ? root.closest("tr") || root : root);
    return cells ? cells.hasAgencyColumn : null;
  }

  function listingPageStatus() {
    const match = location.pathname.match(ID_RE);
    if (!match) return null;
    const text = String(document.body ? document.body.innerText || "" : "");
    if (/המודעה (?:הוסרה|אינה קיימת|לא נמצאה)|מודעה זו (?:הוסרה|אינה פעילה)/.test(text)) return { id: match[1], status: "removed" };
    return document.querySelector("h1") && pageDetails().price ? { id: match[1], status: "active" } : null;
  }

  function searchCityContext(path) {
    try {
      const match = decodeURIComponent(path).match(/city=([^/&?]+)/);
      return match ? clean(match[1]) : null;
    } catch {
      return null;
    }
  }

  // התגים של התוסף נכנסים לתא הרחוב (div בתוך tr לא מוצג טוב)
  function wrapHost(card) {
    if (!card || card.tagName !== "TR") return card;
    const cells = [...card.children];
    return cells[Math.min(5, cells.length - 1)] || card;
  }

  return {
    LISTING_HREF,
    listingId,
    listingUrl,
    readAddress,
    extractPriceSqm,
    listingExportData,
    readAmenities,
    brokerInfo,
    brokerageFromData,
    listingPageStatus,
    searchCityContext,
    wrapHost,
    projectExportData: () => null,
    isProjectCard: () => false,
    isProjectPage: () => false,
    isProjectListingPage: () => false,
  };
})();

if (typeof module !== "undefined") module.exports = LRHomeless;
