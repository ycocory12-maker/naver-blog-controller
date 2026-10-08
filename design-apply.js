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
    const req=http.get({
      hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",
      headers:{Host:"localhost:9222"}
    },res=>{
      let data="";
      res.on("data",c=>data+=c);
      res.on("end",()=>{try{resolve(JSON.parse(data))}catch(e){reject(e)}});
    });
    req.setTimeout(5000,()=>req.destroy(new Error("version_timeout")));
    req.on("error",reject);
  });
}
async function connect() {
  let v;
  for(let i=0;i<8;i++){
    try{v=await versionOnce();break}
    catch(e){if(i===7)throw e;await sleep(1200)}
  }
  const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
  return chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000});
}
async function makeBanner(context) {
  const p=await context.newPage();
  await p.setViewportSize({width:966,height:385});
  const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:966px;height:385px;overflow:hidden}
    body{font-family:"Malgun Gothic","Noto Sans KR",Arial,sans-serif;background:#f9f9f7;color:#17191d}
    .hero{height:385px;width:966px;background:#fafaf8;position:relative}
    .line-top{position:absolute;left:63px;right:63px;top:42px;height:1px;background:#d5d6d3}
    .top-left{position:absolute;left:63px;top:57px;color:#555a60;font:11px Arial,sans-serif;letter-spacing:3.8px}
    .top-right{position:absolute;right:63px;top:57px;color:#787b7c;font:11px Arial,sans-serif;letter-spacing:1.2px}
    .headline{position:absolute;left:61px;top:120px;font:700 64px/1.1 Arial,sans-serif;letter-spacing:-2.8px;white-space:nowrap;color:#17191d}
    .headline .tax{color:#3157ff}
    .sub{position:absolute;left:63px;top:210px;font-size:23px;font-weight:600;letter-spacing:-1.4px;color:#24272b}
    .author{position:absolute;left:63px;top:257px;color:#636971;font-size:14px;letter-spacing:-.2px}
    .rule-blue{position:absolute;left:63px;top:305px;width:47px;height:3px;background:#3157ff}
    .line-bottom{position:absolute;left:63px;right:63px;bottom:42px;height:1px;background:#d5d6d3}
    .bottom-left{position:absolute;left:63px;bottom:18px;font:11px Arial,sans-serif;letter-spacing:1.5px;color:#656a70}
    .bottom-right{position:absolute;right:63px;bottom:18px;font:11px Arial,sans-serif;letter-spacing:1.3px;color:#656a70}
  </style></head><body>
  <div class="hero">
    <div class="line-top"></div>
    <div class="top-left">TAX · BUSINESS · PRACTICE</div>
    <div class="top-right">INDEPENDENT TAX JOURNAL / 2026</div>
    <div class="headline">SHIN <span class="tax">TAX NOTE</span></div>
    <div class="sub">세금은 어렵지 않게, 판단은 정확하게</div>
    <div class="author">세무사 신동엽 &nbsp;·&nbsp; 우대영세무사사무소</div>
    <div class="rule-blue"></div>
    <div class="line-bottom"></div>
    <div class="bottom-left">TAX NOTES — EDITORIAL</div>
    <div class="bottom-right">SEOUL, KOREA</div>
  </div></body></html>`;
  await p.setContent(html,{waitUntil:"load"});
  const file="/tmp/shin-tax-note-editorial-banner.png";
  await p.screenshot({path:file,type:"png"});
  await p.close();
  return file;
}
async function setValue(page,selector,value){
  const el=page.locator(selector);
  if(!await el.count()) throw new Error("missing_control:"+selector);
  await el.evaluate((node,v)=>{
    node.value=String(v);
    node.dispatchEvent(new Event("input",{bubbles:true}));
    node.dispatchEvent(new Event("change",{bubbles:true}));
    node.dispatchEvent(new Event("blur",{bubbles:true}));
  },String(value));
}
async function setChecked(page,selector,checked){
  const el=page.locator(selector);
  if(!await el.count()) return;
  await el.evaluate((node,v)=>{
    node.checked=!!v;
    node.dispatchEvent(new Event("change",{bubbles:true}));
  },!!checked);
}
async function readState(page){
  const ids=[
    "background_inputbox_color","title_height","titleback_inputbox_color","titlefont_inputbox_color",
    "gnbfont_inputbox_color","menuBasicFontColor_inputbox_color","menuBoldFontColor_inputbox_color",
    "poststyleborder_inputbox_color","poststyle_fontcolor1_inputbox_color",
    "poststyle_fontcolor2_inputbox_color","poststyle_fontcolor3_inputbox_color","profilecolor_inputbox_color"
  ];
  const state={};
  for(const id of ids){
    const e=page.locator("#"+id);
    if(await e.count()) state[id]=await e.inputValue().catch(()=>"");
  }
  const cb=page.locator("#chk_title_display");
  if(await cb.count()) state.chk_title_display=await cb.isChecked().catch(()=>null);
  return state;
}
async function save(page){
  const first=page.locator("a.btn_submit._showConfirmLayer").filter({hasText:"적용"}).first();
  if(!await first.count()) throw new Error("primary_apply_missing");
  await first.click();
  await page.waitForTimeout(800);
  const confirm=page.locator("a.button_next._submit").filter({hasText:"적용"});
  for(let i=0;i<await confirm.count();i++){
    const el=confirm.nth(i);
    if(await el.isVisible().catch(()=>false)){
      await el.click();
      await page.waitForTimeout(3500);
      return;
    }
  }
  throw new Error("confirm_apply_missing");
}
(async()=>{
  let browser;
  try{
    browser=await connect();
    const context=browser.contexts()[0] || await browser.newContext();
    const banner=await makeBanner(context);
    out("banner_bytes",fs.statSync(banner).size);

    const page=context.pages()[0] || await context.newPage();
    await page.goto(REMOCON,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(2500);
    out("before",await readState(page));

    // Keep the existing native skin settings. Replace only the title image and hide the old text overlay.
    const titleDisplay=page.locator("#chk_title_display");
    if(await titleDisplay.count() && await titleDisplay.isChecked().catch(()=>false)){
      await titleDisplay.uncheck({force:true});
      await page.waitForTimeout(500);
    }

    await page.locator("#titleInputFile").setInputFiles(banner);
    await page.waitForTimeout(3500);
    out("banner_uploaded",true);

    await save(page);
    out("remocon_applied",true);

    await page.goto(REMOCON,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(2200);
    out("after",await readState(page));

    await page.goto(PUBLIC,{waitUntil:"domcontentloaded",timeout:30000});
    await page.waitForTimeout(3000);
    out("public_title",await page.title());
    out("design_apply_done",true);
  }catch(e){
    out("design_apply_error",{message:e.message,stack:e.stack});
    process.exitCode=1;
  }finally{
    try{if(browser)await browser.close()}catch(_){}
  }
})();