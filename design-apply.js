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
  body{font-family:Arial,"Noto Sans KR","Malgun Gothic",sans-serif;background:#f7f7f4;color:#171717}
  .hero{width:966px;height:385px;position:relative;overflow:hidden;background:
    radial-gradient(circle at 78% 12%,rgba(31,91,255,.10),transparent 28%),
    linear-gradient(112deg,#fbfaf7 0%,#f7f7f4 54%,#eef2f7 100%)}
  .copy{position:absolute;left:54px;top:48px;width:540px;z-index:3}
  .eyebrow{font-size:11px;letter-spacing:4px;color:#555;margin-bottom:20px}
  .title{font-family:Georgia,"Times New Roman",serif;font-size:54px;line-height:.95;letter-spacing:-1px;font-weight:600}
  .title .blue{color:#1f5bff}
  .tag{margin-top:18px;font-size:23px;letter-spacing:-1.1px;font-weight:500}
  .meta{margin-top:14px;font-size:13px;color:#585858}
  .rule{margin-top:21px;width:42px;height:3px;background:#1f5bff}
  .office{position:absolute;right:0;top:0;width:390px;height:385px}
  .window{position:absolute;right:0;top:0;width:320px;height:205px;background:
    linear-gradient(90deg,rgba(255,255,255,.2),rgba(255,255,255,.78)),
    linear-gradient(180deg,#dce9f6 0%,#edf3f8 55%,#d6e0e7 100%);border-left:1px solid #d3d8dc}
  .window:before,.window:after{content:"";position:absolute;background:rgba(255,255,255,.8)}
  .window:before{left:105px;top:0;width:7px;height:205px}.window:after{left:0;top:104px;width:320px;height:6px}
  .city{position:absolute;right:12px;top:70px;width:270px;height:115px;opacity:.20;
    background:linear-gradient(90deg,transparent 0 5%,#5b7289 5% 10%,transparent 10% 14%,#6a7e92 14% 20%,transparent 20% 27%,#4f6a83 27% 35%,transparent 35% 46%,#6d8090 46% 51%,transparent 51% 60%,#4e667b 60% 70%,transparent 70% 76%,#657b8f 76% 85%,transparent 85%)}
  .desk{position:absolute;right:-20px;bottom:0;width:430px;height:105px;background:linear-gradient(180deg,#fdfdfc,#e8e6e2);border-top:1px solid #d9d7d1;box-shadow:0 -18px 28px rgba(30,40,50,.05)}
  .laptop{position:absolute;right:95px;bottom:83px;width:188px;height:9px;border-radius:4px;background:#aeb4bb;transform:skewX(-18deg);box-shadow:0 5px 8px rgba(0,0,0,.12)}
  .books{position:absolute;right:19px;bottom:63px;width:100px}.book{height:19px;margin-top:2px;background:#f4f2ed;border:1px solid #cfcac1;font:10px Georgia,serif;padding:3px 8px;color:#27313b}.book:last-child{background:#1d3557;color:#fff}
  .plant{position:absolute;right:280px;bottom:105px;width:80px;height:120px}
  .pot{position:absolute;bottom:0;left:26px;width:34px;height:42px;background:#d9d1c5;border-radius:2px 2px 8px 8px}
  .stem{position:absolute;left:42px;bottom:39px;width:3px;height:74px;background:#718c6a;transform:rotate(-7deg)}
  .leaf{position:absolute;width:27px;height:11px;background:#7c9a73;border-radius:100% 0 100% 0;transform:rotate(-25deg)}
  .l1{left:14px;top:23px}.l2{left:43px;top:38px;transform:rotate(28deg)}.l3{left:11px;top:54px}.l4{left:43px;top:69px;transform:rotate(35deg)}
  .bluebar{position:absolute;right:0;bottom:0;width:9px;height:385px;background:#1f5bff;opacity:.9}
  </style></head><body><div class="hero">
  <div class="copy"><div class="eyebrow">TAX · BUSINESS · PRACTICE</div>
  <div class="title">SHIN <span class="blue">TAX NOTE</span></div>
  <div class="tag">세금은 어렵지 않게, 판단은 정확하게</div>
  <div class="meta">세무사 신동엽 · 우대영세무사사무소</div><div class="rule"></div></div>
  <div class="office"><div class="window"><div class="city"></div></div><div class="plant"><div class="stem"></div><div class="leaf l1"></div><div class="leaf l2"></div><div class="leaf l3"></div><div class="leaf l4"></div><div class="pot"></div></div>
  <div class="desk"></div><div class="laptop"></div><div class="books"><div class="book">TAX LAW</div><div class="book">BUSINESS</div><div class="book">PRACTICE</div></div></div><div class="bluebar"></div></div></body></html>`;
  await p.setContent(html,{waitUntil:"load"});
  const file="/tmp/shin-tax-note-banner-385.png";
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