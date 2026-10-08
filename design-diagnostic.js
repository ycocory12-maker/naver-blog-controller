const http=require("http"); const {chromium}=require("playwright-core");
const out=(k,v)=>console.log(k+"="+JSON.stringify(v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function ver(){return new Promise((res,rej)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});q.on("error",rej)})}
async function conn(){const v=await ver();const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;return chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000})}
async function probe(page,label,url,terms){
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000}); await page.waitForTimeout(2200);
 for(const term of terms){
   const loc=page.locator("a,button,label,span,div").filter({hasText:term});
   const n=await loc.count();
   const arr=[];
   for(let i=0;i<Math.min(n,12);i++){
     const el=loc.nth(i); const txt=(await el.innerText().catch(()=>"")).trim().replace(/\s+/g," ").slice(0,120);
     if(txt===term || txt.startsWith(term) || txt.length<80) arr.push({txt,html:(await el.evaluate(e=>e.outerHTML).catch(()=>"")).slice(0,900)});
   }
   out(label+"_"+term,{count:n,candidates:arr});
 }
}
(async()=>{let b;try{b=await conn();const c=b.contexts()[0];const p=c.pages()[0]||await c.newPage();
 await probe(p,"title","https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title",["적용","저장","미리보기"]);
 await probe(p,"layout","https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152",["적용","저장","중앙","넓게","사이드바1","사이드바2"]);
 out("probe_done",true);
}catch(e){out("probe_error",{message:e.message,stack:e.stack});process.exitCode=1}finally{try{if(b)await b.close()}catch(_){}}})();