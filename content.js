// Content script: מזהה כרטיסי מודעות (ודף מודעה בודדת) ביד2 ובמדלן, ומציג:
//  - מרחק מהרכבת הקלה + דקות הליכה + שם התחנה
//  - מחיר למ"ר והשוואה לחציון
//  - הדגשה למודעות שוות
// תלוי ב-parse.js (משתנה גלובלי LR).
(() => {
  const IS_YAD2 = location.hostname.includes("yad2.co.il");
  const isProjectDetailPage = () =>
    IS_YAD2
      ? LRYad2.isProjectPage(location.pathname)
      : LRMadlan.isProjectPage(location.pathname);
  const isProjectListingPage = () =>
    IS_YAD2
      ? LRYad2.isProjectListingPage(location.pathname)
      : LRMadlan.isProjectListingPage(location.pathname);

  // ===== הגדרות =====
  // ברירות המחדל זהות ל-popup.js. המשתמש משנה אותן דרך חלון ההגדרות של התוסף.
  const DEFAULTS = {
    maxPpsm: 0, // מחיר מקסימלי למ"ר שנחשב "שווה" (0 = לא פעיל)
    belowMedianPct: 10, // כמה אחוזים זול מחציון הדף (0 = לא פעיל)
    calculatePpsm: true, // להציג ולחשב מחיר למ"ר ביד2 ובמדלן
    calculateRail: true, // להציג ולחשב מרחק מהרכבת ביד2 ובמדלן
    requireRail: true, // לדרוש קרבה לרכבת
    nearM: 800, // מרחק מקסימלי מהרכבת במטרים
    highlight: true, // להדגיש מודעות שוות (מסגרת + תג)
    avoidBrokerage: false,
    removeBrokerage: false,
    removeProjects: false,
    disableYad2: false,
    disableMadlan: false,
    saveListingData: true,
    listingIndexingMode: "encountered",
    indexCities: [], // ערים שנשמרות מתוצאות החיפוש (ריק = כל הערים)
    indexMinPrice: 0, // מחיר מינימלי לשמירת מודעה חדשה מתוצאות החיפוש (0 = ללא)
    indexMaxPrice: 0, // מחיר מקסימלי לשמירת מודעה חדשה מתוצאות החיפוש (0 = ללא הגבלה)
    requiredAmenities: ["secureRoom"],
    irrelevantMissingPct: 50, // סף "לא רלוונטית" (אחוז מאפייני חובה שחסרים בוודאות; 0 = כבוי)
    dealBreakerAmenities: [], // מאפיינים שחסרונם הופך מודעה ללא רלוונטית מיד
    hideIrrelevant: false, // להסתיר מתוצאות החיפוש מודעות שסומנו כלא רלוונטיות
    showPriceChange: true, // להציג על כרטיס בחיפוש שינוי מחיר מאז שנשמרה
    showListingAge: true, // להציג כמה זמן המודעה באוויר
    hideAds: true, // להסתיר פרסומות (באנרים של Google ופרויקטים ממומנים) ביד2
    blockedStreets: [], // רחובות שמודעות עליהם לא יוצגו לעולם
  };
  const CFG = {
    ...DEFAULTS,
    MIN_SAMPLES: 5, // מינימום מודעות עם מחיר למ"ר בדף כדי לחשב חציון
    ROOT_MARGIN: "700px", // מתחילים לחשב מודעות שנמצאות עד כמה פיקסלים מהמסך
  };

  const LISTING_CACHE_KEY = "yad2AmenityCache_v1";
  const LISTING_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
  const LISTING_CACHE_MAX_ITEMS = 2500;
  const LISTING_CACHE_MAX_BYTES = 4 * 1024 * 1024;
  const SITE_DISABLE_KEY = IS_YAD2 ? "disableYad2" : "disableMadlan";
  let listingCache = {};
  let listingCacheLoaded = false;
  let pendingCacheSave = false;
  let cacheWriteInProgress = false;
  let cacheSaveTimer = null;
  let cacheWriteRetryTimer = null;
  let cacheWriteFailureCount = 0;
  let cacheWriteErrorLogged = false;
  const cacheWriteSuppressedIds = new Set();

  // קישורים שמזהים מודעה בודדת
  const LISTING_HREF = IS_YAD2
    ? /\/realestate\/item\//
    : /\/(listings|bulletin)\/[^/?#]+/;

  // בדף מודעה בודדת: מכאן והלאה זה "מודעות דומות", לא המודעה עצמה
  const SIMILAR_MARKERS =
    /דירות דומות|מודעות דומות|נכסים דומים|נכסים נוספים|מודעות נוספות|עוד מודעות|אולי יעניין|דירות נוספות|דירות באזור|מומלצים|נכסים שנמכרו|עסקאות באזור/;

  // ---------- מצב ----------
  const entries = new Map(); // מפתח (כרטיס / פאנל) -> entry
  let main = null; // { entry, path } – המודעה של דף מודעה בודדת
  let scanTimer = null;
  let refreshTimer = null;
  let pageObserver = null;
  let isRunning = false;
  let pageBias = null; // המיקום האחרון שנמצא בדיוק, לעזרה בכתובות בלי עיר
  let storedMedian = null; // חציון מחיר למ"ר מחיפוש אחרון (לדפי מודעה בודדת)
  let removeBrokerageForPage = null;
  let removeProjectsForPage = null;
  let nearRailOnlyForPage = false;
  let brokerageFilterBar = null;
  const projectCards = new Set();

  const io = new IntersectionObserver(
    (list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const entry = entries.get(e.target);
        if (entry) startLookup(entry);
      }
    },
    { rootMargin: CFG.ROOT_MARGIN }
  );

  // ---------- הקשר עיר מהדף ----------
  // כשהמשתמש מסנן לפי עיר, כל המודעות בה גם אם הכרטיס לא מציין עיר.
  // קודי יישוב (למ"ס) שיד2 משתמש בהם בפרמטר city בכתובת:
  const CITY_CODES = {
    5000: "תל אביב יפו", 3000: "ירושלים", 4000: "חיפה", 8300: "ראשון לציון",
    7900: "פתח תקווה", 70: "אשדוד", 7400: "נתניה", 9000: "באר שבע",
    6600: "חולון", 6100: "בני ברק", 8600: "רמת גן", 7100: "אשקלון",
    8400: "רחובות", 6200: "בת ים", 6400: "הרצליה", 6900: "כפר סבא",
    1200: "מודיעין מכבים רעות", 8700: "רעננה", 6500: "חדרה", 7000: "לוד",
    8500: "רמלה", 7200: "נס ציונה", 6300: "גבעתיים", 9700: "הוד השרון",
    2620: "קריית אונו", 2400: "אור יהודה", 9400: "יהוד מונוסון", 6700: "טבריה",
    9100: "נהריה", 7800: "פרדס חנה כרכור", 2630: "קריית גת", 1034: "מגדל העמק",
  };

  function ctxCity() {
    if (!IS_YAD2) {
      const h1 = document.querySelector("h1");
      return LRMadlan.searchCityContext(
        location.pathname,
        [h1 ? h1.innerText : "", document.title || ""].filter(Boolean).join(" ")
      );
    }

    // 1) סגמנט בעברית בנתיב (מדלן: /for-sale/פתח-תקווה-ישראל)
    try {
      const segs = decodeURIComponent(location.pathname).split("/").filter(Boolean);
      const seg = segs.find((s) => /[֐-׿]/.test(s));
      if (seg) return seg.replace(/-ישראל$/, "").replace(/-/g, " ").trim();
    } catch {}

    // 2) פרמטרים בכתובת: city=7900 (קוד) או שם בעברית
    try {
      const sp = new URLSearchParams(location.search);
      const raw = sp.get("city") || sp.get("cityName") || sp.get("city_name");
      if (raw) {
        if (/^\d+$/.test(raw)) {
          if (CITY_CODES[Number(raw)]) return CITY_CODES[Number(raw)];
        } else if (/[֐-׿]/.test(raw)) {
          return raw.replace(/-/g, " ").trim();
        }
      }
    } catch {}

    // 3) כותרת הדף / h1: "דירות למכירה בפתח תקווה"
    const h1 = document.querySelector("h1");
    const sources = [h1 ? h1.innerText : "", document.title || ""];
    for (const t of sources) {
      const m = t.match(/(?:למכירה|להשכרה)\s+ב([^|\n,–\-]+)/);
      if (m && m[1].trim().length >= 2) return m[1].trim();
    }
    return null;
  }

  function validCachedCoordinates(record) {
    return Boolean(record && LRLocation.validCoordinates(record.coordinates));
  }

  // ---------- קריאת טקסט ----------
  // innerText לא מפריד בין אלמנטים שאין ביניהם שבירת שורה, ולכן "קומה 7" ו-"95 מ״ר" נקראו
  // כ-"קומה 795 מ״ר". כאן כל צומת טקסט נקרא בנפרד, כל אחד בשורה משלו,
  // והתגים של התוסף עצמו (.lr-wrap) לא נכללים.
  // אזורים בעמוד מודעה ביד2 שאינם חלק מהמודעה ומכילים מחירים/שטחים של נכסים אחרים:
  // "נכסים שנמכרו באזור", מחשבון משכנתא, "נכסים דומים למה שחיפשת", "פרויקטים חדשים באזור".
  // הטקסט שלהם לא נקרא, כדי שמחיר, שטח או חדרים לא יילקחו מהם בטעות.
  const UNRELATED_SECTIONS = [
    '[data-testid="deals-history-section-section"]',
    '[data-testid="deals-history"]',
    '[data-testid="mortgage-calculator-section-section"]',
    '[data-testid="recommendations-section-section"]',
    '[data-testid="yad1-projects-in-area-section-section"]',
    '[data-testid="nearby-education-section-section"]',
  ].join(",");

  function textOf(root, limit = 8000) {
    if (!root) return "";
    const out = [];
    let len = 0;
    // כרטיס שנמצא בעצמו בתוך אזור כזה (למשל "נכסים דומים") נקרא כרגיל
    const skipUnrelated = !(root.closest && root.closest(UNRELATED_SECTIONS));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".lr-wrap")) return NodeFilter.FILTER_REJECT;
        if (skipUnrelated && p.closest(UNRELATED_SECTIONS)) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue.replace(/\s+/g, " ").trim();
      out.push(v);
      len += v.length;
      if (len > limit) break;
    }
    return out.join("\n");
  }

  // textOf עובר על כל צומת טקסט ב-JS; כאן הוא רץ מחדש רק כשהתוכן של הכרטיס באמת השתנה
  // (textContent הוא קריאה מקורית של הדפדפן ומהירה בהרבה).
  function memoCardText(card) {
    let lastContent = null;
    let lastText = "";
    return () => {
      const content = card.textContent || "";
      if (content !== lastContent) {
        lastContent = content;
        lastText = textOf(card, 3000);
      }
      return lastText;
    };
  }

  function highlightBrokerage(root, enabled) {
    if (!root) return;
    const existing = root.querySelectorAll(".lr-brokerage-highlight, .lr-brokerage-positive");
    if (!enabled) {
      existing.forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            ".lr-wrap, .lr-brokerage-highlight, .lr-brokerage-positive, script, style, noscript, textarea"
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return (
          /תיווך|נדל(?:[״"'׳]?ן)/.test(node.nodeValue) ||
          Boolean(parent.closest('[data-testid="ad-card-above-price"]'))
        )
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const brokerageTerms =
      /((?:ללא|בלי|לא)(?:\s+(?:(?:צורך\s+)?(?:ב|דרך|באמצעות)))?\s*תיווך)|תיווך|נדל(?:[״"'׳]?ן)/g;
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      const text = node.nodeValue;
      if (node.parentElement.closest('[data-testid="ad-card-above-price"]')) {
        const mark = document.createElement("span");
        mark.className = "lr-brokerage-highlight";
        mark.textContent = text;
        node.replaceWith(mark);
        continue;
      }
      let cursor = 0;
      for (const match of text.matchAll(brokerageTerms)) {
        const index = match.index;
        if (index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        const mark = document.createElement("span");
        mark.className = match[1] ? "lr-brokerage-positive" : "lr-brokerage-highlight";
        mark.textContent = match[0];
        fragment.appendChild(mark);
        cursor = index + match[0].length;
      }
      if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
      node.replaceWith(fragment);
    }
  }

  // dataRoot: לפיו מזהים את המודעה בנתוני הדף (בעמוד מודעה – document). root: האזור שהטקסט שלו נבדק –
  // בעמוד מודעה רק main, כי בתפריט ובכותרת התחתונה של יד2 מופיע "נדל״ן" ואז כל מודעה נראתה כתיווך.
  function hasBrokerageSignal(root, dataRoot = root) {
    if (!root) return false;
    if (IS_YAD2) {
      const fromData = LRYad2.brokerageFromData(dataRoot);
      if (fromData !== null) return fromData;
    }
    const agentLabel = root.querySelector('[data-testid="ad-card-above-price"]');
    if (agentLabel && agentLabel.textContent.trim()) return true;

    const text = textOf(root, 6000)
      .replace(/\s+/g, " ")
      .replace(/(?:ללא|בלי|לא)(?:\s+(?:(?:צורך\s+)?(?:ב|דרך|באמצעות)))?\s*תיווך/g, "");
    return /תיווך|נדל(?:[״"'׳]?ן)/.test(text);
  }

  // רחובות חסומים: הכתובת נקראת מחדש רק כשהטקסט של הכרטיס משתנה
  let blockedStreetRules = [];
  function filterStreetEntry(entry) {
    if (entry.kind !== "list") return false;
    let blocked = null;
    if (blockedStreetRules.length) {
      const text = entry.getText();
      if (entry.streetFilterText !== text) {
        entry.streetFilterText = text;
        try {
          const siteParser = IS_YAD2 ? LRYad2 : LRMadlan;
          const address = siteParser.readAddress(entry.card, text, ctxCity(), false);
          entry.streetFilterAddress = { street: address.street || "", city: address.city || "" };
        } catch {
          entry.streetFilterAddress = null;
        }
      }
      const address = entry.streetFilterAddress;
      blocked = address ? LRStreetFilter.match(blockedStreetRules, address.street, address.city) : null;
    }
    entry.card.classList.toggle("lr-street-removed", Boolean(blocked));
    entry.streetRemoved = Boolean(blocked);
    return Boolean(blocked);
  }

  function filterBrokerageEntry(entry) {
    if (entry.kind !== "list") return false;
    const filterActive = removeBrokerageForPage ?? CFG.removeBrokerage;
    const shouldRemove =
      filterActive && hasBrokerageSignal(entry.card);
    entry.card.classList.toggle("lr-brokerage-removed", shouldRemove);
    entry.brokerageRemoved = shouldRemove;
    return shouldRemove;
  }

  function filterNearRailEntry(entry) {
    if (entry.kind !== "list") return false;
    const shouldRemove =
      nearRailOnlyForPage &&
      CFG.calculateRail &&
      entry.res !== null &&
      !(entry.res.ok && !entry.res.approx && entry.res.meters <= CFG.nearM);
    entry.card.classList.toggle("lr-not-near-rail", shouldRemove);
    return shouldRemove;
  }

  function updateBrokerageFilterStatus() {
    if (!brokerageFilterBar) return;
    const brokerageFilterActive = removeBrokerageForPage ?? CFG.removeBrokerage;
    const projectFilterActive = removeProjectsForPage ?? CFG.removeProjects;
    const count = [...entries.values()].filter((entry) => entry.brokerageRemoved).length;
    const status = brokerageFilterBar.querySelector(".lr-brokerage-filter-status");
    status.textContent = count
      ? `הוסרו ${count} מודעות תיווך בעמוד`
      : brokerageFilterActive
        ? "לא נמצאו מודעות תיווך"
        : "";
    brokerageFilterBar.dataset.active = String(brokerageFilterActive);
    const brokerageButton = brokerageFilterBar.querySelector(".lr-brokerage-filter-button");
    if (brokerageButton) {
      brokerageButton.textContent = brokerageFilterActive
        ? "הצגת מודעות תיווך"
        : "הסרת תיווך";
      brokerageButton.setAttribute(
        "aria-label",
        brokerageFilterActive
          ? "הצגת מודעות תיווך בעמוד זה"
          : "הסרת מודעות תיווך בעמוד זה"
      );
      brokerageButton.setAttribute("aria-pressed", String(brokerageFilterActive));
    }

    const projectCount = [...projectCards].filter((card) =>
      card.classList.contains("lr-project-removed")
    ).length;
    const projectStatus = brokerageFilterBar.querySelector(".lr-project-filter-status");
    projectStatus.textContent = isProjectListingPage()
      ? "סינון פרויקטים לא פעיל בעמוד פרויקטים"
      : projectCount
        ? `הוסרו ${projectCount} פרויקטים בעמוד`
        : projectFilterActive
          ? "לא נמצאו פרויקטים"
          : "";
    const projectButton = brokerageFilterBar.querySelector(".lr-project-filter-button");
    if (projectButton) {
      projectButton.textContent = projectFilterActive
        ? "הצגת פרויקטים"
        : "הסרת פרויקטים";
      projectButton.setAttribute(
        "aria-label",
        projectFilterActive ? "הצגת פרויקטים בעמוד זה" : "הסרת פרויקטים בעמוד זה"
      );
      projectButton.setAttribute("aria-pressed", String(projectFilterActive));
    }
    const railEntries = [...entries.values()].filter((entry) => entry.kind === "list");
    const railHiddenCount = railEntries.filter((entry) =>
      entry.card.classList.contains("lr-not-near-rail")
    ).length;
    const railStatus = brokerageFilterBar.querySelector(".lr-rail-filter-status");
    railStatus.textContent = !CFG.calculateRail
      ? "יש להפעיל חישוב קרבה לרכבת בהגדרות"
      : nearRailOnlyForPage
        ? `מוצגות מודעות מדויקות עד ${CFG.nearM} מ׳ · הוסתרו ${railHiddenCount}`
        : "";
    const railButton = brokerageFilterBar.querySelector(".lr-rail-filter-button");
    if (railButton) {
      railButton.textContent = nearRailOnlyForPage
        ? "הצגת כל המודעות"
        : "רק קרוב לרכבת";
      railButton.setAttribute(
        "aria-label",
        nearRailOnlyForPage
          ? "הצגת כל המודעות בעמוד"
          : "הצגת מודעות עם מרחק מדויק עד המרחק שהוגדר מהרכבת"
      );
      railButton.setAttribute("aria-pressed", String(nearRailOnlyForPage));
      railButton.disabled = !CFG.calculateRail;
    }
  }

  function isProjectPath(path) {
    return /\/(?:yad1\/project|projects?)\//i.test(path);
  }

  function findProjectCards() {
    const byHref = new Map();
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const path = hrefPath(anchor.href);
      if (!path || !isProjectPath(path)) return;
      if (!byHref.has(path)) byHref.set(path, anchor);
    });

    const cards = new Set();
    for (const [path, anchor] of byHref) {
      let card = anchor;
      while (card.parentElement && card.parentElement !== document.body) {
        const parent = card.parentElement;
        if ((parent.textContent || "").length > 2500) break;
        const otherProjects = [...parent.querySelectorAll("a[href]")].some((link) => {
          const linkPath = hrefPath(link.href);
          return Boolean(linkPath) && linkPath !== path && isProjectPath(linkPath);
        });
        if (otherProjects) break;
        card = parent;
      }
      cards.add(card);
    }
    return cards;
  }

  function processProjectCards() {
    if (isProjectDetailPage()) return;
    for (const card of projectCards) {
      if (!card.isConnected) projectCards.delete(card);
    }
    for (const card of findProjectCards()) projectCards.add(card);
    const projectListingPage = isProjectListingPage();
    const projectButton = brokerageFilterBar?.querySelector(".lr-project-filter-button");
    if (projectButton) projectButton.hidden = projectListingPage;
    const removeProjects = removeProjectsForPage ?? CFG.removeProjects;
    const shouldRemove =
      !projectListingPage && removeProjects;
    for (const card of projectCards) {
      card.classList.toggle("lr-project-removed", shouldRemove);
    }
    if (projectButton) {
      projectButton.setAttribute("aria-pressed", String(removeProjects));
    }
    updateBrokerageFilterStatus();
  }

  function createBrokerageFilterBar() {
    if (
      brokerageFilterBar ||
      LISTING_HREF.test(location.pathname) ||
      isProjectDetailPage()
    ) return;
    brokerageFilterBar = document.createElement("div");
    brokerageFilterBar.id = "lr-brokerage-filter";
    brokerageFilterBar.setAttribute("aria-label", "מסנני מודעות ופרויקטים");
    const brokerageButton = document.createElement("button");
    brokerageButton.className = "lr-brokerage-filter-button";
    brokerageButton.type = "button";
    brokerageButton.textContent = "הסרת תיווך";
    brokerageButton.setAttribute("aria-label", "הסרת מודעות תיווך בעמוד זה");
    brokerageButton.addEventListener("click", () => {
      removeBrokerageForPage = !(removeBrokerageForPage ?? CFG.removeBrokerage);
      findCards().forEach(processCard);
      for (const entry of entries.values()) filterBrokerageEntry(entry);
      updateBrokerageFilterStatus();
    });
    const brokerageStatus = document.createElement("span");
    brokerageStatus.className = "lr-brokerage-filter-status";
    brokerageStatus.setAttribute("aria-live", "polite");
    const projectButton = document.createElement("button");
    projectButton.className = "lr-project-filter-button";
    projectButton.type = "button";
    projectButton.textContent = "הסרת פרויקטים";
    projectButton.setAttribute("aria-label", "הסרת פרויקטים בעמוד זה");
    projectButton.addEventListener("click", () => {
      removeProjectsForPage = !(removeProjectsForPage ?? CFG.removeProjects);
      processProjectCards();
    });
    const projectStatus = document.createElement("span");
    projectStatus.className = "lr-project-filter-status";
    projectStatus.setAttribute("aria-live", "polite");
    const railButton = document.createElement("button");
    railButton.className = "lr-rail-filter-button";
    railButton.type = "button";
    railButton.textContent = "רק קרוב לרכבת";
    railButton.setAttribute(
      "aria-label",
      "הצגת מודעות עם מרחק מדויק עד המרחק שהוגדר מהרכבת"
    );
    railButton.setAttribute("aria-pressed", "false");
    railButton.disabled = !CFG.calculateRail;
    railButton.addEventListener("click", () => {
      nearRailOnlyForPage = !nearRailOnlyForPage;
      for (const entry of entries.values()) filterNearRailEntry(entry);
      updateBrokerageFilterStatus();
    });
    const railStatus = document.createElement("span");
    railStatus.className = "lr-rail-filter-status";
    railStatus.setAttribute("aria-live", "polite");
    const dragHandle = document.createElement("div");
    dragHandle.className = "lr-filter-drag";
    dragHandle.textContent = "⠿ גרור להזזה";
    dragHandle.title = "גרור כדי להזיז את הכפתורים. לחיצה כפולה מחזירה למקום ברירת המחדל.";
    brokerageFilterBar.append(
      dragHandle,
      brokerageButton,
      brokerageStatus,
      projectButton,
      projectStatus,
      railButton,
      railStatus
    );
    document.body.append(brokerageFilterBar);
    makeFilterBarDraggable(brokerageFilterBar, dragHandle);
  }

  // ---------- הזזת סרגל הכפתורים ----------
  // המיקום נשמר (באחוזים מגודל החלון, כדי שיתאים גם כשהחלון משנה גודל) ומשותף לכל הדפים.
  const FILTER_BAR_POSITION_KEY = "lightrailFilterBarPosition";
  let filterBarPosition = null;

  function applyFilterBarPosition(bar) {
    if (!bar) return;
    const props = ["left", "top", "bottom", "right"];
    if (!filterBarPosition) {
      for (const prop of props) bar.style.removeProperty(prop);
      return;
    }
    const maxLeft = Math.max(0, window.innerWidth - bar.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - bar.offsetHeight);
    const left = Math.min(maxLeft, Math.max(0, filterBarPosition.x * window.innerWidth));
    const top = Math.min(maxTop, Math.max(0, filterBarPosition.y * window.innerHeight));
    // שומרים את המיקום המוגבל לחלון, כדי שגרירה אל מחוץ למסך לא תישמר
    filterBarPosition = { x: left / window.innerWidth, y: top / window.innerHeight };
    bar.style.setProperty("left", `${Math.round(left)}px`, "important");
    bar.style.setProperty("top", `${Math.round(top)}px`, "important");
    bar.style.setProperty("bottom", "auto", "important");
    bar.style.setProperty("right", "auto", "important");
  }

  function saveFilterBarPosition() {
    try {
      if (filterBarPosition) chrome.storage.local.set({ [FILTER_BAR_POSITION_KEY]: filterBarPosition });
      else chrome.storage.local.remove(FILTER_BAR_POSITION_KEY);
    } catch {}
  }

  function makeFilterBarDraggable(bar, handle) {
    applyFilterBarPosition(bar);
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = bar.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      bar.dataset.dragging = "true";
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      filterBarPosition = {
        x: (event.clientX - drag.dx) / window.innerWidth,
        y: (event.clientY - drag.dy) / window.innerHeight,
      };
      applyFilterBarPosition(bar);
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      delete bar.dataset.dragging;
      saveFilterBarPosition();
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    handle.addEventListener("dblclick", () => {
      filterBarPosition = null;
      applyFilterBarPosition(bar);
      saveFilterBarPosition();
    });
  }

  window.addEventListener("resize", () => applyFilterBarPosition(brokerageFilterBar), { passive: true });
  try {
    chrome.storage.local.get(FILTER_BAR_POSITION_KEY, (result) => {
      const saved = result && result[FILTER_BAR_POSITION_KEY];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        filterBarPosition = { x: saved.x, y: saved.y };
        applyFilterBarPosition(brokerageFilterBar);
      }
    });
  } catch {}

  // ---------- טקסט של מודעה בודדת ----------
  function mainText() {
    const h1 = document.querySelector("h1");
    const meta = (n) => {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      return el ? el.getAttribute("content") || "" : "";
    };
    const root = document.querySelector("main") || document.body;
    let body = textOf(root, 12000);
    const idx = body.slice(200).search(SIMILAR_MARKERS);
    if (idx >= 0) body = body.slice(0, 200 + idx);
    // כותרת, תיאור ו-meta נותנים לעיתים קרובות כתובת מלאה כולל עיר
    const head = [h1 ? textOf(h1) : "", document.title, meta("og:title"), meta("og:description")]
      .filter(Boolean)
      .join("\n");
    return (head + "\n" + body).slice(0, 8000);
  }

  // ---------- זיהוי כרטיסים ----------
  // הסריקה רצה על כל שינוי בדף; כדי לא לפרסר שוב ושוב את אותן כתובות ולא לטפס שוב בעץ
  // עבור כרטיסים שכבר זוהו, שומרים את התוצאות.
  const hrefPathCache = new Map();
  const anchorCardCache = new WeakMap();

  function hrefPath(href) {
    let path = hrefPathCache.get(href);
    if (path === undefined) {
      try {
        path = new URL(href, location.href).pathname;
      } catch {
        path = null;
      }
      if (hrefPathCache.size > 5000) hrefPathCache.clear();
      hrefPathCache.set(href, path);
    }
    return path;
  }

  function findCards() {
    const byHref = new Map();
    const currentListingPath = LISTING_HREF.test(location.pathname)
      ? location.pathname.replace(/\/+$/, "")
      : null;
    document.querySelectorAll("a[href]").forEach((a) => {
      const path = hrefPath(a.href);
      if (!path || !LISTING_HREF.test(path)) return;
      if (currentListingPath && path.replace(/\/+$/, "") === currentListingPath) return;
      if (!byHref.has(path)) byHref.set(path, []);
      byHref.get(path).push(a);
    });

    const cards = [];
    for (const [path, anchors] of byHref) {
      const anchor = anchors[0];
      const known = anchorCardCache.get(anchor);
      if (known && known.isConnected && entries.has(known) && known.contains(anchor)) {
        cards.push(known);
        continue;
      }
      let el = anchor;
      // עולים עד לאב הגדול ביותר שעדיין מכיל מודעה אחת בלבד
      while (el.parentElement && el.parentElement !== document.body) {
        const parent = el.parentElement;
        if ((parent.textContent || "").length > 1500) break; // לא לטפס עד כל הרשימה
        let hasOther = false;
        for (const x of parent.querySelectorAll("a[href]")) {
          const p = hrefPath(x.href);
          if (p && p !== path && LISTING_HREF.test(p)) {
            hasOther = true;
            break;
          }
        }
        if (hasOther) break;
        el = parent;
      }
      anchorCardCache.set(anchor, el);
      cards.push(el);
    }
    return cards;
  }

  // ---------- תגים ----------
  const fmtNum = (n) => Math.round(n).toLocaleString("he-IL");
  const fmtDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳");

  function mkBadge(extraClass, label) {
    const b = document.createElement("div");
    b.className = "lr-badge " + extraClass;
    const l = document.createElement("span");
    l.className = "lr-label";
    l.textContent = label;
    l.hidden = !label;
    const v = document.createElement("span");
    v.className = "lr-val";
    const s = document.createElement("span");
    s.className = "lr-sub";
    s.hidden = true;
    b.append(l, v, s);
    b._v = v;
    b._s = s;
    b._open = null;
    // כל הטיפול בקליק במקום אחד. stopPropagation כאן לא חוסם את _open,
    // כי אנחנו קוראים לו ישירות (ולא דרך onclick נפרד).
    b.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof b._open === "function") b._open();
      },
      true
    );
    return b;
  }

  // כותבים ל-DOM רק כשהערך באמת השתנה
  function setBadge(b, state, val, sub, title) {
    const cursor = b._open ? "pointer" : "default";
    const signature = [state, val, sub || "", title || "", cursor].join("\u0001");
    if (b._signature === signature) return;
    b._signature = signature;
    b.dataset.state = state;
    b._v.textContent = val;
    b._s.textContent = sub || "";
    b._s.hidden = !sub;
    b.title = title || "";
    b.style.cursor = cursor;
  }

  function createEntry(card, kind) {
    const wrap = document.createElement("div");
    wrap.className = "lr-wrap" + (kind === "single" ? " lr-float" : "");

    const rail = mkBadge("lr-rail", "מרחק מהרכבת");
    const addressNote = document.createElement("span");
    addressNote.className = "lr-address-note";
    addressNote.hidden = true;
    rail._addressNote = addressNote;
    const ppsm = mkBadge("lr-ppsm", "מחיר למ״ר");
    rail.hidden = !CFG.calculateRail;
    ppsm.hidden = !CFG.calculatePpsm;
    const deal = mkBadge("lr-dealtag", "");
    const copyButton = document.createElement("button");
    copyButton.className = "lr-copy-button";
    copyButton.type = "button";
    copyButton.textContent = "📋";
    copyButton.setAttribute("aria-label", "העתקת פרטי המודעה לוואטסאפ");
    const copyTooltip = document.createElement("span");
    copyTooltip.className = "lr-copy-tooltip";
    copyTooltip.hidden = true;
    copyTooltip.setAttribute("role", "tooltip");
    copyButton.setAttribute("aria-describedby", `lr-copy-tooltip-${entries.size}`);
    copyTooltip.id = `lr-copy-tooltip-${entries.size}`;
    const amenityAlert = document.createElement("div");
    const brokerageWarning = document.createElement("span");
    const cacheNote = document.createElement("div");
    amenityAlert.className = "lr-amenity-alert";
    brokerageWarning.className = "lr-brokerage-warning";
    brokerageWarning.textContent = "שים לב: מודעת תיווך";
    brokerageWarning.hidden = true;
    cacheNote.className = "lr-cache-note";
    amenityAlert.setAttribute("role", "alert");
    amenityAlert.hidden = true;
    cacheNote.hidden = true;
    deal.hidden = true;
    deal._v.textContent = "⭐ שווה בדיקה";
    setBadge(rail, "loading", "ממתין…");
    setBadge(ppsm, "loading", "…");
    wrap.append(
      amenityAlert,
      brokerageWarning,
      cacheNote,
      rail,
      addressNote,
      ppsm,
      deal,
      copyButton,
      copyTooltip
    );

    if (kind === "single") {
      document.body.appendChild(wrap);
      card = wrap;
    } else {
      card.appendChild(wrap);
    }

    const entry = {
      kind,
      card,
      wrap,
      rail,
      ppsm,
      deal,
      copyButton,
      copyTooltip,
      amenityAlert,
      brokerageWarning,
      cacheNote,
      brokerageRemoved: false,
      cacheRefreshed: false,
      amenities: null,
      listingId: null,
      getText: kind === "single" ? mainText : memoCardText(card),
      info: null,
      parsed: null,
      res: null,
      tried: [],
      tries: 0,
      started: false,
      priceTries: 0,
      lastTry: 0,
      delta: null,
    };
    copyButton.addEventListener("pointerenter", () =>
      showCopyTooltip(copyButton, copyTooltip, entry)
    );
    copyButton.addEventListener("focus", () =>
      showCopyTooltip(copyButton, copyTooltip, entry)
    );
    copyButton.addEventListener("pointerleave", () => {
      copyTooltip.hidden = true;
    });
    copyButton.addEventListener("blur", () => {
      copyTooltip.hidden = true;
    });
    copyButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyListingMessage(entry, copyButton, copyTooltip);
      },
      true
    );
    return entry;
  }

  function formatCopyData(entry) {
    const parser = IS_YAD2 ? LRYad2 : LRMadlan;
    const root = entry.kind === "single" ? document : entry.card;
    const text = entry.getText();
    const address = parser.readAddress(root, text, ctxCity(), entry.kind === "single");
    const parts = [address.street, address.city].filter(Boolean);
    const stats = parser.extractPriceSqm(root, text);
    const metadata = parser.listingExportData(root);
    const floor = readListingFloor(root);
    const listingRecord = entry.listingId
      ? listingCache[cacheKeyForListing(entry.listingId)]
      : null;
    const amenities =
      entry.amenities ||
      parser.readAmenities(root) ||
      (validCachedAmenities(listingRecord)
        ? listingRecord.amenities
        : {});
    const missingAmenities = Object.entries(amenities)
      .filter(([, present]) => present === false)
      .map(([key]) => AMENITY_LABELS[key] || key);
    const railDistance =
      entry.res && entry.res.ok
        ? `${entry.res.approx ? "כ-" : ""}${fmtDistance(entry.res.meters)}${
            entry.res.approx ? " (מיקום משוער)" : ""
          }`
        : null;
    return {
      address: parts.join(", "),
      price: Number.isFinite(stats.price) ? `₪${fmtNum(stats.price)}` : null,
      sqm: Number.isFinite(stats.sqm) ? stats.sqm : null,
      rooms: Number.isFinite(metadata.rooms) ? metadata.rooms : null,
      floor,
      // תאריך פרסום: מנתוני הדף, ואם אין (למשל בכרטיס חיפוש) – מהמודעה השמורה
      listingCreatedAt:
        (metadata.listingCreatedAt && normalizeListingDate(metadata.listingCreatedAt)) ||
        (listingRecord && listingRecord.listingCreatedAt) ||
        null,
      pricePerSqm: Number.isFinite(stats.ppsm) ? `₪${fmtNum(stats.ppsm)}` : null,
      railDistance,
      missingAmenities,
      // נתוני הדף של יד2 קובעים; רק כשאין בהם תשובה נעזרים גם במה שנשמר על המודעה
      brokerage:
        (IS_YAD2 && LRYad2.brokerageFromData(root) !== null)
          ? LRYad2.brokerageFromData(root)
          : hasBrokerageSignal(
              root === document ? document.querySelector("main") || document.body : root,
              root
            ) || Boolean(listingRecord && listingRecord.brokerage === true),
      url: parser.listingUrl(root) || location.href,
    };
  }

  function readListingFloor(root) {
    const selectors = IS_YAD2
      ? [
          '[data-testid="floor"]',
          '[data-testid="floor-text"]',
          '[data-testid="property-floor"]',
          '[data-auto="floor"]',
        ]
      : root === document
        ? [
            '[data-auto="Overview-block"] [data-auto="floor"]',
            '[data-auto="floor"]',
            '[data-testid="floor"]',
            '[data-auto="property-floor"]',
          ]
        : [
            '[data-auto="property-floor"]',
            '[data-auto="floor"]',
            '[data-testid="floor"]',
          ];
    const floor = LRWhatsAppMessage.readFloor(
      root,
      selectors,
      !IS_YAD2 && root === document ? '[data-auto="Overview-block"]' : null
    );
    if (floor) return floor;

    const floorDetail = [...root.querySelectorAll('[data-testid="building-text"]')].find(
      (element) => /קומה/.test(element.parentElement?.innerText || "")
    );
    return floorDetail
      ? LRWhatsAppMessage.normalizeFloor(floorDetail.parentElement.innerText)
      : null;
  }

  function showCopyTooltip(button, tooltip, entry) {
    tooltip.textContent = LRWhatsAppMessage.format(formatCopyData(entry));
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - tooltipRect.width - 8
    );
    const top =
      rect.top >= tooltipRect.height + 8
        ? rect.top - tooltipRect.height - 8
        : rect.bottom + 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tooltipRect.height - 8))}px`;
  }

  async function copyListingMessage(entry, button, tooltip) {
    const message = LRWhatsAppMessage.format(formatCopyData(entry));
    try {
      await navigator.clipboard.writeText(message);
    } catch (clipboardError) {
      let copied = false;
      let textarea = null;
      try {
        textarea = document.createElement("textarea");
        textarea.value = message;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand("copy");
      } catch (fallbackError) {
        console.warn("[lightrail-ext] clipboard fallback failed", fallbackError);
      } finally {
        try {
          if (textarea && textarea.parentNode) {
            textarea.parentNode.removeChild(textarea);
          }
        } catch (cleanupError) {
          console.warn("[lightrail-ext] clipboard fallback cleanup failed", cleanupError);
        }
      }
      if (!copied) {
        console.warn("[lightrail-ext] could not copy WhatsApp listing message", clipboardError);
        tooltip.textContent = "לא ניתן להעתיק ללוח. בדוק הרשאות clipboard של התוסף.";
        tooltip.hidden = false;
        return;
      }
    }
    button.textContent = "✓";
    tooltip.textContent = "ההודעה הועתקה ללוח";
    tooltip.hidden = false;
    setTimeout(() => {
      button.textContent = "📋";
      if (!button.matches(":hover") && document.activeElement !== button) {
        tooltip.hidden = true;
      }
    }, 1600);
  }

  function renderRail(entry, res) {
    const b = entry.rail;
    entry.res = res;
    b._open = null;

    if (!res || !res.ok) {
      const err = res && res.reason === "error";
      const tried = entry.tried.length ? "ניסינו לחפש: " + entry.tried.join(" | ") : "לא זוהתה כתובת בכרטיס.";
      setBadge(
        b,
        "none",
        err
          ? (res && res.message) || "שגיאה בחישוב"
          : res && res.message
            ? res.message
            : "לא נמצאה כתובת",
        "",
        (err && res.error ? res.error + "\n" : "") + tried
      );
      filterNearRailEntry(entry);
      updateBrokerageFilterStatus();
      return;
    }

    rememberExportMetrics(entry, res);
    const m = res.meters;
    const state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    const walk = m > 4000 ? "" : `🚶 ~${res.walkMin} דק׳ הליכה · `;
    const sub = `${walk}🚉 ${res.station.name}`;
    if (b._addressNote) {
      const address = entry.mapsOrigin || "";
      b._addressNote.textContent = address ? `הכתובת שאיתרתי: ${address}` : "";
      b._addressNote.hidden = !address;
    }
    const title =
      (res.approx
        ? "מרחק בקו אווירי משוער (" + res.matched + "). "
        : "מרחק בקו אווירי לתחנה הקרובה. ") +
      (entry.hasMapsAddress
        ? "לחיצה תפתח בגוגל מפות מסלול הליכה מהרחוב והעיר שזוהו; ייתכן שהמרחק בהליכה יהיה גדול יותר."
        : "לא זוהתה כתובת הכוללת רחוב ועיר, ולכן Google Maps לא ייפתח.");

    if (entry.hasMapsAddress && entry.mapsOrigin) {
      b._open = () => {
        const url = LRLocation.mapsDirectionsUrl(entry.mapsOrigin, res.station.name);
        window.open(url, "_blank", "noopener");
      };
    }
    setBadge(b, state, `${res.approx ? "≈" : ""}${fmtDistance(m)}`, sub, title);
    filterNearRailEntry(entry);
    updateBrokerageFilterStatus();
  }

  // ---------- חישוב רכבת (רק למודעות שנראות / קרובות למסך) ----------
  function startLookup(entry) {
    if (!isRunning || !CFG.calculateRail || entry.started) return;
    if (!listingCacheLoaded) {
      setTimeout(() => {
        if (entry.card.isConnected) startLookup(entry);
      }, 100);
      return;
    }
    entry.started = true;
    const maxTries = entry.kind === "single" ? 5 : 3;

    const attempt = () => {
      if (!isRunning || !CFG.calculateRail || !entry.card.isConnected) return;
      const text = entry.getText();
      const root = entry.kind === "single" ? document : entry.card;
      const siteParser = IS_YAD2 ? LRYad2 : LRMadlan;
      const parsed = siteParser.readAddress(root, text, ctxCity(), entry.kind === "single");
      entry.listingId = siteParser.listingId(root);
      const { queries } = parsed;
      entry.hasMapsAddress = LRLocation.hasListingMapsAddress(parsed, queries, ctxCity());
      entry.mapsOrigin =
        !entry.hasMapsAddress &&
        !IS_YAD2 &&
        LRLocation.validCoordinates(parsed.coordinates) &&
        (!parsed.street || !parsed.city)
          ? `${parsed.coordinates.lat},${parsed.coordinates.lon}`
          : LRLocation.listingMapsOrigin(parsed, queries, ctxCity());
      if (entry.rail._addressNote) {
        entry.rail._addressNote.textContent = entry.mapsOrigin
          ? `הכתובת שאיתרתי: ${entry.mapsOrigin}`
          : "";
        entry.rail._addressNote.hidden = !entry.mapsOrigin;
      }
      if (!queries.length && !LRLocation.validCoordinates(parsed.coordinates)) {
        // ייתכן שהכרטיס עוד לא נטען במלואו – מנסים שוב כמה פעמים
        if (++entry.tries < maxTries) return setTimeout(attempt, 1000);
        renderRail(entry, { ok: false, reason: "not-found" });
        scheduleRefresh();
        return;
      }
      entry.tried = queries.map((q) => q.q);
      setBadge(entry.rail, "loading", "מחשב…");
      try {
        const cachedListing = entry.listingId
          ? listingCache[cacheKeyForListing(entry.listingId)]
          : null;
        const coordinates = LRLocation.validCoordinates(parsed.coordinates)
          ? parsed.coordinates
          : validCachedCoordinates(cachedListing)
            ? cachedListing.coordinates
            : null;
        if (!coordinates && queries.every((query) => query.cityOnly)) {
          renderRail(entry, {
            ok: false,
            reason: "not-found",
            message: "לא אותרה כתובת",
          });
          scheduleRefresh();
          return;
        }
        chrome.runtime.sendMessage({ type: "lookup", queries, bias: pageBias, coordinates }, (res) => {
          if (!isRunning || !CFG.calculateRail || !entry.card.isConnected) return;
          if (chrome.runtime.lastError) {
            renderRail(entry, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
          } else {
            if (res && res.ok && !res.approx) pageBias = res.origin;
            renderRail(entry, res);
          }
          scheduleRefresh();
        });
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        const extensionWasReloaded =
          /extension context invalidated|context invalidated|message port closed/i.test(
            detail
          );
        renderRail(entry, {
          ok: false,
          reason: "error",
          message: extensionWasReloaded
            ? "התוסף עודכן – רענן את הדף"
            : "שגיאה בחישוב",
          error: detail,
        });
      }
    };
    attempt();
  }

  function syncCalculationState({ ppsmChanged = false, railChanged = false } = {}) {
    for (const entry of entries.values()) {
      if (ppsmChanged) entry.ppsm.hidden = !CFG.calculatePpsm;
      if (ppsmChanged && !CFG.calculatePpsm) {
        entry.info = null;
        entry.parsed = null;
        entry.delta = null;
        entry.priceTries = 0;
        entry.lastTry = 0;
      }

      if (!railChanged) continue;
      entry.rail.hidden = !CFG.calculateRail;
      if (entry.projectPage) entry.wrap.hidden = !CFG.calculateRail;
      if (!CFG.calculateRail) {
        io.unobserve(entry.card);
        entry.started = false;
        entry.tries = 0;
        entry.res = null;
        entry.tried = [];
      } else if (isRunning) {
        if (entry.kind === "single") startLookup(entry);
        else io.observe(entry.card);
      }
    }
    scheduleRefresh();
  }

  // ---------- מחיר למ"ר, חציון והדגשה ----------
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function cacheKeyForListing(id) {
    return `${IS_YAD2 ? "yad2" : "madlan"}:${id}`;
  }

  function validCachedAmenities(record, now = Date.now()) {
    return (
      record &&
      record.amenities &&
      Number.isFinite(record.updatedAt) &&
      now - record.updatedAt < LISTING_CACHE_TTL_MS &&
      Object.values(record.amenities).some((value) => typeof value === "boolean")
    );
  }

  function trimListingCache(
    cache,
    now = Date.now(),
    maxBytes = LISTING_CACHE_MAX_BYTES
  ) {
    const records =
      cache && typeof cache === "object" && !Array.isArray(cache)
        ? Object.keys(cache).map((key) => ({ key, record: cache[key] }))
        : [];
    const fresh = records.filter(({ record }) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return false;
      }
      if (record.recordType === "project" || record.recordType === "listing") {
        return (
          Number.isFinite(record.updatedAt) &&
          now - record.updatedAt < LISTING_CACHE_TTL_MS
        );
      }
      return validCachedAmenities(record, now);
    });
    fresh.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
    const trimmed = {};
    let bytes = 2;
    let count = 0;
    for (const { key, record } of fresh) {
      if (count >= LISTING_CACHE_MAX_ITEMS) break;
      // מדידת גודל (JSON.stringify לכל רשומה) רק כשבאמת יש מגבלת בתים
      if (maxBytes !== Infinity) {
        const recordBytes = JSON.stringify([key, record]).length * 2;
        if (bytes + recordBytes > maxBytes) continue;
        bytes += recordBytes;
      }
      trimmed[key] = record;
      count++;
    }
    return trimmed;
  }

  function saveListingCache() {
    if (!CFG.saveListingData) return;
    if (cacheWriteRetryTimer) {
      pendingCacheSave = true;
      return;
    }
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      if (!CFG.saveListingData) return;
      if (!listingCacheLoaded) {
        pendingCacheSave = true;
        return;
      }
      if (cacheWriteInProgress) {
        pendingCacheSave = true;
        return;
      }
      pendingCacheSave = false;
      cacheWriteInProgress = true;
      const maxBytes = LISTING_CACHE_MAX_BYTES;
      writeListingCache(
        trimListingCache(listingCache, Date.now(), maxBytes),
        0,
        maxBytes
      );
    }, 500);
  }

  function writeListingCache(snapshot, attempt, maxBytes) {
    const handleWriteError = (error) => {
      const errorMessage = error && error.message ? error.message : String(error || "");
      const quotaError = /quota|exceed|bytes/i.test(errorMessage);
      if (quotaError && attempt < 16 && Object.keys(snapshot).length > 0) {
        const reducedBytes = Math.max(2, Math.floor(maxBytes / 2));
        const reduced = trimListingCache(snapshot, Date.now(), reducedBytes);
        if (Object.keys(reduced).length > 0) {
          writeListingCache(reduced, attempt + 1, reducedBytes);
          return;
        }
      }
      if (!cacheWriteErrorLogged) {
        console.error("[lightrail-ext] failed to save listing cache", {
          message: errorMessage || "Unknown storage error",
          attempt: attempt + 1,
          recordCount: Object.keys(snapshot).length,
          byteLimit: maxBytes,
        });
        cacheWriteErrorLogged = true;
      }
      cacheWriteInProgress = false;
      cacheWriteFailureCount++;
      const retryDelay = Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(cacheWriteFailureCount, 8));
      if (CFG.saveListingData) {
        pendingCacheSave = false;
        cacheWriteRetryTimer = setTimeout(() => {
          cacheWriteRetryTimer = null;
          saveListingCache();
        }, retryDelay);
      }
    };

    try {
      chrome.storage.local.set({ [LISTING_CACHE_KEY]: snapshot }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          handleWriteError(error);
        } else {
          listingCache = snapshot;
          cacheWriteInProgress = false;
          cacheWriteFailureCount = 0;
          cacheWriteErrorLogged = false;
          clearTimeout(cacheWriteRetryTimer);
          cacheWriteRetryTimer = null;
          if (pendingCacheSave) {
            pendingCacheSave = false;
            saveListingCache();
          }
        }
      });
    } catch (error) {
      handleWriteError(error);
    }
  }

  function rememberListingAmenities(
    id,
    amenities,
    refreshTimestamp = false,
    coordinates = null,
    listingUrl = null,
    listingStats = null
  ) {
    const key = id ? cacheKeyForListing(id) : null;
    if (
      !CFG.saveListingData ||
      !id ||
      cacheWriteSuppressedIds.has(key) ||
      !amenities ||
      !Object.values(amenities).every((value) => typeof value === "boolean")
    ) {
      return;
    }
    const existing = listingCache[key];
    const validCoordinates = LRLocation.validCoordinates(coordinates) ? coordinates : null;
    const manualOverrides = new Set(
      existing && Array.isArray(existing.manualOverrides) ? existing.manualOverrides : []
    );
    const savedAmenities =
      manualOverrides.has("amenities") && existing && existing.amenities
        ? existing.amenities
        : amenities;
    const savedCoordinates = manualOverrides.has("coordinates")
      ? existing && existing.coordinates
      : validCoordinates;
    const existingAmenities =
      existing &&
      existing.amenities &&
      typeof existing.amenities === "object" &&
      !Array.isArray(existing.amenities)
        ? existing.amenities
        : {};
    const stats = {};
    // אותה הגנה כמו בשמירת המודעה: מחיר חשוד (שעוד לא אושר) לא דורס את המחיר השמור
    const suspiciousPrice =
      existing &&
      listingStats &&
      Number.isFinite(listingStats.price) &&
      listingStats.price !== existing.price &&
      LRCacheData.isSuspiciousPrice(
        existing,
        listingStats.price,
        Number.isFinite(listingStats.sqm) ? listingStats.sqm : existing.sqm
      );
    for (const field of ["price", "sqm", "pricePerSqm"]) {
      if (suspiciousPrice && field !== "sqm") continue;
      if (manualOverrides.has(field) && existing && field in existing) {
        stats[field] = existing[field];
      } else if (listingStats && Number.isFinite(listingStats[field])) {
        stats[field] = listingStats[field];
      }
    }
    if (
      listingStats &&
      !suspiciousPrice &&
      !manualOverrides.has("pricePerSqm") &&
      Number.isFinite(listingStats.price) &&
      Number.isFinite(listingStats.sqm) &&
      !Number.isFinite(listingStats.pricePerSqm)
    ) {
      stats.pricePerSqm = null;
    }
    const statsUnchanged = Object.entries(stats).every(
      ([field, value]) => existing && existing[field] === value
    );
    if (
      existing &&
      Object.keys(savedAmenities).every(
        (amenity) => existingAmenities[amenity] === savedAmenities[amenity]
      ) &&
      Object.keys(existingAmenities).length === Object.keys(savedAmenities).length &&
      (!savedCoordinates ||
        (existing.coordinates &&
          existing.coordinates.lat === savedCoordinates.lat &&
          existing.coordinates.lon === savedCoordinates.lon)) &&
      (!listingUrl || existing.url === listingUrl) &&
      statsUnchanged
    ) {
      if (refreshTimestamp || Date.now() - existing.updatedAt >= 24 * 60 * 60 * 1000) {
        listingCache[key] = {
          ...existing,
          ...(savedCoordinates ? { coordinates: savedCoordinates } : {}),
          ...(listingUrl ? { url: listingUrl } : {}),
          updatedAt: Date.now(),
        };
        saveListingCache();
      }
      return;
    }
    listingCache[key] = {
      ...existing,
      amenities: savedAmenities,
      ...(savedCoordinates ? { coordinates: savedCoordinates } : {}),
      ...(existing && validCachedCoordinates(existing) && !savedCoordinates
        ? { coordinates: existing.coordinates }
        : {}),
      ...(listingUrl ? { url: listingUrl } : existing && existing.url ? { url: existing.url } : {}),
      ...stats,
      updatedAt: Date.now(),
    };
    saveListingCache();
  }

  // השוואה לפי ערך: אובייקטים כמו coordinates נוצרים מחדש בכל קריאה, והשוואת === הייתה
  // מסמנת אותם תמיד כ"שונים" – מה שגרם לכתיבה חוזרת ונשנית של כל המטמון.
  function sameCacheValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  function recordUnchanged(record, previous) {
    return Object.entries(record).every(
      ([field, value]) => field === "updatedAt" || sameCacheValue(previous[field], value)
    );
  }

  function preserveManualOverrides(record, previous) {
    if (!previous || !Array.isArray(previous.manualOverrides)) return record;
    for (const field of previous.manualOverrides) {
      if (Object.prototype.hasOwnProperty.call(previous, field)) {
        record[field] = previous[field];
      }
    }
    return record;
  }

  function rememberProjectData(project) {
    if (!CFG.saveListingData || !listingCacheLoaded || !project || !project.id) return;
    const id = `project-${project.id}`;
    const key = cacheKeyForListing(id);
    if (cacheWriteSuppressedIds.has(key)) return;
    const existing = listingCache[key] || {};
    const record = preserveManualOverrides({
      ...existing,
      ...project,
      recordType: "project",
      updatedAt: existing.updatedAt || Date.now(),
    }, existing);
    if (recordUnchanged(record, existing)) return;
    record.updatedAt = Date.now();
    listingCache[key] = record;
    saveListingCache();
  }

  function rememberExportMetrics(entry, result) {
    if (!CFG.saveListingData || !listingCacheLoaded || !result || !result.ok) return;
    const metrics = {
      railMeters: Number.isFinite(result.meters) ? result.meters : null,
      railApprox: Boolean(result.approx),
      railStation: result.station && result.station.name ? result.station.name : "",
    };
    if (entry.projectPage) {
      const parser = IS_YAD2 ? LRYad2 : LRMadlan;
      const project = parser.projectExportData(document, entry.getText());
      if (project) rememberProjectData({ ...project, ...metrics });
      return;
    }

    rememberListingExportData(entry, metrics);
  }

  function rememberListingExportData(entry, extra = {}) {
    if (
      !CFG.saveListingData ||
      !listingCacheLoaded ||
      (entry.kind === "list" && CFG.listingIndexingMode !== "encountered")
    ) return;
    const parser = IS_YAD2 ? LRYad2 : LRMadlan;
    const root = entry.kind === "single" ? document : entry.card;
    if (isRentalListing(entry)) return;
    // מדלן: כרטיס פרויקט בחיפוש ("החל מ־...") הוא לא מודעה – לא נשמר כמודעה
    if (entry.kind === "list" && !IS_YAD2 && LRMadlan.isProjectCard(root)) return;
    const id = parser.listingId(root);
    if (!id) return;
    const key = cacheKeyForListing(id);
    if (cacheWriteSuppressedIds.has(key)) return;
    const previous = listingCache[key] || {};
    const text = entry.getText();
    const stats = parser.extractPriceSqm(root, text);
    const listingMetadata = parser.listingExportData(root);
    const address = parser.readAddress(root, text, ctxCity(), entry.kind === "single");
    const fromSearch = entry.kind === "list";
    if (fromSearch) {
      // מכרטיס בתוצאות החיפוש יש מעט מידע: מחיר נמוך מרצפת השפיות לא נרשם (שכירות/כרטיס שעוד נטען)
      if (Number.isFinite(stats.price) && stats.price < SEARCH_INDEX_MIN_PRICE) stats.price = null;
      if (!listingCache[key]) {
        if (!searchCardIndexable(parser, root, stats, listingMetadata, address)) return;
        if (CFG.indexMinPrice > 0 && stats.price < CFG.indexMinPrice) return;
        if (CFG.indexMaxPrice > 0 && stats.price > CFG.indexMaxPrice) return;
        if (!LRStreetFilter.cityAllowed(CFG.indexCities, address.city)) return;
      }
    }
    const observedPrice = Number.isFinite(stats.price) ? stats.price : null;
    // מחיר שנראה כמו פענוח שגוי (קפיצה חדה או מחיר למ״ר בלתי אפשרי) לא נרשם כשינוי מחיר
    // ולא דורס את המחיר השמור; כל תצפית שומרת גם את המקור (עמוד מודעה / כרטיס חיפוש)
    // מדלן: המחיר הקודם שמוצג בכרטיס חיפוש (מחוק) נכנס להיסטוריה אם אין לנו אותו
    const withPreviousPrice = LRCacheData.withCardPreviousPrice(
      previous,
      listingMetadata.previousPrice,
      observedPrice
    );
    const { accepted: priceAccepted, ...priceObservation } = LRCacheData.recordPriceObservation(
      withPreviousPrice,
      observedPrice,
      Date.now(),
      {
        source: fromSearch ? "search" : "page",
        sqm: Number.isFinite(stats.sqm) ? stats.sqm : previous.sqm,
      }
    );
    // מדלן שולחת את היסטוריית המחירים המלאה עם תאריכים – היא גוברת על התצפיות שלנו
    const siteEvents = listingMetadata.priceEvents;
    const siteHistory = siteEvents
      ? LRCacheData.mergeSiteHistory(priceObservation.priceHistory, siteEvents)
      : null;
    if (siteHistory) priceObservation.priceHistory = siteHistory;
    const siteConfirmsPrice = Boolean(siteEvents) && siteEvents[siteEvents.length - 1].price === stats.price;
    if (siteConfirmsPrice) {
      priceObservation.observedPrice = stats.price;
      priceObservation.suspectPrice = undefined;
      priceObservation.suspectCount = undefined;
    }
    const priceUsable = Number.isFinite(stats.price) && (priceAccepted || siteConfirmsPrice);
    // מחיר נוכחי שנדחה כחשוד – גם המחיר הקודם מהכרטיס לא נכנס
    if (!priceUsable && !siteHistory && withPreviousPrice !== previous) {
      priceObservation.priceHistory = Array.isArray(previous.priceHistory) ? previous.priceHistory : [];
    }
    const listingHeading =
      root.querySelector("h1") ||
      (entry.kind === "list" ? root.querySelector('[data-testid="ad-card-title"]') : null);
    const record = preserveManualOverrides({
      ...previous,
      recordType: "listing",
      title: (listingHeading && listingHeading.innerText.trim()) || previous.title || "",
      address: [address.street, address.city].filter(Boolean).join(", "),
      city: address.city || "",
      neighborhood: address.hood || "",
      url: parser.listingUrl(root) || previous.url || "",
      coordinates: LRLocation.validCoordinates(address.coordinates)
        ? address.coordinates
        : previous.coordinates,
      // מחיר שלא פורסם ("למידע נוסף") מוחק מחיר שגוי שנשמר בעבר, במקום להשאיר אותו
      price: stats.priceHidden ? null : priceUsable ? stats.price : previous.price,
      ...priceObservation,
      sqm: Number.isFinite(stats.sqm) ? stats.sqm : previous.sqm,
      pricePerSqm: stats.priceHidden
        ? null
        : priceUsable && Number.isFinite(stats.ppsm) ? stats.ppsm : previous.pricePerSqm,
      priceHidden: stats.priceHidden ? true : undefined,
      rooms: Number.isFinite(listingMetadata.rooms) ? listingMetadata.rooms : previous.rooms,
      listingCreatedAt:
        (listingMetadata.listingCreatedAt &&
          normalizeListingDate(listingMetadata.listingCreatedAt)) ||
        previous.listingCreatedAt,
      listingUpdatedAt:
        (listingMetadata.listingUpdatedAt &&
          normalizeListingDate(listingMetadata.listingUpdatedAt)) ||
        previous.listingUpdatedAt,
      listingBumpedAt:
        (listingMetadata.listingBumpedAt &&
          normalizeListingDate(listingMetadata.listingBumpedAt)) ||
        previous.listingBumpedAt,
      brokerage: hasBrokerageSignal(
        root === document ? document.querySelector("main") || document.body : root,
        root
      ),
      ...listingAgeFields(
        (listingMetadata.listingCreatedAt && normalizeListingDate(listingMetadata.listingCreatedAt)) ||
          previous.listingCreatedAt
      ),
      // "search" = נשמרה רק מכרטיס בתוצאות החיפוש (מידע חלקי); "page" = עמוד המודעה נפתח
      indexedFrom: fromSearch ? previous.indexedFrom || "search" : "page",
      ...extra,
    }, previous);
    if (recordUnchanged(record, previous)) return;
    record.updatedAt = Date.now();
    listingCache[key] = record;
    saveListingCache();
  }

  // מודעות שכירות לא נשמרות במטמון (התוסף מיועד לחיפוש רכישה)
  const RENTAL_WORD = /(?:^|[\s:|,–-])(?:להשכרה|השכרה|לשכירות|שכירות)(?=$|[\s:|,–-])/;
  function isRentalListing(entry) {
    if (/\/(?:realestate\/rent|for-rent|rent)(?:\/|$|\?)/i.test(location.pathname)) return true;
    const root = entry.kind === "single" ? document : entry.card;
    if (!root || !root.querySelector) return false;
    const text = entry.getText();
    if (entry.rentalText === text) return entry.rental;
    const label = (selector) => {
      const node = root.querySelector(selector);
      return node ? node.textContent.trim() : "";
    };
    // יד2: "סוג העסקה: השכרה" בפרטים נוספים; מדלן: "דירה להשכרה" מתחת לכתובת
    const dealType = label('[data-testid="deal-type-value"]');
    // כותרת הדף, למשל "דירה להשכרה: הרב ניימן 10, ... | מדלן" (רק בעמוד מודעה)
    const heading = entry.kind === "single" ? String(document.title || "").split(/[:|]/)[0] : "";
    let rental;
    if (dealType) rental = RENTAL_WORD.test(` ${dealType}`);
    else if (/למכירה|להשכרה|לשכירות/.test(heading)) rental = RENTAL_WORD.test(` ${heading}`);
    else rental = RENTAL_WORD.test(` ${label('[data-auto="secondary_address"]')}`);
    entry.rentalText = text;
    entry.rental = rental;
    return rental;
  }

  // כללי מינימום להוספת מודעה חדשה מתוצאות החיפוש: קישור, מחיר תקין, מיקום ופרט נכס אחד לפחות
  function searchCardIndexable(parser, root, stats, listingMetadata, address) {
    if (!parser.listingUrl(root)) return false;
    if (!Number.isFinite(stats.price) || stats.price <= 0) return false;
    if (!address.street && !address.city) return false;
    return Number.isFinite(stats.sqm) || Number.isFinite(listingMetadata.rooms);
  }

  // גיל המודעה נשמר ברשומה בכל שמירה/רענון, כדי שמנהל המידע יציג אותו בלי לחשב בכל ציור.
  // listingAgeAt = מתי חושב (יום שלם), כך שהרשומה נשמרת מחדש לכל היותר פעם ביום בגלל הגיל.
  function listingAgeFields(createdAt) {
    const created = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(created)) return {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.floor((today.getTime() - created) / 86400000));
    return { listingAgeDays: days, listingAgeAt: today.getTime() };
  }

  function normalizeListingDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const timestamp = value < 1e12 ? value * 1000 : value;
      const date = new Date(timestamp);
      return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
    }
    const text = String(value || "").trim();
    const localDate = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (localDate) {
      const year = localDate[3].length === 2 ? `20${localDate[3]}` : localDate[3];
      const iso = `${year}-${localDate[2].padStart(2, "0")}-${localDate[1].padStart(2, "0")}`;
      const date = new Date(`${iso}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso
        ? iso
        : "";
    }
    const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate) return isoDate[1];
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
  }

  // שינוי המחיר מאז התצפית הראשונה במטמון, למשל "↓ ירד ב־₪50,000 (3%) מאז 12.10"
  function priceChangeText(record) {
    const history = Array.isArray(record && record.priceHistory)
      ? record.priceHistory.filter((point) => point && Number.isFinite(point.price) && point.price > 0)
      : [];
    if (history.length < 2) return "";
    const first = history[0];
    const last = history[history.length - 1];
    const diff = last.price - first.price;
    if (!diff) return "";
    const pct = Math.round((Math.abs(diff) / first.price) * 100);
    const since = Number.isFinite(first.at)
      ? ` מאז ${new Date(first.at).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}`
      : "";
    const amount = `₪${Math.abs(diff).toLocaleString("he-IL")}`;
    return diff < 0
      ? `↓ ירד ב־${amount}${pct ? ` (${pct}%)` : ""}${since}`
      : `↑ עלה ב־${amount}${pct ? ` (${pct}%)` : ""}${since}`;
  }

  // כמה זמן המודעה באוויר לפי תאריך היצירה שנשמר
  function listingAgeText(record) {
    const created = record && record.listingCreatedAt ? Date.parse(record.listingCreatedAt) : NaN;
    if (!Number.isFinite(created)) return "";
    const days = Math.floor((Date.now() - created) / 86400000);
    if (days < 0) return "";
    if (days === 0) return "פורסמה היום";
    if (days === 1) return "באוויר יום אחד";
    return `באוויר ${days.toLocaleString("he-IL")} ימים`;
  }

  function renderCachedAmenities(entry) {
    if (entry.kind !== "list" || !entry.cacheNote) return;
    const record = entry.listingId ? listingCache[cacheKeyForListing(entry.listingId)] : null;
    const parts = [];
    let state = "info";
    let missing = [];
    if (validCachedAmenities(record) && CFG.requiredAmenities.length > 0) {
      missing = CFG.requiredAmenities
        .filter((amenity) => record.amenities[amenity] !== true)
        .map((amenity) => AMENITY_LABELS[amenity] || amenity);
      state = missing.length ? "missing" : "matches";
      parts.push(missing.length
        ? `נבדקה בעבר · חסר: ${missing.join(", ")}`
        : "נבדקה בעבר · דרישות החובה קיימות");
    }
    const relevance = record
      ? LRCacheData.amenityRelevance(
          record,
          CFG.requiredAmenities,
          CFG.irrelevantMissingPct,
          CFG.dealBreakerAmenities
        )
      : { irrelevant: false, dealBreakerMissing: [] };
    const irrelevant = relevance.irrelevant;
    if (irrelevant) {
      const breakers = relevance.dealBreakerMissing.map((amenity) => AMENITY_LABELS[amenity] || amenity);
      const reason = breakers.length
        ? `חסר דיל ברייקר: ${breakers.join(", ")}`
        : (parts[0] || "").replace("נבדקה בעבר · ", "");
      if (parts.length) parts[0] = `לא רלוונטית · ${reason}`;
      else parts.push(`לא רלוונטית · ${reason}`);
      state = "missing";
    }
    if (record && CFG.showPriceChange) {
      const change = priceChangeText(record);
      if (change) parts.push(change);
    }
    if (record && CFG.showListingAge) {
      const age = listingAgeText(record);
      if (age) parts.push(age);
      // מדד לחץ למכור (ימים באוויר + הורדות מחיר); מוצג רק כשהוא בינוני או גבוה
      const pressure = LRCacheData.sellerPressure(record);
      if (pressure && pressure.level !== "low") {
        parts.push(`לחץ למכור ${pressure.score}/100 (${LRCacheData.PRESSURE_LABELS[pressure.level]})`);
      }
    }
    entry.card.classList.toggle("lr-irrelevant-removed", irrelevant && CFG.hideIrrelevant);
    entry.card.classList.toggle("lr-cache-missing", missing.length > 0);
    if (!parts.length) {
      if (!entry.cacheNote.hidden) entry.cacheNote.hidden = true;
      return;
    }
    const text = parts.join(" · ");
    const signature = `${record.updatedAt}|${state}|${text}`;
    if (entry.cacheNote.dataset.signature !== signature) {
      entry.cacheNote.dataset.signature = signature;
      entry.cacheNote.dataset.state = state;
      entry.cacheNote.textContent = text;
      entry.cacheNote.title = `נשמר לאחרונה בתאריך ${new Date(record.updatedAt).toLocaleDateString("he-IL")}`;
    }
    if (entry.cacheNote.hidden) entry.cacheNote.hidden = false;
  }

  function refreshAll() {
    if (!isRunning) return;
    refreshTimer = null;
    const now = Date.now();

    // ניקוי כרטיסים שנעלמו, וניסיון חוזר לחלץ מחיר/שטח מכרטיסים שעוד נטענים
    for (const [key, entry] of entries) {
      if (!key.isConnected) {
        io.unobserve(key);
        entries.delete(key);
        continue;
      }
      if (entry.projectPage) {
        if (CFG.saveListingData && listingCacheLoaded) {
          const projectParser = IS_YAD2 ? LRYad2 : LRMadlan;
          rememberProjectData(projectParser.projectExportData(document, entry.getText()));
        }
        entry.ppsm.hidden = true;
        entry.deal.hidden = true;
        entry.amenityAlert.hidden = true;
        entry.cacheNote.hidden = true;
        continue;
      }
      const root = entry.kind === "single" ? document : entry.card;
      const siteParser = IS_YAD2 ? LRYad2 : LRMadlan;
      if (!CFG.calculatePpsm) {
        entry.info = null;
        entry.parsed = null;
        entry.delta = null;
        entry.ppsm.hidden = true;
      } else if (IS_YAD2 && entry.kind === "single") {
        entry.parsed = siteParser.extractPriceSqm(root, entry.getText());
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      } else if (!entry.info && entry.priceTries < 8 && now - entry.lastTry > 1500) {
        entry.priceTries++;
        entry.lastTry = now;
        const text = entry.getText();
        entry.parsed = siteParser.extractPriceSqm(root, text);
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      }
      entry.listingId = siteParser.listingId(root);
      const currentAmenities = (IS_YAD2 ? LRYad2 : LRMadlan).readAmenities(root);
      if (entry.kind === "single") {
        rememberListingExportData(entry);
      } else if (CFG.listingIndexingMode === "encountered") {
        // כרטיס ברשימה: מנתחים ושומרים מחדש רק אם הטקסט שלו השתנה או שהרשומה חסרה במטמון
        const cardText = entry.getText();
        const cached = entry.listingId && listingCache[cacheKeyForListing(entry.listingId)];
        if (cardText !== entry.lastExportText || !cached) {
          entry.lastExportText = cardText;
          rememberListingExportData(entry);
        }
      }
      if (entry.kind === "single" && currentAmenities) {
        entry.amenities = currentAmenities;
        const listingText = entry.getText();
        const listingStats = siteParser.extractPriceSqm(root, listingText);
        const address = siteParser.readAddress(
          root,
          listingText,
          ctxCity(),
          true
        );
        const cachedListing = entry.listingId
          ? listingCache[cacheKeyForListing(entry.listingId)]
          : null;
        if (!isRentalListing(entry)) rememberListingAmenities(
          entry.listingId,
          currentAmenities,
          !entry.cacheRefreshed ||
            (!validCachedCoordinates(cachedListing) &&
              LRLocation.validCoordinates(address.coordinates)),
          address.coordinates,
          siteParser.listingUrl(root),
          {
            price: listingStats.price,
            sqm: listingStats.sqm,
            pricePerSqm: listingStats.ppsm,
          }
        );
        entry.cacheRefreshed = true;
      } else {
        const cached = entry.listingId ? listingCache[cacheKeyForListing(entry.listingId)] : null;
        entry.amenities = validCachedAmenities(cached) ? cached.amenities : currentAmenities;
      }
      renderCachedAmenities(entry);
      filterBrokerageEntry(entry);
      filterNearRailEntry(entry);
      filterStreetEntry(entry);
      const listingRoot =
        entry.kind === "single"
          ? document.querySelector("main") || document.body
          : entry.card;
      // בכרטיס ברשימה – רק אם הטקסט או ההגדרה השתנו מאז הפעם הקודמת
      const highlightKey =
        entry.kind === "list" ? `${CFG.avoidBrokerage}|${entry.getText()}` : null;
      if (!highlightKey || highlightKey !== entry.lastHighlightKey) {
        entry.lastHighlightKey = highlightKey;
        highlightBrokerage(listingRoot, CFG.avoidBrokerage);
        entry.brokerageWarning.hidden = !hasBrokerageSignal(
          listingRoot,
          entry.kind === "single" ? document : entry.card
        );
      }
      if (entry.kind === "single") {
        const missing = CFG.requiredAmenities
          .filter((amenity) => entry.amenities && entry.amenities[amenity] === false)
          .map((amenity) => AMENITY_LABELS[amenity] || amenity);
        const unknown = CFG.requiredAmenities
          .filter((amenity) => !entry.amenities || entry.amenities[amenity] === undefined)
          .map((amenity) => AMENITY_LABELS[amenity] || amenity);
        const notices = [];
        if (missing.length) notices.push(`אין בדירה: ${missing.join(", ")}`);
        if (unknown.length) notices.push(`לא ניתן לאמת: ${unknown.join(", ")}`);
        const notice = notices.length ? `שים לב! ${notices.join(" · ")}` : "";
        if (entry.amenityAlert.hidden !== !notice) entry.amenityAlert.hidden = !notice;
        if (notices.length) {
          if (entry.amenityAlert.textContent !== notice) entry.amenityAlert.textContent = notice;
        }
      }
    }

    // חציון מחיר למ"ר של המודעות ברשימה
    const values = [];
    for (const e of entries.values()) {
      if (CFG.calculatePpsm && e.kind === "list" && e.info) values.push(e.info.ppsm);
    }
    const med = values.length >= CFG.MIN_SAMPLES ? median(values) : null;

    // שומרים את החציון לשימוש בדף מודעה בודדת (רק כשנמצאים בדף רשימה)
    if (CFG.calculatePpsm && med && !main && (!storedMedian || Math.abs(storedMedian.value - med) / med > 0.01)) {
      storedMedian = { value: med, n: values.length, at: now };
      try {
        chrome.storage.local.set({ lastMedian: storedMedian });
      } catch {}
    }

    for (const entry of entries.values()) {
      const { info, ppsm, deal, res, parsed } = entry;

      // איזה חציון להשוות אליו
      let refMed = med;
      let refLabel = `חציון הדף (${values.length} מודעות)`;
      if (entry.kind === "single") {
        if (storedMedian) {
          refMed = storedMedian.value;
          refLabel = `חציון החיפוש האחרון (${storedMedian.n} מודעות)`;
        } else if (med) {
          refLabel = `חציון מודעות דומות בדף (${values.length})`;
        }
      }

      // ---- מחיר למ"ר ----
      entry.delta = null;
      if (CFG.calculatePpsm && info) {
        let sub = "";
        let state = "neutral";
        if (refMed) {
          entry.delta = (info.ppsm - refMed) / refMed;
          const pct = Math.round(Math.abs(entry.delta) * 100);
          if (pct >= 3) sub = `${entry.delta < 0 ? "−" : "+"}${pct}% מהחציון`;
          state = entry.delta <= -0.05 ? "good" : entry.delta >= 0.05 ? "bad" : "neutral";
        }
        // אם המשתמש קבע תקרת מחיר למ"ר – הצבע נקבע לפיה
        if (CFG.maxPpsm > 0) state = info.ppsm <= CFG.maxPpsm ? "good" : "neutral";

        setBadge(
          ppsm,
          state,
          `₪${fmtNum(info.ppsm)}`,
          sub,
          `מחיר ₪${fmtNum(info.price)} ÷ ${info.sqm} מ״ר.` +
            (refMed
              ? ` ${refLabel}: ₪${fmtNum(refMed)}.`
              : ` צריך לפחות ${CFG.MIN_SAMPLES} מודעות בדף כדי להשוות לחציון.`)
        );
      } else if (CFG.calculatePpsm && parsed && parsed.reason) {
        setBadge(
          ppsm,
          "none",
          "—",
          parsed.reason,
          `מחיר שזוהה: ${parsed.price ? "₪" + fmtNum(parsed.price) : "אין"} · שטח שזוהה: ${
            parsed.sqm ? parsed.sqm + " מ״ר" : "אין"
          }`
        );
      }

      // ---- הדגשת מודעה שווה: כל התנאים שהמשתמש הפעיל צריכים להתקיים ----
      const reasons = [];
      let ok = true;

      const nearRail = Boolean(res && res.ok && !res.approx && res.meters <= CFG.nearM);
      if (CFG.calculateRail && CFG.requireRail) {
        ok = ok && nearRail;
        if (nearRail) reasons.push(`עד ${CFG.nearM} מ׳ מהרכבת הקלה`);
      }
      if (CFG.calculatePpsm && CFG.maxPpsm > 0) {
        const pass = Boolean(info && info.ppsm <= CFG.maxPpsm);
        ok = ok && pass;
        if (pass) reasons.push(`עד ₪${fmtNum(CFG.maxPpsm)} למ״ר`);
      }
      if (CFG.calculatePpsm && CFG.belowMedianPct > 0) {
        const pass = entry.delta !== null && entry.delta <= -CFG.belowMedianPct / 100;
        ok = ok && pass;
        if (pass) reasons.push(`${Math.round(-entry.delta * 100)}% מתחת לחציון`);
      }
      for (const amenity of CFG.requiredAmenities) {
        if (!entry.amenities || entry.amenities[amenity] !== true) ok = false;
      }
      // בלי אף תנאי פעיל לא מדגישים כלום
      const hasRule =
        (CFG.calculateRail && CFG.requireRail) ||
        (CFG.calculatePpsm && CFG.maxPpsm > 0) ||
        (CFG.calculatePpsm && CFG.belowMedianPct > 0) ||
        CFG.requiredAmenities.length > 0;
      const isDeal = Boolean(CFG.highlight && hasRule && ok);

      deal.hidden = !isDeal;
      if (isDeal) deal.title = reasons.join(" · ");
      (entry.kind === "single" ? entry.wrap : entry.card).classList.toggle("lr-deal-card", isDeal);
    }
    updateBrokerageFilterStatus();
  }

  function scheduleRefresh() {
    if (!isRunning || refreshTimer) return;
    refreshTimer = setTimeout(refreshAll, 250);
  }

  // ---------- סריקה ----------
  function processCard(card) {
    if (entries.has(card)) return;
    const entry = createEntry(card, "list");
    entries.set(card, entry);
    if (CFG.calculateRail) io.observe(card);
    setTimeout(scheduleRefresh, 1500); // לתפוס כרטיסים שנטענים בהדרגה
  }

  // דף מודעה בודדת: פאנל צף עם אותם נתונים
  function ensureMain() {
    const isItem = LISTING_HREF.test(location.pathname);
    const isProject = isProjectDetailPage();
    if (main && ((!isItem && !isProject) || main.path !== location.pathname)) {
      main.entry.wrap.remove();
      entries.delete(main.entry.card);
      main = null;
    }
    if ((!isItem && !isProject) || main) return;
    if (!document.querySelector("h1") && (document.body.innerText || "").length < 300) return; // עוד לא נטען

    const entry = createEntry(null, "single");
    entry.projectPage = isProject;
    if (isProject) {
      entry.wrap.hidden = !CFG.calculateRail;
      entry.ppsm.hidden = true;
      entry.deal.hidden = true;
      entry.amenityAlert.hidden = true;
      entry.cacheNote.hidden = true;
    }
    entries.set(entry.card, entry);
    main = { entry, path: location.pathname };
    setTimeout(() => startLookup(entry), 800);
    setTimeout(scheduleRefresh, 1200);
  }

  function scan() {
    if (!isRunning) return;
    scanTimer = null;
    try {
      ensureMain();
      if (!isProjectDetailPage()) {
        findCards().forEach(processCard);
        processProjectCards();
      }
      scheduleRefresh();
    } catch (e) {
      console.warn("[lightrail-ext] scan failed", e);
    }
  }

  function scheduleScan() {
    if (!isRunning || scanTimer) return;
    scanTimer = setTimeout(scan, 600);
  }

  function isOwnNode(node) {
    const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return Boolean(element && element.closest && element.closest(".lr-wrap, #lr-brokerage-filter"));
  }

  function isOwnMutation(record) {
    if (isOwnNode(record.target)) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return (
      nodes.length > 0 &&
      nodes.every(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          node.classList &&
          (node.classList.contains("lr-wrap") || node.id === "lr-brokerage-filter")
      )
    );
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    createBrokerageFilterBar();
    pageObserver = new MutationObserver((records) => {
      // שינויים שהתוסף עצמו עשה בתגים שלו לא מצדיקים סריקה חוזרת
      if (records.every(isOwnMutation)) return;
      scheduleScan();
    });
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    scan();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    clearTimeout(scanTimer);
    clearTimeout(refreshTimer);
    scanTimer = null;
    refreshTimer = null;
    if (pageObserver) pageObserver.disconnect();
    pageObserver = null;
    io.disconnect();
    for (const entry of entries.values()) {
      if (entry.kind === "list") {
        entry.card.classList.remove(
          "lr-brokerage-removed",
          "lr-cache-missing",
          "lr-deal-card",
          "lr-project-removed",
          "lr-not-near-rail",
          "lr-street-removed",
          "lr-irrelevant-removed"
        );
        highlightBrokerage(entry.card, false);
      }
      entry.wrap.remove();
    }
    entries.clear();
    projectCards.clear();
    if (main) {
      main.entry.wrap.remove();
      main = null;
    }
    if (brokerageFilterBar) {
      brokerageFilterBar.remove();
      brokerageFilterBar = null;
    }
    highlightBrokerage(document.querySelector("main") || document.body, false);
  }

  // הסתרת פרסומות ביד2: מחלקה על <html> וכללי CSS ב-content.css (בלי לולאות JS ובלי למחוק
  // צמתים ש-React מנהל). מופעל מיד עם ברירת המחדל, כדי שהפרסומות לא יהבהבו עד שההגדרות נטענות.
  function syncAdHiding() {
    document.documentElement.classList.toggle(
      "lr-hide-ads",
      Boolean(IS_YAD2 && CFG.hideAds && !CFG[SITE_DISABLE_KEY])
    );
  }
  syncAdHiding();

  function updateSiteState() {
    syncAdHiding();
    if (CFG[SITE_DISABLE_KEY]) stop();
    else start();
  }

  // טוענים את ההגדרות לפני שמתחילים, ומעדכנים את הדף מיד כשהמשתמש משנה הגדרה
  const NUM_KEYS = ["maxPpsm", "belowMedianPct", "nearM", "indexMinPrice", "indexMaxPrice", "irrelevantMissingPct"];
  // רצפת שפיות קבועה למחיר מכרטיס חיפוש: מסננת שכירות וכרטיסים שעוד נטענים
  const SEARCH_INDEX_MIN_PRICE = 100000;
  const AMENITY_LABELS = {
    parking: "חניה",
    secureRoom: "ממ״ד",
    elevator: "מעלית",
    storage: "מחסן",
    airConditioner: "מיזוג אוויר",
    accessible: "נגיש לנכים",
    balcony: "מרפסת",
    sunBoiler: "דוד שמש",
    grating: "סורגים",
    garden: "גינה",
    pool: "בריכה",
  };
  function applySettings(s) {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      if (k === "requiredAmenities") {
        CFG[k] = Array.isArray(s[k])
          ? s[k].filter((amenity) => Object.prototype.hasOwnProperty.call(AMENITY_LABELS, amenity))
          : [...DEFAULTS.requiredAmenities];
      } else if (k === "listingIndexingMode") {
        CFG[k] = s[k] === "opened" ? "opened" : "encountered";
      } else if (k === "dealBreakerAmenities") {
        CFG[k] = Array.isArray(s[k])
          ? s[k].filter((amenity) => Object.prototype.hasOwnProperty.call(AMENITY_LABELS, amenity))
          : [];
      } else if (k === "indexCities") {
        CFG[k] = Array.isArray(s[k]) ? s[k].map(String) : [];
      } else if (k === "blockedStreets") {
        CFG[k] = Array.isArray(s[k]) ? s[k].map(String) : [];
        blockedStreetRules = LRStreetFilter.parseRules(CFG[k]);
      } else {
        CFG[k] = NUM_KEYS.includes(k) ? Math.max(0, Number(s[k]) || 0) : Boolean(s[k]);
      }
    }
  }

  if (IS_YAD2) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "lightrail:get-yad2-listing-status") return false;
      sendResponse(LRYad2.listingPageStatus());
      return false;
    });
  }

  // דפדוף בעמודי חיפוש (ממנהל המידע): גלילה איטית עד סוף העמוד, כדי שכל הכרטיסים ייטענו וייאספו
  let walkerScroll = null;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "lightrail:walker-stop-scroll") {
      if (walkerScroll) walkerScroll.stopped = true;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "lightrail:walker-scroll") return false;
    if (walkerScroll) walkerScroll.stopped = true;
    const run = { stopped: false };
    walkerScroll = run;
    LRPageWalker.slowScrollToBottom(LRPageWalker.browserScrollEnv(window), {
      speed: message.speed,
      shouldStop: () => run.stopped,
    }).then((result) => {
      if (walkerScroll === run) walkerScroll = null;
      // נותנים לסורק הכרטיסים רגע לעבד את האחרונים לפני הספירה
      setTimeout(() => {
        const cards = [...entries.values()].filter((entry) => entry.kind === "list").length;
        sendResponse({ ...result, cards });
      }, 800);
    }).catch((error) => {
      sendResponse({ reason: "error", error: String(error && error.message || error), cards: 0 });
    });
    return true;
  });

  try {
    chrome.storage.local.get(["lastMedian", LISTING_CACHE_KEY], (r) => {
      const m = r && r.lastMedian;
      if (m && Date.now() - m.at < 14 * 24 * 3600 * 1000) storedMedian = m;
      if (chrome.runtime.lastError) {
        console.warn("[lightrail-ext] failed to load listing cache", chrome.runtime.lastError.message);
        listingCacheLoaded = true;
        scheduleRefresh();
      } else {
        const storedCache = (r && r[LISTING_CACHE_KEY]) || {};
        listingCache = trimListingCache({ ...storedCache, ...listingCache });
        listingCacheLoaded = true;
        if (Object.keys(listingCache).length !== Object.keys(storedCache).length) {
          saveListingCache();
        }
        if (pendingCacheSave) saveListingCache();
        scheduleRefresh();
      }
    });
    chrome.storage.sync.get(DEFAULTS, (s) => {
      applySettings(s || {});
      updateSiteState();
      syncCalculationState({ ppsmChanged: true, railChanged: true });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[LISTING_CACHE_KEY]) {
        if (!changes[LISTING_CACHE_KEY].newValue) {
          for (const entry of entries.values()) {
            if (entry.listingId) cacheWriteSuppressedIds.add(cacheKeyForListing(entry.listingId));
          }
          if (main && !main.entry.listingId) {
            const id = (IS_YAD2 ? LRYad2 : LRMadlan).listingId(document);
            if (id) cacheWriteSuppressedIds.add(cacheKeyForListing(id));
          }
        }
        // הכותב כבר אכף את מגבלת הגודל, אין צורך למדוד שוב בכל כרטיסייה
        listingCache = trimListingCache(changes[LISTING_CACHE_KEY].newValue, Date.now(), Infinity);
        scheduleRefresh();
        return;
      }
      if (area !== "sync") return;
      const next = {};
      for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
      applySettings(next);
      updateSiteState();
      if ("calculatePpsm" in changes || "calculateRail" in changes) {
        syncCalculationState({
          ppsmChanged: "calculatePpsm" in changes,
          railChanged: "calculateRail" in changes,
        });
      }
      if (!isRunning) return;
      processProjectCards();
      scheduleRefresh();
    });
  } catch {
    listingCacheLoaded = true;
    updateSiteState(); // אם האחסון לא זמין, ממשיכים עם ברירות המחדל
  }
})();
