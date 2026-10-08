const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',d=>d.accept().catch(()=>{}));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
out('DD',await p.evaluate(()=>Object.fromEntries(['layoutType','getModel','_preprocessForm','BlockSetup','Permission','WidgetSetup','setDragArea','doApply'].map(k=>[k,typeof DD[k]==='function'?DD[k].toString():DD[k]]))));
out('zones',await p.locator('#top_od,#left_menu_l,#left_menu_r').evaluateAll(es=>es.map(e=>({id:e.id,parent:e.parentElement.outerHTML.slice(0,1000),rect:e.getBoundingClientRect().toJSON()}))));
for(const n of [10,11,12]){await p.locator('#skinselect_'+n).click();await p.waitForTimeout(200);out('layout_choice',{n,state:await p.evaluate(()=>({layoutType:DD.layoutType,wtop:DD.wtopAreaWidgets,wbottom:DD.wbottomAreaWidgets,wleft:DD.wleftAreaWidgets,wright:DD.wrightAreaWidgets})),zones:await p.locator('#top_od,#left_menu_l,#left_menu_r').evaluateAll(es=>es.map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON()})))});}
await p.goto('https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
out('color_controls',await p.locator('#background_inputbox_color,#menuBasicFontColor_inputbox_color,#menuBoldFontColor_inputbox_color,#poststyle_fontcolor3_inputbox_color').evaluateAll(es=>es.map(e=>e.parentElement.parentElement.outerHTML.slice(0,5000))));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();