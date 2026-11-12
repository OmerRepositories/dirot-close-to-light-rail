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
    saveListingData: true,
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
  // בפיד של קבוצה – שם הקבוצה בראש הדף; בפיד הקבוצות (/groups/feed/) – הקבוצה של הפוסט עצמו.
  // עיר רק כששם הקבוצה מציין עיר אחת ("דירות בפתח תקווה"); בקבוצה של כמה ערים אין ניחוש.
  const onGroupsHomeFeed = () => LRFacebookPage.isGroupsHomeFeed(location.pathname);
  function pageGroupName() {
    const h1 = document.querySelector('[role="main"] h1') || document.querySelector("h1");
    const title = String(document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook\s*$/i, "");
    return (h1 && h1.textContent.trim()) || title;
  }
  function articleGroup(article) {
    if (!article) return null;
    if (article._lrGroup !== undefined) return article._lrGroup;
    const links = [...article.querySelectorAll('a[href*="/groups/"]')].slice(0, 12).map((a) => ({ href: a.href, text: a.textContent }));
    const group = LRFacebookPage.groupFromLinks(links);
    if (group) article._lrGroup = group; // עוד לא נטען – ננסה שוב בסריקה הבאה
    return group;
  }
  function groupContext(article) {
    const name = onGroupsHomeFeed() ? (articleGroup(article) || {}).name : pageGroupName();
    return LRFacebookPage.groupCityContext(name, LR.findCities);
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

  // פייסבוק מציג רק את תחילת הפוסט עד "עוד" – ושם בדרך כלל אין מחיר, מ"ר או כתובת.
  // לחיצה על "עוד" פותחת את הטקסט המלא בתוך הפוסט (בלי מעבר דף; נבדק 2026-11-12). פעם אחת לכל פוסט.
  function expandPost(article) {
    if (article._lrExpanded) return false;
    const msg = messageEl(article);
    if (!msg) return false;
    const button = [...msg.querySelectorAll('[role="button"]')].find(
      (element) => /^(?:עוד|See more|ראה עוד|הצג עוד)$/.test(element.textContent.trim()) && !element.closest("a[href]")
    );
    article._lrExpanded = true;
    if (!button) return false;
    try {
      button.click();
      return true;
    } catch {
      return false;
    }
  }

  // ---------- שמירת המודעה במנהל המידע ----------
  // לינק לפוסט, שם המפרסם, טלפונים מהטקסט, מחיר/שטח/חדרים/קומה/כתובת ומרחק מהרכבת.
  // הרשומה ממוזגת ברקע עם מה שכבר שמור (merge) – הערות, לב והיסטוריית מחיר נשמרים.
  // כל חלוקה של 7 הספרות: "050-1234567", "055-4322-789", "0544-788644", "+972 50 123 4567"
  const PHONE_RE = /(?<!\d)(?:\+?972[-\s]?|0)(5\d|[2-489]|7\d)((?:[-\s.]?\d){7})(?!\d)/g;
  function postPhones(text) {
    const phones = [];
    for (const match of String(text || "").matchAll(PHONE_RE)) {
      const phone = `0${match[1]}-${match[2].replace(/\D/g, "")}`;
      if (!phones.includes(phone)) phones.push(phone);
    }
    return phones.slice(0, 3);
  }
  function postLink(article) {
    for (const link of article.querySelectorAll("a[href]")) {
      const match = link.href.match(/\/groups\/([^/?#]+)\/(?:posts|permalink)\/(\d+)/);
      if (match) return { url: `https://www.facebook.com/groups/${match[1]}/posts/${match[2]}/`, id: match[2] };
    }
    return null;
  }
  function posterName(article) {
    const element = article.querySelector('[data-ad-rendering-role="profile_name"]');
    if (!element) return "";
    const strong = element.querySelector("strong, h2 a, h3 a, a[role='link']") || element;
    return String(strong.textContent || "").split(/\s*[·•]\s*/)[0].replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function saveListing(entry) {
    if (!CFG.saveListingData || !entry.relevant || !entry.parsed) return;
    const text = postText(entry.article);
    // refreshAll רץ על כל שינוי בדף (כמעט כל שנייה בפייסבוק) – בלי שינוי בטקסט, במרחק או בפענוח
    // אין מה לחשב מחדש (כתובת, חדרים, חתימה) לכל פוסט בפיד
    const res0 = entry.res && entry.res.ok ? entry.res : null;
    const input = [text, res0 ? `${res0.meters}|${res0.station && res0.station.name}|${res0.approx}` : "", entry.parsed.price, entry.parsed.sqm, entry.parsed.rent, posterName(entry.article)].join("\u0001");
    if (entry.savedInput === input) return;
    const link = postLink(entry.article);
    if (!link) return; // הקישור לפוסט עוד לא נטען – ננסה שוב בפעם הבאה
    entry.savedInput = input;
    const context = groupContext(entry.article);
    const address = LR.parseFreeAddress(text, context);
    const parsed = entry.parsed;
    const roomsFloor = LR.extractRoomsFloorFree(text);
    const res = entry.res && entry.res.ok ? entry.res : null;
    const record = {
      recordType: "listing",
      site: "facebook",
      indexedFrom: "page",
      title: text.split("\n").map((line) => line.trim()).find((line) => line.length > 3) || "",
      address: [address.street, address.city].filter(Boolean).join(", "),
      city: address.city || context || "",
      neighborhood: address.hood || "",
      url: link.url,
      price: Number.isFinite(parsed.price) && !parsed.rent ? parsed.price : undefined,
      sqm: Number.isFinite(parsed.sqm) ? parsed.sqm : undefined,
      pricePerSqm: Number.isFinite(parsed.ppsm) ? parsed.ppsm : undefined,
      rooms: roomsFloor.rooms ?? undefined,
      floor: roomsFloor.floor ?? undefined,
      buildingTopFloor: roomsFloor.topFloor ?? undefined,
      railMeters: res ? res.meters : undefined,
      railStation: res && res.station ? res.station.name : undefined,
      railApprox: res ? Boolean(res.approx) : undefined,
      contactName: posterName(entry.article) || undefined,
      contactPhones: postPhones(text).join(", ") || undefined,
      brokerage: /תיווך|מתווך|נדל["״']?ן|RE\/?MAX|רי\/?מקס|אנגלו סכסון|סוכנ(?:ות|ת)/i.test(text) || undefined,
      postText: text.slice(0, 2000),
      updatedAt: Date.now(),
    };
    record.priceHistory = Number.isFinite(record.price) ? [{ price: record.price, at: record.updatedAt, src: "page" }] : [];
    record.postUrls = [link.url];
    record.firstSeenAt = record.updatedAt;
    const signature = JSON.stringify({ ...record, updatedAt: 0, priceHistory: 0, firstSeenAt: 0 });
    if (entry.savedSignature === signature) return;
    entry.savedSignature = signature;
    try {
      chrome.runtime.sendMessage(
        { type: "lightrail:cache-patch", puts: [{ key: facebookListingKey(record, address, link), record, existed: false, merge: true }], prunes: [] },
        () => void chrome.runtime.lastError
      );
    } catch {}
  }

  // בפייסבוק לא עורכים פוסט ישן – מפרסמים פוסט חדש. כדי שאותה דירה תהיה מודעה אחת (והשינוי במחיר
  // יופיע בהיסטוריה), המפתח הוא "טביעת אצבע" של הדירה: עיר + רחוב ומספר בית + שטח (או חדרים) –
  // ולא מזהה הפוסט. בלי מספר בית אי אפשר לזהות בוודאות, ואז כל פוסט נשמר בנפרד.
  function facebookListingKey(record, address, link) {
    const norm = (value) => String(value || "").replace(/["'״׳`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const street = norm(address.street);
    const size = Number.isFinite(record.sqm) ? `${Math.round(record.sqm)}מר` : Number.isFinite(record.rooms) ? `${record.rooms}חד` : "";
    if (!/\d/.test(street) || !record.city || !size) return `facebook:${link.id}`;
    const fingerprint = `${norm(record.city)}|${street}|${size}|${Number.isFinite(record.floor) ? record.floor : ""}`;
    let hash = 2166136261;
    for (let i = 0; i < fingerprint.length; i++) {
      hash ^= fingerprint.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `facebook:apt-${(hash >>> 0).toString(36)}`;
  }

  // הסריקה רצה על כל שינוי בפיד; קריאת הטקסט וסיווג הפוסט חוזרים רק כשהתוכן שלו השתנה
  // (textContent זול – לא מחשב פריסה; innerText נקרא רק כשהתוכן באמת השתנה)
  const postMemo = new WeakMap();
  function classifiedPost(article) {
    const msg = messageEl(article);
    const source = msg || article;
    const content = source.textContent || "";
    const memo = postMemo.get(article);
    if (memo && memo.content === content) return memo;
    const text = msg ? messageText(msg) : textOf(article, 1800);
    const next = {
      content,
      text,
      classification: text ? LR.classifyFacebookPost(text) : null,
    };
    postMemo.set(article, next);
    return next;
  }

  // טקסט הפוסט כמו שהוא מוצג – עם שבירות השורה של הכותב, ובלי שבירות מלאכותיות באמצע שורה
  // (אימוג'י, קישור או תגית מפצלים את הטקסט לכמה צמתים; textOf היה שובר שם שורה).
  // כך הטקסט זהה לזה שבקורפוס הבדיקות (שנאסף ב-innerText), ומה שעובר בבדיקות הוא מה שרץ בדף.
  function messageText(msg) {
    const text = String(msg.innerText || "").replace(/ /g, " ").trim();
    return text || textOf(msg);
  }

  // אם אין אלמנט הודעה מוכר, לוקחים את תחילת הפוסט (בלי התגובות שבסופו)
  function postText(article) {
    return classifiedPost(article).text;
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
    const context = groupContext(entry.article);
    const parsed = LR.parseFreeAddress(text, context);
    const { queries } = parsed;
    entry.mapsOrigin = queries[0] && queries[0].q;
    // בלי עיר (לא בפוסט, וגם שם הקבוצה לא מציין עיר אחת) "הרצל 5" יכול להיות בכל עיר – לא מנחשים
    const noCity = !parsed.city && !context;
    if (!queries.length || noCity || !LR.hasExplicitFacebookAddress(text, parsed.street)) {
      renderRail(entry, {
        ok: false,
        reason: "not-found",
        message: noCity && parsed.street
          ? "לא צוינה עיר בפוסט, ושם הקבוצה לא מציין עיר אחת – אי אפשר לדעת איפה הרחוב."
          : "נדרש רחוב ומספר בית מפורשים כדי לחשב מרחק בפייסבוק.",
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
        // אותו פענוח כמו בסיווג (כולל "95 מטר" ובלי משפטי שכירות קיימת) – התג והרשומה השמורה זהים
        const { text, classification } = classifiedPost(art);
        entry.parsed = (classification && classification.parsed) || LR.extractPriceSqmFree(text);
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
      // שומרים אחרי שחישוב המרחק הסתיים (גם אם לא נמצאה כתובת), כדי שהמרחק יישמר עם המודעה
      if (entry.res) saveListing(entry);
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
        // פיד הקבוצות: פוסט מקבוצה שאינה קבוצת דירות לא נסרק בכלל (גם לא נפתח "עוד")
        if (!entry) {
          const relevantGroup = articleRelevantGroup(art);
          if (relevantGroup === null) continue; // שם הקבוצה עוד לא נטען
          if (relevantGroup === false) {
            entries.set(art, { relevant: false, wrap: document.createElement("i") });
            continue;
          }
        }
        // קודם פותחים את הטקסט המלא; הניתוח ירוץ בסריקה הבאה, אחרי שהטקסט הוחלף
        if (expandPost(art)) continue;
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
    if (CFG.disableFacebook) return false;
    // פיד הקבוצות: רץ תמיד, וכל פוסט נבדק לפי הקבוצה שלו (articleRelevantGroup)
    if (onGroupsHomeFeed()) return true;
    return LRFacebookPage.isGroupFeed(location.pathname) && isRealEstateGroupHere() === true;
  }
  // דף שבו התוסף עשוי לרוץ – רק בו שווה לעבור על שינויי ה-DOM
  const onScannablePage = () => LRFacebookPage.isGroupFeed(location.pathname) || onGroupsHomeFeed();
  // בפיד הקבוצות: true = קבוצת דירות (או שהמשתמש הפעיל אותה), false = לא, null = עוד לא ידוע
  function articleRelevantGroup(article) {
    if (!onGroupsHomeFeed()) return true;
    const group = articleGroup(article);
    if (!group) return null;
    return forcedGroups.has(group.id) || LRFacebookPage.isRealEstateGroupName(group.name);
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
    if (shouldRun !== isRunning || (!shouldRun && onScannablePage())) {
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
    if (!isRunning && !onScannablePage()) {
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
