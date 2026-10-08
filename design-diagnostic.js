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
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error("version_timeout")));
    req.on("error", reject);
  });
}
async function getVersion() {
  for (let i=1;i<=8;i++) {
    try { return await getVersionOnce(); }
    catch(e) { if (i===8) throw e; await sleep(1200); }
  }
}
async function connect() {
  const v = await getVersion();
  const ws = "ws://naver-chromium.railway.internal:9222" + new URL(v.webSocketDebuggerUrl).pathname;
  return chromium.connectOverCDP(ws, { headers:{ Host:"localhost:9222" }, timeout:30000 });
}
async function inspectPage(page, label, url) {
  await page.goto(url, { waitUntil:"domcontentloaded", timeout:30000 });
  await page.waitForTimeout(2200);
  out(label+"_url", page.url());

  const forms = await page.locator("form").evaluateAll(fs => fs.map(f => ({
    id:f.id||"", name:f.getAttribute("name")||"", action:f.action||"", method:f.method||"", cls:f.className||""
  })));
  out(label+"_forms", forms);

  const controls = await page.locator("input,select,textarea").evaluateAll(els => els.map(e => {
    const label = e.id ? document.querySelector('label[for="'+CSS.escape(e.id)+'"]') : null;
    const parentText = (e.closest("li, tr, dd, dt, div")?.innerText || "").trim().replace(/\s+/g," ").slice(0,240);
    return {
      tag:e.tagName.toLowerCase(), type:e.type||"", id:e.id||"", name:e.name||"",
      value:(e.type==="password"?"[redacted]":(e.value||"")).slice(0,180),
      checked:!!e.checked, selectedIndex:typeof e.selectedIndex==="number"?e.selectedIndex:null,
      label:(label?.innerText||"").trim().replace(/\s+/g," ").slice(0,160),
      parentText
    };
  }));
  out(label+"_controls", controls);

  const clickable = await page.locator("button, a, input[type=button], input[type=submit], input[type=image]").evaluateAll(els => els.map(e => ({
    tag:e.tagName.toLowerCase(), id:e.id||"", name:e.getAttribute("name")||"",
    text:(e.innerText||e.value||e.getAttribute("aria-label")||e.getAttribute("title")||"").trim().replace(/\s+/g," ").slice(0,160),
    cls:e.className||"", href:e.href||""
  })).filter(x => /적용|저장|완료|확인|선택|레이아웃|위젯|대표|프롤로그|메뉴|글|이미지|취소/i.test(x.text) || /save|submit|apply|layout|prologue|menu/i.test(x.id+" "+x.cls)));
  out(label+"_clickable", clickable);

  const body = await page.locator("body").innerText().catch(()=>"");
  out(label+"_body_excerpt", body.replace(/\n{3,}/g,"\n\n").slice(0,9000));
}

(async()=>{
  let browser;
  try {
    browser = await connect();
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await inspectPage(page, "layout", "https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152");
    await inspectPage(page, "prologue", "https://admin.blog.naver.com/tlsehdduq0152/config/prologue");
    await inspectPage(page, "topmenu", "https://admin.blog.naver.com/tlsehdduq0152/config/topmenu");
    out("targeted_diagnostic_done", true);
  } catch(e) {
    out("targeted_diagnostic_error", {message:e.message, stack:e.stack});
    process.exitCode=1;
  } finally {
    try { if(browser) await browser.close(); } catch(_){}
  }
})();