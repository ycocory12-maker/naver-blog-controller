const http=require("http"); const {chromium}=require("playwright-core");
function ver(){return new Promise((ok,no)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{ok(JSON.parse(d))}catch(e){no(e)}})});q.on("error",no)})}
const clean=s=>String(s||"").replace(/[\r\n]+/g," ").replace(/\s+/g," ").slice(0,160);
(async()=>{try{
 const v=await ver(),ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;
 const b=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"}});
 const p=b.contexts().flatMap(c=>c.pages()).find(x=>x.url().includes("Redirect=Write")); if(!p)throw Error("editor page missing");
 const frames=p.frames(); console.log("frame_count="+frames.length);
 for(let i=0;i<frames.length;i++){const f=frames[i]; let data;
  try{data=await f.evaluate(()=>[...document.querySelectorAll('input,textarea,[contenteditable="true"],button,[role="textbox"]')].slice(0,120).map((e,j)=>({j,tag:e.tagName,cls:e.className||"",ph:e.getAttribute("placeholder")||"",aria:e.getAttribute("aria-label")||"",role:e.getAttribute("role")||"",text:(e.innerText||e.value||"").slice(0,100)})))}catch(e){console.log("frame_"+i+"_error="+e.message);continue}
  console.log("frame_"+i+"_candidate_count="+data.length);
  data.forEach(x=>console.log("frame_"+i+"_candidate="+clean(JSON.stringify(x))));
 }
 console.log("frame_dom_inspection_complete=true");
 setInterval(()=>console.log("controller_heartbeat=true"),60000);
}catch(e){console.error("controller_error="+e.message);setInterval(()=>{},60000)}})();
