// דפדוף בעמודי חיפוש: בניית כתובות לטווח עמודים, וגלילה איטית עד סוף העמוד.
// נטען גם בדף מנהל המידע (בניית הכתובות) וגם כסקריפט תוכן ביד2/מדלן (הגלילה).
var LRPageWalker = (() => {
  const MAX_PAGES = 500;
  // {pagehere}, {page}, {p}, {n} – כל אחד מהם מסמן איפה מספר העמוד
  const PLACEHOLDER = /\{\s*(?:pagehere|page|p|n)\s*\}/gi;
  const ALLOWED_HOSTS = ["www.yad2.co.il", "yad2.co.il", "www.madlan.co.il", "madlan.co.il"];

  const SPEEDS = {
    slow: { stepPx: 250, stepMs: 700 },
    normal: { stepPx: 400, stepMs: 500 },
    fast: { stepPx: 700, stepMs: 350 },
  };

  function hasPlaceholder(template) {
    PLACEHOLDER.lastIndex = 0;
    return PLACEHOLDER.test(String(template || ""));
  }

  // מחזיר { urls } או { error } עם הודעה בעברית
  function buildPageUrls(template, from, to) {
    const text = String(template || "").trim();
    if (!text) return { error: "הדביקו כתובת של עמוד חיפוש." };
    const start = Number(from);
    const end = Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      return { error: "מספרי העמודים צריכים להיות מספרים שלמים, 1 ומעלה." };
    }
    if (end < start) return { error: "עמוד הסיום צריך להיות גדול או שווה לעמוד ההתחלה." };
    if (end - start + 1 > MAX_PAGES) return { error: `אפשר לדפדף עד ${MAX_PAGES} עמודים בכל פעם.` };

    const withPlaceholder = hasPlaceholder(text);
    const urls = [];
    for (let page = start; page <= end; page++) {
      let url;
      try {
        // בלי סימון עמוד: מוסיפים/מחליפים את הפרמטר page בכתובת
        if (withPlaceholder) {
          url = new URL(text.replace(PLACEHOLDER, String(page)));
        } else {
          url = new URL(text);
          url.searchParams.set("page", String(page));
        }
      } catch {
        return { error: "הכתובת אינה תקינה." };
      }
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.includes(url.hostname)) {
        return { error: "אפשר לדפדף רק בעמודים של יד2 או מדלן (https)." };
      }
      urls.push({ page, url: url.href });
    }
    return { urls };
  }

  // גלילה הדרגתית עד סוף העמוד. כשמגיעים לתחתית ממתינים – אם נטענו עוד תוצאות, ממשיכים לגלול.
  // env: { getY, getMaxY, scrollBy, sleep } – כדי שאפשר יהיה לבדוק בלי דפדפן
  async function slowScrollToBottom(env, options = {}) {
    const speed = SPEEDS[options.speed] || SPEEDS.normal;
    const stepPx = options.stepPx || speed.stepPx;
    const stepMs = options.stepMs || speed.stepMs;
    const settleMs = options.settleMs ?? 2000;
    const settleRounds = options.settleRounds ?? 2;
    const maxMs = options.maxMs ?? 4 * 60 * 1000;
    const shouldStop = options.shouldStop || (() => false);
    let elapsed = 0;
    let steps = 0;
    let quietRounds = 0;

    while (elapsed < maxMs) {
      if (shouldStop()) return { reason: "stopped", steps };
      if (env.getY() < env.getMaxY() - 2) {
        env.scrollBy(stepPx);
        steps++;
        await env.sleep(stepMs);
        elapsed += stepMs;
        quietRounds = 0;
        continue;
      }
      // בתחתית: מחכים שאולי ייטענו עוד כרטיסים
      const maxBefore = env.getMaxY();
      await env.sleep(settleMs);
      elapsed += settleMs;
      if (env.getMaxY() > maxBefore + 2) {
        quietRounds = 0;
        continue;
      }
      quietRounds++;
      if (quietRounds >= settleRounds) return { reason: "bottom", steps };
    }
    return { reason: "timeout", steps };
  }

  function browserScrollEnv(win = typeof window !== "undefined" ? window : null) {
    const doc = win.document;
    const scroller = () => doc.scrollingElement || doc.documentElement;
    return {
      getY: () => scroller().scrollTop,
      getMaxY: () => scroller().scrollHeight - win.innerHeight,
      scrollBy: (px) => win.scrollBy({ top: px, behavior: "smooth" }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  return { MAX_PAGES, SPEEDS, hasPlaceholder, buildPageUrls, slowScrollToBottom, browserScrollEnv };
})();

if (typeof module !== "undefined") module.exports = LRPageWalker;
