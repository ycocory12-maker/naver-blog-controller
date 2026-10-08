const http=require("http"); const {chromium}=require("playwright-core");
const out=(k,v)=>console.log(k+"="+(typeof v==="string"?v:JSON.stringify(v)));
function ver(){return new Promise((res,rej)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});q.on("error",rej)})}
(async()=>{let b;try{
 const v=await ver(); const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
 b=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000});
 const c=b.contexts()[0]; const p=c.pages()[0]||await c.newPage();
 await p.setViewportSize({width:1540,height:920});
 await p.goto("https://blog.naver.com/tlsehdduq0152",{waitUntil:"domcontentloaded",timeout:30000}); await p.waitForTimeout(4500);
 out("url",p.url()); out("title",await p.title());
 const styles=await p.locator("body *").evaluateAll(es=>es.map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id||"",cls:(typeof e.className==="string"?e.className:"").slice(0,120),w:Math.round(r.width),h:Math.round(r.height),bg:s.backgroundImage,disp:s.display,txt:(e.innerText||"").trim().replace(/\s+/g," ").slice(0,80)}}).filter(x=>x.w>700&&x.h>180&&x.h<500&&x.bg&&x.bg!=="none").slice(0,20));
 out("large_backgrounds",styles);
 const imgs=await p.locator("img").evaluateAll(es=>es.map(e=>({src:e.src||"",alt:e.alt||"",w:e.naturalWidth||0,h:e.naturalHeight||0})).filter(x=>x.w>700||x.h>250).slice(0,20));
 out("large_images",imgs);
 const shot=await p.screenshot({type:"jpeg",quality:58,fullPage:false});
 const b64=shot.toString("base64"); out("shot_len",b64.length);
 const chunk=18000; for(let i=0,n=0;i<b64.length;i+=chunk,n++) out("shot_"+n,b64.slice(i,i+chunk));
 out("public_probe_done",true);
}catch(e){out("probe_error",{message:e.message,stack:e.stack});process.exitCode=1}finally{try{if(b)await b.close()}catch(_){}}})();