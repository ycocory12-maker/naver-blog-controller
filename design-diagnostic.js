const http = require("http");
const { chromium } = require("playwright-core");

function out(key, value) {
  console.log(key + "=" + (typeof value === "string" ? value : JSON.stringify(value)));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getVersionOnce() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "naver-chromium.railway.internal",
      port: 9222,
      path: "/json/version",
      headers: { Host: "localhost:9222" },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("version_timeout")));
    req.on("error", reject);
  });
}

async function getVersion() {
  for (let i = 1; i <= 8; i++) {
    try { return await getVersionOnce(); }
    catch (e) { out("version_error_" + i, e.message); if (i < 8) await sleep(1500); }
  }
  throw new Error("cdp_unavailable");
}

async function summarizePage(page, label) {
  await page.waitForTimeout(2500);
  out(label + "_url", page.url());
  out(label + "_title", await page.title().catch(() => ""));
  const bodyText = await page.locator("body").innerText().catch(() => "");
  out(label + "_body", bodyText.slice(0, 12000));
  const links = await page.locator("a").evaluateAll(els => els.slice(0, 120).map(a => ({
    text: (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    href: a.href || ""
  })).filter(x => x.text || x.href));
  out(label + "_links", links);
  const buttons = await page.locator("button").evaluateAll(els => els.slice(0, 120).map(b => ({
    text: (b.innerText || b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    aria: b.getAttribute("aria-label") || "",
    cls: b.className || ""
  })));
  out(label + "_buttons", buttons);
  const inputs = await page.locator("input").evaluateAll(els => els.slice(0, 120).map(i => ({
    type: i.type || "",
    name: i.name || "",
    id: i.id || "",
    value: i.type === "password" ? "[redacted]" : (i.value || "").slice(0, 100),
    accept: i.accept || "",
    cls: i.className || ""
  })));
  out(label + "_inputs", inputs);
}

(async () => {
  let browser;
  try {
    const version = await getVersion();
    const wsUrl = "ws://naver-chromium.railway.internal:9222" + new URL(version.webSocketDebuggerUrl).pathname;
    browser = await chromium.connectOverCDP(wsUrl, { headers: { Host: "localhost:9222" }, timeout: 30000 });
    const context = browser.contexts()[0] || await browser.newContext();
    let pages = context.pages();
    let page = pages.find(p => /admin\.blog\.naver\.com/.test(p.url())) || pages.find(p => /blog\.naver\.com/.test(p.url())) || await context.newPage();
    await page.goto("https://admin.blog.naver.com/tlsehdduq0152", { waitUntil: "domcontentloaded", timeout: 30000 });
    await summarizePage(page, "admin_root");

    const candidates = [
      "꾸미기 설정",
      "세부 디자인 설정",
      "레이아웃·위젯 설정",
      "타이틀 꾸미기",
      "스킨 선택",
      "내 스킨 관리"
    ];
    for (const text of candidates) {
      const loc = page.getByText(text, { exact: true }).first();
      const count = await loc.count().catch(() => 0);
      const visible = count ? await loc.isVisible().catch(() => false) : false;
      out("candidate_" + text.replace(/\s+/g, "_"), { count, visible });
    }

    out("diagnostic_done", true);
  } catch (e) {
    out("diagnostic_error", { message: e.message, stack: e.stack });
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
})();