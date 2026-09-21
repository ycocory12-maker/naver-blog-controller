const http=require("http");const{chromium}=require("playwright-core");
function ver(){return new Promise((ok,no)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{ok(JSON.parse(d))}catch(e){no(e)}})});q.on("error",no)})}
const c=s=>String(s||"").replace(/[\r\n]+/g," ").replace(/\s+/g," ").slice(0,220);
(async()=>{try{
 const v=await ver(),ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
 const b=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"}});
 const p=b.contexts().flatMap(x=>x.pages()).find(x=>x.url().includes("Redirect=Write"));if(!p)throw Error("page missing");
 const f=p.frames().find(x=>x.url().includes("PostWriteForm.naver"));if(!f)throw Error("editor frame missing");
 const out=await f.evaluate(()=>[...document.querySelectorAll("*")].filter(e=>{
   const cl=String(e.className||""),ph=e.getAttribute&&e.getAttribute("placeholder")||"",txt=(e.innerText||"");
   return /title|text|paragraph|content|editor|document|placeholder/i.test(cl+" "+ph)||/제목|글감과 함께 나의 일상을 기록해보세요/.test(txt);
 }).slice(0,160).map((e,i)=>({i,tag:e.tagName,cls:String(e.className||"").slice(0,180),ph:e.getAttribute("placeholder")||"",ce:e.getAttribute("contenteditable")||"",role:e.getAttribute("role")||"",text:(e.innerText||e.textContent||"").slice(0,100)})));
 console.log("target_candidate_count="+out.length);out.forEach(x=>console.log("target="+c(JSON.stringify(x))));
 console.log("target_selector_inspection_complete=true");setInterval(()=>{},60000);
}catch(e){console.error("controller_error="+e.message);setInterval(()=>{},60000)}})();