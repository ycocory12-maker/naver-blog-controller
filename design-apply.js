const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',d=>d.accept().catch(()=>{}));p.on('pageerror',e=>out('page_error',e.message));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('layout_before',await p.locator('td').evaluateAll(es=>es.filter(e=>e.querySelector('.drag_area')).map(e=>({id:e.id,cls:e.className,widgets:Array.from(e.children).map(x=>x.id)}))));
const menus=[['사업자',10],['병·의원',11],['법인',12],['양도·상속·증여',13],['CTA',1]];
for(const [name,id] of menus){
if((await p.locator('[id="ExternalWidget.targetUlList"]').innerText()).includes('SHIN 메뉴 '+name)){out('widget_reused',name);continue;}
await p.locator('#addExternalWidget').click();await p.waitForTimeout(250);
await p.locator('#ExternalWidgetLayer input[name="TITLE"]').fill('SHIN 메뉴 '+name);
await p.locator('#ExternalWidgetLayer textarea[name="CODE"]').fill('<a href="https://blog.naver.com/PostList.naver?blogId=tlsehdduq0152&categoryNo='+id+'" target="_top" style="display:block;width:170px;height:48px;text-align:center;background:#fff;color:#102039;font:bold 16px/48px Arial,sans-serif;text-decoration:none;border-bottom:1px solid #dce1e8">'+name+'</a>');
await p.locator('#ExternalWidgetLayer ._btnNext').click();await p.waitForTimeout(900);await p.locator('#ExternalWidgetLayer ._btnSubmit').click();await p.waitForTimeout(900);out('widget_registered',name);
}
out('layout_after',await p.locator('td').evaluateAll(es=>es.filter(e=>e.querySelector('.drag_area')).map(e=>({id:e.id,cls:e.className,widgets:Array.from(e.children).map(x=>({id:x.id,text:x.innerText?.slice(0,90)})),html:e.outerHTML.slice(0,1800)}))));
out('widgets',await p.locator('[id="ExternalWidget.targetUlList"]').evaluate(e=>e.outerHTML));
out('dragboxes',await p.locator('.drag_area').evaluateAll(es=>es.map(e=>({id:e.id,text:e.innerText?.slice(0,90),parent:e.parentElement.id,parentClass:e.parentElement.className,html:e.outerHTML.slice(0,1000)}))));
out('apply_links',await p.locator('a').evaluateAll(es=>es.filter(e=>/확인|적용/.test(e.innerText)||/Apply|CheckLayer|confirm/i.test(e.outerHTML)).map(e=>e.outerHTML).slice(-20)));
const s=(await p.screenshot({type:'jpeg',quality:45})).toString('base64');for(let i=0;i<s.length;i+=30000)out('widgets_shot_'+i,s.slice(i,i+30000));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();