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
    requiredAmenities: ["secureRoom"],
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
  const LOCAL_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;
  const LOCAL_STORAGE_RESERVE_BYTES = 512 * 1024;
  const SITE_DISABLE_KEY = IS_YAD2 ? "disableYad2" : "disableMadlan";
  let listingCache = {};
  let listingCacheLoaded = false;
  let pendingCacheSave = false;
  let cacheWriteInProgress = false;
  let cacheSaveTimer = null;
  const cacheWriteSuppressedIds = new Set();

  // קישורים שמזהים מודעה בודדת
  const LISTING_HREF = IS_YAD2
    ? /\/realestate\/item\//
    : /\/(listings|bulletin)\/[^/?#]+/;

  // בדף מודעה בודדת: מכאן והלאה זה "מודעות דומות", לא המודעה עצמה
  const SIMILAR_MARKERS =
    /דירות דומות|מודעות דומות|נכסים דומים|נכסים נוספים|מודעות נוספות|עוד מודעות|אולי יעניין|דירות נוספות|דירות באזור|מומלצים/;

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
  function textOf(root, limit = 8000) {
    if (!root) return "";
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".lr-wrap")) return NodeFilter.FILTER_REJECT;
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

  function hasBrokerageSignal(root) {
    if (!root) return false;
    const agentLabel = root.querySelector('[data-testid="ad-card-above-price"]');
    if (agentLabel && agentLabel.textContent.trim()) return true;

    const text = textOf(root, 6000)
      .replace(/\s+/g, " ")
      .replace(/(?:ללא|בלי|לא)(?:\s+(?:(?:צורך\s+)?(?:ב|דרך|באמצעות)))?\s*תיווך/g, "");
    return /תיווך|נדל(?:[״"'׳]?ן)/.test(text);
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
      let path;
      try {
        path = new URL(anchor.href, location.href).pathname;
      } catch {
        return;
      }
      if (!isProjectPath(path)) return;
      if (!byHref.has(path)) byHref.set(path, anchor);
    });

    const cards = new Set();
    for (const [path, anchor] of byHref) {
      let card = anchor;
      while (card.parentElement && card.parentElement !== document.body) {
        const parent = card.parentElement;
        if ((parent.textContent || "").length > 2500) break;
        const otherProjects = [...parent.querySelectorAll("a[href]")].some((link) => {
          try {
            const linkPath = new URL(link.href, location.href).pathname;
            return linkPath !== path && isProjectPath(linkPath);
          } catch {
            return false;
          }
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
    brokerageFilterBar.append(
      brokerageButton,
      brokerageStatus,
      projectButton,
      projectStatus,
      railButton,
      railStatus
    );
    document.body.append(brokerageFilterBar);
  }

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
  function findCards() {
    const byHref = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      let path;
      try {
        path = new URL(a.href, location.href).pathname;
      } catch {
        return;
      }
      if (!LISTING_HREF.test(path)) return;
      if (!byHref.has(path)) byHref.set(path, []);
      byHref.get(path).push(a);
    });

    const cards = [];
    for (const [path, anchors] of byHref) {
      let el = anchors[0];
      // עולים עד לאב הגדול ביותר שעדיין מכיל מודעה אחת בלבד
      while (el.parentElement && el.parentElement !== document.body) {
        const parent = el.parentElement;
        if ((parent.textContent || "").length > 1500) break; // לא לטפס עד כל הרשימה
        const others = new Set();
        parent.querySelectorAll("a[href]").forEach((x) => {
          try {
            const p = new URL(x.href, location.href).pathname;
            if (LISTING_HREF.test(p) && p !== path) others.add(p);
          } catch {}
        });
        if (others.size > 0) break;
        el = parent;
      }
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

  function setBadge(b, state, val, sub, title) {
    b.dataset.state = state;
    b._v.textContent = val;
    b._s.textContent = sub || "";
    b._s.hidden = !sub;
    b.title = title || "";
    b.style.cursor = b._open ? "pointer" : "default";
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
      getText: kind === "single" ? mainText : () => textOf(card, 3000),
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
    const stats =
      entry.parsed ||
      (IS_YAD2
        ? LR.extractPriceSqm(text)
        : LRMadlan.extractPriceSqm(root, text));
    const metadata = parser.listingExportData(root);
    const floor = readListingFloor(root);
    const amenities =
      entry.amenities ||
      parser.readAmenities(root) ||
      (entry.listingId &&
      validCachedAmenities(listingCache[cacheKeyForListing(entry.listingId)])
        ? listingCache[cacheKeyForListing(entry.listingId)].amenities
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
      pricePerSqm: Number.isFinite(stats.ppsm) ? `₪${fmtNum(stats.ppsm)}` : null,
      railDistance,
      missingAmenities,
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
      const recordBytes = JSON.stringify([key, record]).length * 2;
      if (bytes + recordBytes > maxBytes) continue;
      trimmed[key] = record;
      bytes += recordBytes;
      count++;
    }
    return trimmed;
  }

  function saveListingCache() {
    if (!CFG.saveListingData) return;
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
      chrome.storage.local.getBytesInUse(null, (totalBytes) => {
        if (chrome.runtime.lastError) {
          cacheWriteInProgress = false;
          console.warn(
            "[lightrail-ext] could not measure local storage before saving listing cache",
            chrome.runtime.lastError.message
          );
          if (pendingCacheSave) saveListingCache();
          return;
        }
        chrome.storage.local.getBytesInUse(LISTING_CACHE_KEY, (cacheBytes) => {
          if (chrome.runtime.lastError) {
            cacheWriteInProgress = false;
            console.warn(
              "[lightrail-ext] could not measure existing listing cache",
              chrome.runtime.lastError.message
            );
            if (pendingCacheSave) saveListingCache();
            return;
          }
          const otherBytes = Math.max(0, totalBytes - cacheBytes);
          const availableBytes =
            LOCAL_STORAGE_QUOTA_BYTES -
            otherBytes -
            LOCAL_STORAGE_RESERVE_BYTES;
          if (availableBytes < 2 && Object.keys(listingCache).length) {
            cacheWriteInProgress = false;
            console.warn(
              "[lightrail-ext] not enough local storage for listing cache; clear saved extension data or disable cache saving"
            );
            if (pendingCacheSave) saveListingCache();
            return;
          }
          const maxBytes = Math.max(
            2,
            Math.min(LISTING_CACHE_MAX_BYTES, availableBytes)
          );
          writeListingCache(
            trimListingCache(listingCache, Date.now(), maxBytes),
            0,
            maxBytes
          );
        });
      });
    }, 500);
  }

  function writeListingCache(snapshot, attempt, maxBytes) {
    chrome.storage.local.set({ [LISTING_CACHE_KEY]: snapshot }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        const quotaError = /quota|exceed|bytes/i.test(error.message || "");
        if (quotaError && attempt < 4 && Object.keys(snapshot).length > 1) {
          const reducedBytes = Math.max(2, Math.floor(maxBytes / 2));
          const reduced = trimListingCache(
            snapshot,
            Date.now(),
            reducedBytes
          );
          writeListingCache(reduced, attempt + 1, reducedBytes);
          return;
        }
        console.warn(
          "[lightrail-ext] failed to save listing cache",
          error.message
        );
      } else {
        listingCache = snapshot;
      }
      cacheWriteInProgress = false;
      if (pendingCacheSave) {
        pendingCacheSave = false;
        saveListingCache();
      }
    });
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
    for (const field of ["price", "sqm", "pricePerSqm"]) {
      if (manualOverrides.has(field) && existing && field in existing) {
        stats[field] = existing[field];
      } else if (listingStats && Number.isFinite(listingStats[field])) {
        stats[field] = listingStats[field];
      }
    }
    if (
      listingStats &&
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
    const unchanged = Object.entries(record).every(
      ([field, value]) => field === "updatedAt" || existing[field] === value
    );
    if (unchanged) return;
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
    if (!CFG.saveListingData || !listingCacheLoaded) return;
    const parser = IS_YAD2 ? LRYad2 : LRMadlan;
    const root = entry.kind === "single" ? document : entry.card;
    const id = parser.listingId(root);
    if (!id) return;
    const key = cacheKeyForListing(id);
    if (cacheWriteSuppressedIds.has(key)) return;
    const previous = listingCache[key] || {};
    const text = entry.getText();
    const stats =
      entry.parsed ||
      (IS_YAD2 ? LR.extractPriceSqm(text) : LRMadlan.extractPriceSqm(root, text));
    const listingMetadata = parser.listingExportData(root);
    const address = parser.readAddress(root, text, ctxCity(), entry.kind === "single");
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
      price: Number.isFinite(stats.price) ? stats.price : previous.price,
      sqm: Number.isFinite(stats.sqm) ? stats.sqm : previous.sqm,
      pricePerSqm: Number.isFinite(stats.ppsm) ? stats.ppsm : previous.pricePerSqm,
      rooms: Number.isFinite(listingMetadata.rooms) ? listingMetadata.rooms : previous.rooms,
      listingCreatedAt:
        (listingMetadata.listingCreatedAt &&
          normalizeListingDate(listingMetadata.listingCreatedAt)) ||
        previous.listingCreatedAt,
      listingUpdatedAt:
        (listingMetadata.listingUpdatedAt &&
          normalizeListingDate(listingMetadata.listingUpdatedAt)) ||
        previous.listingUpdatedAt,
      brokerage: hasBrokerageSignal(root),
      ...extra,
    }, previous);
    const unchanged = Object.entries(record).every(
      ([field, value]) => field === "updatedAt" || previous[field] === value
    );
    if (unchanged) return;
    record.updatedAt = Date.now();
    listingCache[key] = record;
    saveListingCache();
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

  function renderCachedAmenities(entry) {
    if (entry.kind !== "list" || !entry.cacheNote) return;
    const record = entry.listingId ? listingCache[cacheKeyForListing(entry.listingId)] : null;
    if (!validCachedAmenities(record) || CFG.requiredAmenities.length === 0) {
      if (!entry.cacheNote.hidden) entry.cacheNote.hidden = true;
      entry.card.classList.remove("lr-cache-missing");
      return;
    }
    const missing = CFG.requiredAmenities
      .filter((amenity) => record.amenities[amenity] !== true)
      .map((amenity) => AMENITY_LABELS[amenity] || amenity);
    const state = missing.length ? "missing" : "matches";
    const text = missing.length
      ? `נבדקה בעבר · חסר: ${missing.join(", ")}`
      : "נבדקה בעבר · דרישות החובה קיימות";
    const signature = `${record.updatedAt}|${state}|${text}`;
    if (entry.cacheNote.dataset.signature !== signature) {
      entry.cacheNote.dataset.signature = signature;
      entry.cacheNote.dataset.state = state;
      entry.cacheNote.textContent = text;
      entry.cacheNote.title = `המאפיינים נבדקו בתאריך ${new Date(record.updatedAt).toLocaleDateString("he-IL")}`;
    }
    if (entry.cacheNote.hidden) entry.cacheNote.hidden = false;
    entry.card.classList.toggle("lr-cache-missing", missing.length > 0);
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
      if (!CFG.calculatePpsm) {
        entry.info = null;
        entry.parsed = null;
        entry.delta = null;
        entry.ppsm.hidden = true;
      } else if (!entry.info && entry.priceTries < 8 && now - entry.lastTry > 1500) {
        entry.priceTries++;
        entry.lastTry = now;
        const text = entry.getText();
        entry.parsed = IS_YAD2
          ? LR.extractPriceSqm(text)
          : LRMadlan.extractPriceSqm(entry.kind === "single" ? document : entry.card, text);
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      }
      const root = entry.kind === "single" ? document : entry.card;
      const siteParser = IS_YAD2 ? LRYad2 : LRMadlan;
      entry.listingId = siteParser.listingId(root);
      const currentAmenities = (IS_YAD2 ? LRYad2 : LRMadlan).readAmenities(root);
      if (entry.kind === "single") rememberListingExportData(entry);
      if (entry.kind === "single" && currentAmenities) {
        entry.amenities = currentAmenities;
        const listingText = entry.getText();
        const listingStats = IS_YAD2
          ? LR.extractPriceSqm(listingText)
          : LRMadlan.extractPriceSqm(root, listingText);
        const address = siteParser.readAddress(
          root,
          listingText,
          ctxCity(),
          true
        );
        const cachedListing = entry.listingId
          ? listingCache[cacheKeyForListing(entry.listingId)]
          : null;
        rememberListingAmenities(
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
      const listingRoot =
        entry.kind === "single"
          ? document.querySelector("main") || document.body
          : entry.card;
      highlightBrokerage(listingRoot, CFG.avoidBrokerage);
      entry.brokerageWarning.hidden = !hasBrokerageSignal(listingRoot);
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

  function start() {
    if (isRunning) return;
    isRunning = true;
    createBrokerageFilterBar();
    pageObserver = new MutationObserver(scheduleScan);
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
          "lr-not-near-rail"
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

  function updateSiteState() {
    if (CFG[SITE_DISABLE_KEY]) stop();
    else start();
  }

  // טוענים את ההגדרות לפני שמתחילים, ומעדכנים את הדף מיד כשהמשתמש משנה הגדרה
  const NUM_KEYS = ["maxPpsm", "belowMedianPct", "nearM"];
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
      } else {
        CFG[k] = NUM_KEYS.includes(k) ? Math.max(0, Number(s[k]) || 0) : Boolean(s[k]);
      }
    }
  }

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
        listingCache = trimListingCache(changes[LISTING_CACHE_KEY].newValue);
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
