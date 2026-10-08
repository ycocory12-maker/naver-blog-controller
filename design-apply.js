const http = require("http");
const fs = require("fs");
const { chromium } = require("playwright-core");

const BLOG_ID = "tlsehdduq0152";
const REMOCON = "https://admin.blog.naver.com/Remocon.naver?blogId=" + BLOG_ID + "&loadType=admin&Redirect=Remocon&SelectedMenu=title";
const PUBLIC = "https://blog.naver.com/" + BLOG_ID;
const out = (k,v) => console.log(k + "=" + (typeof v === "string" ? v : JSON.stringify(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function versionOnce() {
  return new Promise((resolve,reject) => {
    const req = http.get({
      hostname:"naver-chromium.railway.internal", port:9222, path:"/json/version",
      headers:{Host:"localhost:9222"}
    }, res => {
      let data="";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error("version_timeout")));
    req.on("error", reject);
  });
}
async function connect() {
  let v;
  for (let i=0;i<8;i++) {
    try { v = await versionOnce(); break; }
    catch(e) { if(i===7) throw e; await sleep(1200); }
  }
  const ws = "ws://naver-chromium.railway.internal:9222" + new URL(v.webSocketDebuggerUrl).pathname;
  return chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000});
}
async function setText(page, selector, value) {
  const el = page.locator(selector);
  if (!await el.count()) throw new Error("missing_control:" + selector);
  await el.fill(String(value));
  await el.dispatchEvent("input").catch(()=>{});
  await el.dispatchEvent("change").catch(()=>{});
  await el.blur().catch(()=>{});
}
async function readState(page) {
  const selectors = [
    "#background_inputbox_color","#title_height","#titleback_inputbox_color",
    "#titlefont_inputbox_color","#gnbfont_inputbox_color",
    "#menuBasicFontColor_inputbox_color","#menuBoldFontColor_inputbox_color",
    "#poststyleborder_inputbox_color","#poststyle_fontcolor1_inputbox_color",
    "#poststyle_fontcolor2_inputbox_color","#poststyle_fontcolor3_inputbox_color",
    "#profilecolor_inputbox_color"
  ];
  const state={};
  for(const s of selectors) {
    const el=page.locator(s);
    if(await el.count()) state[s]=await el.inputValue().catch(()=>"");
  }
  const cb=page.locator("#chk_title_display");
  if(await cb.count()) state["#chk_title_display"]=await cb.isChecked().catch(()=>null);
  return state;
}
async function save(page) {
  await page.locator("a.btn_submit._showConfirmLayer").filter({hasText:"적용"}).first().click();
  await page.waitForTimeout(700);
  const confirm=page.locator("a.button_next._submit").filter({hasText:"적용"});
  for(let i=0;i<await confirm.count();i++) {
    const el=confirm.nth(i);
    if(await el.isVisible().catch(()=>false)) {
      await el.click();
      await page.waitForTimeout(3500);
      return;
    }
  }
  throw new Error("confirm_apply_missing");
}

(async()=>{
  let browser;
  try {
    const banner="/tmp/shin-tax-note-banner.jpg";
    const b64=fs.readFileSync("assets/shin-tax-note-banner.b64","utf8").trim();
    fs.writeFileSync(banner, Buffer.from(b64,"base64"));
    out("banner_bytes", fs.statSync(banner).size);

    browser=await connect();
    const context=browser.contexts()[0] || await browser.newContext();
    const page=context.pages()[0] || await context.newPage();

    await page.goto(REMOCON,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(2500);
    out("before", await readState(page));

    await setText(page,"#background_inputbox_color","#F7F7F4");
    await setText(page,"#title_height","328");
    await setText(page,"#titleback_inputbox_color","#F7F7F4");
    await setText(page,"#titlefont_inputbox_color","#171717");
    await setText(page,"#gnbfont_inputbox_color","#171717");
    await setText(page,"#menuBasicFontColor_inputbox_color","#4A4A4A");
    await setText(page,"#menuBoldFontColor_inputbox_color","#1F5BFF");
    await setText(page,"#poststyleborder_inputbox_color","#E7E7E3");
    await setText(page,"#poststyle_fontcolor1_inputbox_color","#171717");
    await setText(page,"#poststyle_fontcolor2_inputbox_color","#444444");
    await setText(page,"#poststyle_fontcolor3_inputbox_color","#1F5BFF");
    await setText(page,"#profilecolor_inputbox_color","#555555");

    const titleDisplay=page.locator("#chk_title_display");
    if(await titleDisplay.count() && await titleDisplay.isChecked()) await titleDisplay.uncheck();

    await page.locator("#titleInputFile").setInputFiles(banner);
    await page.waitForTimeout(3000);
    out("banner_uploaded", true);

    await save(page);
    out("remocon_applied", true);

    await page.goto(REMOCON,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(2200);
    out("after", await readState(page));

    await page.goto(PUBLIC,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(3000);
    out("public_title", await page.title());
    out("design_apply_done", true);
  } catch(e) {
    out("design_apply_error",{message:e.message,stack:e.stack});
    process.exitCode=1;
  } finally {
    try { if(browser) await browser.close(); } catch(_) {}
  }
})();