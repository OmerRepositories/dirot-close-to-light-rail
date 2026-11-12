// Facebook group feed content script: identifies property listings and displays rail distance and price per sqm.
// הפוסטים כתובים בטקסט חופשי, ולכן הניתוח נעשה ב-parse.js (extractPriceSqmFree / parseFreeAddress).
(() => {
  const DEFAULTS = {
    maxPpsm: 0,
    belowMedianPct: 10,
    requireRail: true,
    nearM: 800,
    highlight: true,
    disableFacebook: false,
  };
  const CFG = { ...DEFAULTS, MIN_SAMPLES: 5, ROOT_MARGIN: "600px" };

  const entries = new Map(); // article -> entry
  let scanTimer = null;
  let refreshTimer = null;
  let routeObserver = null;
  let isRunning = false;
  let settingsLoaded = false;
  let pageBias = null;

  const fmtNum = (n) => Math.round(n).toLocaleString("he-IL");
  const fmtDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' ק"מ' : m + " מ׳");

  // ---------- הקשר מהקבוצה (שם הקבוצה לעיתים כולל עיר) ----------
  function groupContext() {
    const h1 = document.querySelector("h1");
    const sources = [h1 ? h1.textContent : "", document.title || ""];
    for (const s of sources) {
      const c = LR.findCity(s || "");
      if (c) return c;
    }
    return null;
  }

  // ---------- קריאת טקסט ----------
  function textOf(root, limit = 5000) {
    if (!root) return "";
    const out = [];
    let len = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".lr-wrap")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue.replace(/\s+/g, " ").trim();
      out.push(v);
      len += v.length;
      if (len > limit) break;
    }
    // מחברים ברווח: בפוסט חופשי אין משמעות לשבירות שורה, ומספרים צמודים נשארים מופרדים
    return out.join(" \n ");
  }

  // ---------- זיהוי פוסטים ----------
  function messageEl(article) {
    return (
      article.querySelector('[data-ad-preview="message"]') ||
      article.querySelector('[data-ad-comet-preview="message"]') ||
      null
    );
  }

  // רק פוסטים אמיתיים בפיד של הקבוצה: article בתוך [role="feed"] שבאזור הראשי, עם גוף הודעה של
  // פוסט. לא צ'אטים (Messenger), חלונות קופצים, סרגלי צד או "סתם div" עם מספרים.
  const NOT_POST_AREA = '[role="dialog"], [role="complementary"], [role="banner"], [role="navigation"], [aria-label*="צ\'אט"], [aria-label*="Chat"], [aria-label*="Messenger"], [aria-label*="שיחה"]';
  function findPosts() {
    const list = [];
    const main = document.querySelector('[role="main"]');
    if (!main) return list;
    const feeds = [...main.querySelectorAll('[role="feed"]')];
    const scopes = feeds.length ? feeds : [main];
    for (const scope of scopes) {
      scope.querySelectorAll('[role="article"]').forEach((a) => {
        // תגובות הן article בתוך article – מדלגים עליהן
        if (a.parentElement && a.parentElement.closest('[role="article"]')) return;
        if (a.closest(NOT_POST_AREA)) return;
        // בלי פיד מוכר – רק article שיש בו גוף הודעה של פוסט
        if (!feeds.length && !messageEl(a)) return;
        list.push(a);
      });
    }
    return list;
  }

  // הסריקה רצה על כל שינוי בפיד; קריאת הטקסט וסיווג הפוסט חוזרים רק כשהתוכן שלו השתנה
  const postMemo = new WeakMap();
  function classifiedPost(article) {
    const msg = messageEl(article);
    const source = msg || article;
    const content = source.textContent || "";
    const memo = postMemo.get(article);
    if (memo && memo.content === content) return memo;
    const text = msg ? textOf(msg) : textOf(article, 1800);
    const next = {
      content,
      text,
      classification: text ? LR.classifyFacebookPost(text) : null,
    };
    postMemo.set(article, next);
    return next;
  }

  function postText(article) {
    const msg = messageEl(article);
    // אם אין אלמנט הודעה מוכר, לוקחים את תחילת הפוסט (בלי התגובות שבסופו)
    return msg ? textOf(msg) : textOf(article, 1800);
  }

  // ---------- תגים ----------
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

  // כותבים ל-DOM רק כשהערך באמת השתנה: כל כתיבה מפעילה את ה-MutationObserver ואת הסריקה
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

  function createEntry(article) {
    const wrap = document.createElement("div");
    wrap.className = "lr-wrap lr-fb";
    const rail = mkBadge("lr-rail", "מרחק מהרכבת");
    const ppsm = mkBadge("lr-ppsm", "מחיר למ״ר");
    const deal = mkBadge("lr-dealtag", "");
    deal.hidden = true;
    deal._v.textContent = "⭐ שווה בדיקה";
    setBadge(rail, "loading", "ממתין…");
    setBadge(ppsm, "loading", "…");
    wrap.append(rail, ppsm, deal);
    return {
      article, wrap, rail, ppsm, deal,
      info: null, parsed: null, res: null, tried: [], tries: 0,
      started: false, priceTries: 0, lastTry: 0, delta: null, text: "", relevant: null,
    };
  }

  function place(entry) {
    if (entry.wrap.isConnected) return;
    const msg = messageEl(entry.article);
    if (msg) msg.insertAdjacentElement("afterend", entry.wrap);
    else entry.article.insertBefore(entry.wrap, entry.article.firstChild);
  }

  function showIrrelevantNotice(article, type) {
    let entry = entries.get(article);
    if (entry && entry.relevant) {
      io.unobserve(article);
      entry.wrap.remove();
      entry = null;
    }
    if (!entry || !entry.notice) {
      const notice = document.createElement("div");
      notice.className = "lr-fb-notice";
      const message = messageEl(article);
      if (message) message.insertAdjacentElement("afterend", notice);
      else article.insertBefore(notice, article.firstChild);
      entry = { relevant: false, notice, wrap: notice };
      entries.set(article, entry);
    }
    const noticeText =
      type === "rent"
        ? "מודעה זו היא להשכרה, ולכן אינה רלוונטית לחיפוש רכישה."
        : "זהו פוסט חיפוש דירה/נכס, לא מודעת נכס למכירה.";
    // כתיבה רק כשיש שינוי: כל כתיבה היא שינוי DOM שמפעיל סריקה נוספת (לולאה)
    if (entry.notice.textContent !== noticeText) entry.notice.textContent = noticeText;
  }

  function renderRail(entry, res) {
    const b = entry.rail;
    entry.res = res;
    b._open = null;
    if (!res || !res.ok) {
      const err = res && res.reason === "error";
      const tried = entry.tried.length ? "ניסינו לחפש: " + entry.tried.join(" | ") : "בפוסט לא זוהתה כתובת (רחוב ועיר).";
      setBadge(
        b,
        "none",
        err ? "שגיאה בחישוב" : "לא זוהתה כתובת",
        "",
        (err && res.error ? res.error + "\n" : "") +
          (res && res.message ? res.message + "\n" : "") +
          tried
      );
      return;
    }
    const m = res.meters;
    const state = m <= 600 ? "near" : m <= 1500 ? "mid" : "far";
    const walk = m > 4000 ? "" : `🚶 ~${res.walkMin} דק׳ הליכה · `;
    if (!res.approx) {
      b._open = () => {
        const origin =
          entry.mapsOrigin ||
          `${res.origin.lat},${res.origin.lon}`;
        const url = LRLocation.mapsDirectionsUrl(origin, res.station.name);
        window.open(url, "_blank", "noopener");
      };
    }
    setBadge(
      b, state, `${res.approx ? "≈" : ""}${fmtDistance(m)}`, `${walk}🚉 ${res.station.name}`,
      (res.approx ? "הערכה בלבד (" + res.matched + "). " : "") +
        (res.approx
          ? "קישור למפה לא זמין כדי לא להציג נקודת ציון לא מדויקת."
          : "קו אווירי לתחנה הקרובה. לחיצה פותחת כרטיסייה בגוגל מפות עם מסלול הליכה.")
    );
  }

  function startLookup(entry) {
    if (!isRunning || entry.started) return;
    entry.started = true;
    const text = postText(entry.article);
    const parsed = LR.parseFreeAddress(text, groupContext());
    const { queries } = parsed;
    entry.mapsOrigin = queries[0] && queries[0].q;
    if (!queries.length || !LR.hasExplicitFacebookAddress(text, parsed.street)) {
      renderRail(entry, {
        ok: false,
        reason: "not-found",
        message: "נדרש רחוב ומספר בית מפורשים כדי לחשב מרחק בפייסבוק.",
      });
      scheduleRefresh();
      return;
    }
    entry.tried = queries.map((q) => q.q);
    setBadge(entry.rail, "loading", "מחשב…");
    try {
      chrome.runtime.sendMessage({ type: "lookup", queries, bias: pageBias }, (res) => {
        if (!isRunning || !entry.article.isConnected) return;
        if (chrome.runtime.lastError) {
          renderRail(entry, { ok: false, reason: "error", error: chrome.runtime.lastError.message });
        } else {
          if (res && res.ok && !res.approx) pageBias = res.origin;
          renderRail(entry, res);
        }
        scheduleRefresh();
      });
    } catch {
      renderRail(entry, { ok: false, reason: "error", error: "התוסף עודכן – רענן את הדף" });
    }
  }

  const io = new IntersectionObserver(
    (list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const entry = entries.get(e.target);
        if (entry && entry.relevant) startLookup(entry);
      }
    },
    { rootMargin: CFG.ROOT_MARGIN }
  );

  // ---------- חציון, מחיר למ"ר והדגשה ----------
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function refreshAll() {
    if (!isRunning) return;
    refreshTimer = null;
    const now = Date.now();

    for (const [art, entry] of entries) {
      if (!art.isConnected) {
        io.unobserve(art);
        entry.wrap.remove();
        entries.delete(art);
        continue;
      }
      if (entry.relevant) place(entry);
      if (!entry.info && entry.relevant && entry.priceTries < 6 && now - entry.lastTry > 1500) {
        entry.priceTries++;
        entry.lastTry = now;
        entry.parsed = LR.extractPriceSqmFree(postText(art));
        entry.info = entry.parsed.ppsm ? entry.parsed : null;
      }
    }

    const values = [];
    for (const e of entries.values()) if (e.relevant && e.info) values.push(e.info.ppsm);
    const med = values.length >= CFG.MIN_SAMPLES ? median(values) : null;

    for (const entry of entries.values()) {
      if (!entry.relevant) continue;
      const { info, ppsm, deal, res, parsed } = entry;
      entry.delta = null;

      if (info) {
        let sub = "";
        let state = "neutral";
        if (med) {
          entry.delta = (info.ppsm - med) / med;
          const pct = Math.round(Math.abs(entry.delta) * 100);
          if (pct >= 3) sub = `${entry.delta < 0 ? "−" : "+"}${pct}% מהחציון`;
          state = entry.delta <= -0.05 ? "good" : entry.delta >= 0.05 ? "bad" : "neutral";
        }
        if (CFG.maxPpsm > 0) state = info.ppsm <= CFG.maxPpsm ? "good" : "neutral";
        setBadge(
          ppsm, state, `₪${fmtNum(info.ppsm)}`, sub,
          `מחיר שזוהה: ₪${fmtNum(info.price)} · שטח שזוהה: ${info.sqm} מ״ר.` +
            (med
              ? ` חציון הפוסטים שנטענו בדף: ₪${fmtNum(med)} (${values.length} פוסטים).`
              : ` צריך לפחות ${CFG.MIN_SAMPLES} פוסטים עם מחיר ושטח כדי להשוות לחציון.`)
        );
      } else if (parsed && parsed.reason) {
        setBadge(
          ppsm, "none", "—", parsed.reason,
          `מחיר שזוהה: ${parsed.price ? "₪" + fmtNum(parsed.price) : "אין"} · שטח שזוהה: ${parsed.sqm ? parsed.sqm + " מ״ר" : "אין"}`
        );
      }

      const reasons = [];
      let ok = true;
      const nearRail = Boolean(res && res.ok && !res.approx && res.meters <= CFG.nearM);
      if (CFG.requireRail) {
        ok = ok && nearRail;
        if (nearRail) reasons.push(`עד ${CFG.nearM} מ׳ מהרכבת הקלה`);
      }
      if (CFG.maxPpsm > 0) {
        const pass = Boolean(info && info.ppsm <= CFG.maxPpsm);
        ok = ok && pass;
        if (pass) reasons.push(`עד ₪${fmtNum(CFG.maxPpsm)} למ״ר`);
      }
      if (CFG.belowMedianPct > 0) {
        const pass = entry.delta !== null && entry.delta <= -CFG.belowMedianPct / 100;
        ok = ok && pass;
        if (pass) reasons.push(`${Math.round(-entry.delta * 100)}% מתחת לחציון`);
      }
      const hasRule = CFG.requireRail || CFG.maxPpsm > 0 || CFG.belowMedianPct > 0;
      const isDeal = Boolean(CFG.highlight && hasRule && ok);
      deal.hidden = !isDeal;
      if (isDeal) deal.title = reasons.join(" · ");
      entry.wrap.classList.toggle("lr-deal-card", isDeal);
    }
  }

  function scheduleRefresh() {
    if (!isRunning || refreshTimer) return;
    refreshTimer = setTimeout(refreshAll, 300);
  }

  // ---------- סריקה ----------
  function scan() {
    if (!isRunning) return;
    scanTimer = null;
    try {
      for (const art of findPosts()) {
        let entry = entries.get(art);
        const { text, classification } = classifiedPost(art);
        if (!text) continue;
        if (classification.type === "rent" || classification.type === "seeking") {
          showIrrelevantNotice(art, classification.type);
          continue;
        }
        if (entry && !entry.relevant) {
          if (classification.type === "listing") {
            if (entry.notice) entry.notice.remove();
            entries.delete(art);
            entry = null;
          } else {
            continue;
          }
        }
        if (!entry) {
          // פוסט שעוד לא נטען במלואו ייבדק שוב בסריקה הבאה
          if (classification.type !== "listing") {
            const tries = (art._lrTries = (art._lrTries || 0) + 1);
            if (tries > 4) entries.set(art, { relevant: false, wrap: document.createElement("i") });
            continue;
          }
          entry = createEntry(art);
          entry.relevant = true;
          entry.text = text;
          entries.set(art, entry);
          place(entry);
          io.observe(art);
          setTimeout(scheduleRefresh, 800);
        }
      }
      scheduleRefresh();
    } catch (e) {
      console.warn("[lightrail-ext/fb] scan failed", e);
    }
  }

  function scheduleScan() {
    if (!isRunning || scanTimer) return;
    scanTimer = setTimeout(scan, 900);
  }

  // רק בפיד של קבוצה שנראית קבוצת דירות (לפי שם הקבוצה), או קבוצה שהמשתמש הפעיל בעצמו.
  // שם הקבוצה נטען אחרי הדף – עד שהוא מופיע, לא סורקים.
  const FORCED_GROUPS_KEY = "lightrailFbForcedGroups";
  let forcedGroups = new Set();
  let groupDecision = { path: "", name: "", result: null };
  function groupName() {
    const heading = document.querySelector('[role="main"] h1') || document.querySelector("h1");
    const title = String(document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook\s*$/i, "");
    return [heading ? heading.textContent : "", title].filter(Boolean).join(" · ").trim();
  }
  function isRealEstateGroupHere() {
    const id = LRFacebookPage.groupId(location.pathname);
    if (id && forcedGroups.has(id)) return true;
    const name = groupName();
    if (groupDecision.path === location.pathname && groupDecision.name === name) return groupDecision.result;
    const result = !name || /^facebook$/i.test(name) ? null : LRFacebookPage.isRealEstateGroupName(name);
    groupDecision = { path: location.pathname, name, result };
    return result;
  }
  function shouldRunHere() {
    return !CFG.disableFacebook && LRFacebookPage.isGroupFeed(location.pathname) && isRealEstateGroupHere() === true;
  }

  // קבוצה שלא זוהתה כקבוצת דירות: הודעה קטנה עם אפשרות להפעיל בכל זאת
  let groupNotice = null;
  function renderGroupNotice() {
    const show = settingsLoaded && !CFG.disableFacebook && LRFacebookPage.isGroupFeed(location.pathname) && isRealEstateGroupHere() === false;
    if (!show) {
      if (groupNotice) groupNotice.remove();
      groupNotice = null;
      return;
    }
    if (groupNotice && groupNotice.isConnected) return;
    groupNotice = document.createElement("div");
    groupNotice.className = "lr-fb-group-notice lr-wrap";
    groupNotice.textContent = "קרבה לרכבת: הקבוצה לא נראית קבוצת דירות, אז התוסף לא סורק בה פוסטים. ";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "להפעיל בקבוצה הזו";
    button.addEventListener("click", () => {
      const id = LRFacebookPage.groupId(location.pathname);
      if (!id) return;
      forcedGroups.add(id);
      try {
        chrome.storage.local.set({ [FORCED_GROUPS_KEY]: [...forcedGroups].slice(-200) });
      } catch {}
      syncPageState();
    });
    groupNotice.appendChild(button);
    document.body.appendChild(groupNotice);
  }

  function syncPageState() {
    if (!settingsLoaded) return;
    renderGroupNotice();
    if (!shouldRunHere()) {
      stop();
      return;
    }
    start();
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    scan();
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    clearTimeout(scanTimer);
    clearTimeout(refreshTimer);
    scanTimer = null;
    refreshTimer = null;
    io.disconnect();
    for (const entry of entries.values()) entry.wrap.remove();
    entries.clear();
  }

  function updateSiteState() {
    syncPageState();
  }

  function onPageMutation() {
    if (!settingsLoaded) return;
    const shouldRun = shouldRunHere();
    if (shouldRun !== isRunning || (!shouldRun && LRFacebookPage.isGroupFeed(location.pathname))) {
      syncPageState();
    } else if (isRunning) {
      scheduleScan();
    }
  }

  // שינויים שהתוסף עצמו עשה (תגים והודעות שלו) לא מצדיקים סריקה חוזרת
  function isOwnElement(node) {
    const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return Boolean(element && element.closest && element.closest(".lr-wrap, .lr-fb-notice"));
  }

  function isOwnMutation(record) {
    if (isOwnElement(record.target)) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return (
      nodes.length > 0 &&
      nodes.every(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          node.classList &&
          (node.classList.contains("lr-wrap") || node.classList.contains("lr-fb-notice"))
      )
    );
  }

  routeObserver = new MutationObserver((records) => {
    // מחוץ לפיד של קבוצה (רוב הזמן בפייסבוק) – בדיקה זולה של הכתובת בלבד, בלי לעבור על כל השינויים
    if (!isRunning && !LRFacebookPage.isGroupFeed(location.pathname)) {
      if (groupNotice) renderGroupNotice();
      return;
    }
    if (records.every(isOwnMutation)) return;
    onPageMutation();
  });
  routeObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", syncPageState);

  const NUM_KEYS = ["maxPpsm", "belowMedianPct", "nearM"];
  function applySettings(s) {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in s)) continue;
      CFG[k] = NUM_KEYS.includes(k) ? Math.max(0, Number(s[k]) || 0) : Boolean(s[k]);
    }
  }

  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      applySettings(s || {});
      chrome.storage.local.get(FORCED_GROUPS_KEY, (stored) => {
        const list = stored && Array.isArray(stored[FORCED_GROUPS_KEY]) ? stored[FORCED_GROUPS_KEY] : [];
        forcedGroups = new Set(list.map(String));
        settingsLoaded = true;
        syncPageState();
      });
    });
    // רק אזור sync – מאזין כללי היה מקבל גם עותק מלא של כל כתיבה גדולה לאחסון המקומי
    chrome.storage.sync.onChanged.addListener((changes) => {
      const next = {};
      for (const [k, v] of Object.entries(changes)) next[k] = v.newValue;
      applySettings(next);
      updateSiteState();
      if (!isRunning) return;
      scheduleRefresh();
    });
  } catch {
    settingsLoaded = true;
    updateSiteState();
  }
})();
