const http=require("http"); const {chromium}=require("playwright-core");
function out(k,v){console.log(k+"="+JSON.stringify(v))}
function ver(){return new Promise((res,rej)=>{const q=http.get({hostname:"naver-chromium.railway.internal",port:9222,path:"/json/version",headers:{Host:"localhost:9222"}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});q.on("error",rej)})}
(async()=>{let b;try{const v=await ver();const ws="ws://naver-chromium.railway.internal:9222"+new URL(v.webSocketDebuggerUrl).pathname;b=await chromium.connectOverCDP(ws,{headers:{Host:"localhost:9222"},timeout:30000});const p=b.contexts()[0].pages()[0];
await p.goto("https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title",{waitUntil:"domcontentloaded",timeout:30000});await p.waitForTimeout(2500);
const exact=await p.locator("a,button,input").evaluateAll(es=>es.map(e=>({tag:e.tagName.toLowerCase(),id:e.id||"",cls:e.className||"",text:(e.innerText||e.value||"").trim(),href:e.getAttribute("href")||"",onclick:e.getAttribute("onclick")||""})).filter(x=>x.text==="적용"||x.text==="취소"||x.text==="확인"||/apply|save/i.test(x.id+" "+x.cls+" "+x.onclick)));
out("exact_controls",exact);
const ids=["title_height","titleback_inputbox_color","titleInputFile","chk_title_display","background_inputbox_color","gnbfont_inputbox_color","menuBasicFontColor_inputbox_color","menuBoldFontColor_inputbox_color","poststyleborder_inputbox_color","poststyle_fontcolor1_inputbox_color","poststyle_fontcolor2_inputbox_color","poststyle_fontcolor3_inputbox_color","profilecolor_inputbox_color"];
const vals={};for(const id of ids){const e=p.locator("#"+id);if(await e.count())vals[id]={value:await e.inputValue().catch(()=>""),checked:await e.isChecked().catch(()=>null)}}
out("current",vals);
}catch(e){out("err",{message:e.message})}finally{try{if(b)await b.close()}catch(_){}}})();