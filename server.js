const http = require("http");
const { chromium } = require("playwright-core");

function getVersion() {
  return new Promise((resolve, reject) => {
    const req = http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"},timeout:5000}, res => {
      let data=""; res.on("data",c=>data+=c); res.on("end",()=>{try{resolve(JSON.parse(data))}catch{reject(new Error("invalid version json"))}});
    });
    req.on("error",reject);
  });
}
function clean(s){return String(s||"").replace(/[\r\n]+/g," ").replace(/\s+/g," ").slice(0,180)}
async function main(){
  console.log("controller_boot=true");
  try{
    const v=await getVersion();
    const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
    const browser=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:10000});
    const pages=browser.contexts().flatMap(c=>c.pages());
    const page=pages.find(p=>p.url().includes("blog.naver.com")&&p.url().includes("Redirect=Write"));
    if(!page) throw new Error("naver editor not found");
    console.log("step1_editor_connected=true");
    await page.waitForTimeout(1000);
    const info=await page.evaluate(()=>{
      const els=[...document.querySelectorAll('input,textarea,[contenteditable="true"],iframe')];
      return els.slice(0,80).map((e,i)=>({
        i,tag:e.tagName,cls:e.className||"",ph:e.getAttribute("placeholder")||"",
        aria:e.getAttribute("aria-label")||"",role:e.getAttribute("role")||"",
        ce:e.getAttribute("contenteditable")||"",src:e.getAttribute("src")||"",
        text:(e.innerText||e.value||"").slice(0,80)
      }));
    });
    console.log("step2_candidate_count="+info.length);
    info.forEach(x=>console.log("candidate="+JSON.stringify(x)));
    const frames=page.frames();
    console.log("step3_frame_count="+frames.length);
    for(let i=0;i<frames.length;i++) console.log("frame_"+i+"_url="+clean(frames[i].url()));
    const titleCandidates=await page.locator('[contenteditable="true"],textarea,input').count();
    console.log("step4_editable_count="+titleCandidates);
    console.log("dom_inspection_complete=true");
    setInterval(()=>console.log("controller_heartbeat=true"),60000);
  }catch(e){console.error("controller_error="+e.message);setInterval(()=>console.log("controller_heartbeat_after_error=true"),60000)}
}
main();
