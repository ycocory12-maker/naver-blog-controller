const http=require("http"); const {chromium}=require("playwright-core");
const out=(k,v)=>console.log(k+"="+(typeof v==="string"?v:JSON.stringify(v)));
function ver(){return new Promise((res,rej)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});q.on("error",rej)})}
(async()=>{let b;try{
 const v=await ver(); const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
 b=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000});
 const c=b.contexts()[0]; const p=c.pages()[0]||await c.newPage();
 await p.setViewportSize({width:1540,height:980});
 await p.goto("https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152",{waitUntil:"domcontentloaded",timeout:30000}); await p.waitForTimeout(3500);
 out("url",p.url()); out("title",await p.title());
 const controls=await p.locator("input[type=radio],input[type=checkbox]").evaluateAll(es=>es.map(e=>({
  id:e.id||"",name:e.name||"",value:e.value||"",checked:!!e.checked,
  label:(e.id?(document.querySelector('label[for="'+e.id+'"]')?.innerText||""):"").trim().replace(/\s+/g," ").slice(0,120)
 })).filter(x=>!x.id.startsWith("nsvc_")));
 out("controls",controls);
 const ids=await p.locator("[id^=type], [id*=layout], [id*=Layout], [class*=layout], [class*=type]").evaluateAll(es=>es.map(e=>({
  tag:e.tagName.toLowerCase(),id:e.id||"",cls:(typeof e.className==="string"?e.className:"").slice(0,120),
  txt:(e.innerText||"").trim().replace(/\s+/g," ").slice(0,140)
 })).filter(x=>x.id||x.txt).slice(0,120));
 out("layout_nodes",ids);
 const shot=await p.screenshot({type:"jpeg",quality:62,fullPage:false});
 const b64=shot.toString("base64"); out("shot_len",b64.length);
 const chunk=18000; for(let i=0,n=0;i<b64.length;i+=chunk,n++) out("shot_"+n,b64.slice(i,i+chunk));
 out("layout_probe_done",true);
}catch(e){out("probe_error",{message:e.message,stack:e.stack});process.exitCode=1}finally{try{if(b)await b.close()}catch(_){}}})();