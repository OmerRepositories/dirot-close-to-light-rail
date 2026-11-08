const assert = require("node:assert/strict");
const test = require("node:test");

const Walker = require("../page-walker.js");

const TEMPLATE = "https://www.yad2.co.il/realestate/forsale/center-and-sharon?area=4&city=7900&page={pagehere}";

test("buildPageUrls fills the page placeholder for every page in the range", () => {
  const { urls, error } = Walker.buildPageUrls(TEMPLATE, 3, 5);
  assert.equal(error, undefined);
  assert.deepEqual(urls.map((item) => item.page), [3, 4, 5]);
  assert.equal(urls[0].url, "https://www.yad2.co.il/realestate/forsale/center-and-sharon?area=4&city=7900&page=3");
  assert.equal(urls[2].url.endsWith("page=5"), true);
});

test("buildPageUrls accepts other placeholder spellings and adds page= when there is none", () => {
  assert.equal(Walker.buildPageUrls(TEMPLATE.replace("{pagehere}", "{ Page }"), 2, 2).urls[0].url.endsWith("page=2"), true);
  const noPlaceholder = Walker.buildPageUrls("https://www.yad2.co.il/realestate/forsale?city=7900&page=9", 1, 2);
  assert.deepEqual(noPlaceholder.urls.map((item) => item.url), [
    "https://www.yad2.co.il/realestate/forsale?city=7900&page=1",
    "https://www.yad2.co.il/realestate/forsale?city=7900&page=2",
  ]);
  assert.equal(Walker.buildPageUrls("https://www.madlan.co.il/for-sale/x", 4, 4).urls[0].url, "https://www.madlan.co.il/for-sale/x?page=4");
});

test("buildPageUrls rejects bad ranges, other sites and invalid URLs", () => {
  assert.ok(Walker.buildPageUrls("", 1, 2).error);
  assert.ok(Walker.buildPageUrls(TEMPLATE, 5, 2).error);
  assert.ok(Walker.buildPageUrls(TEMPLATE, 0, 2).error);
  assert.ok(Walker.buildPageUrls(TEMPLATE, 1.5, 2).error);
  assert.ok(Walker.buildPageUrls(TEMPLATE, 1, Walker.MAX_PAGES + 1).error);
  assert.ok(Walker.buildPageUrls("https://example.com/?page={pagehere}", 1, 2).error);
  assert.ok(Walker.buildPageUrls("http://www.yad2.co.il/?page={pagehere}", 1, 2).error);
  assert.ok(Walker.buildPageUrls("not a url {pagehere}", 1, 2).error);
});

function fakePage({ height, viewport = 1000, growOnceAtBottom = 0 }) {
  let y = 0;
  let total = height;
  let grown = false;
  let slept = 0;
  return {
    env: {
      getY: () => y,
      getMaxY: () => total - viewport,
      scrollBy: (px) => { y = Math.min(y + px, total - viewport); },
      sleep: async (ms) => {
        slept += ms;
        // עמוד שטוען עוד תוצאות כשמגיעים לתחתית (פעם אחת)
        if (growOnceAtBottom && !grown && y >= total - viewport - 2) {
          grown = true;
          total += growOnceAtBottom;
        }
      },
    },
    get y() { return y; },
    get maxY() { return total - viewport; },
    get slept() { return slept; },
  };
}

test("slowScrollToBottom scrolls in small steps until the bottom stays put", async () => {
  const page = fakePage({ height: 3000 });
  const result = await Walker.slowScrollToBottom(page.env, { stepPx: 400, stepMs: 10, settleMs: 5 });
  assert.equal(result.reason, "bottom");
  assert.equal(page.y, page.maxY);
  assert.equal(result.steps, 5); // 2000px / 400px
});

test("slowScrollToBottom keeps going when more results load at the bottom", async () => {
  const page = fakePage({ height: 2000, growOnceAtBottom: 1500 });
  const result = await Walker.slowScrollToBottom(page.env, { stepPx: 500, stepMs: 10, settleMs: 5 });
  assert.equal(result.reason, "bottom");
  assert.equal(page.maxY, 2500);
  assert.equal(page.y, 2500);
});

test("slowScrollToBottom stops on request and on the time limit", async () => {
  const stopped = await Walker.slowScrollToBottom(fakePage({ height: 50000 }).env, {
    stepPx: 100, stepMs: 10, shouldStop: () => true,
  });
  assert.equal(stopped.reason, "stopped");
  const timedOut = await Walker.slowScrollToBottom(fakePage({ height: 50000 }).env, {
    stepPx: 100, stepMs: 10, maxMs: 100,
  });
  assert.equal(timedOut.reason, "timeout");
});
