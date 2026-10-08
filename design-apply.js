const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',async d=>{out('dialog',d.message());await d.accept().catch(()=>{})});
await p.goto('https://admin.blog.naver.com/AdminCategoryView.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('category_before',await p.locator('#tree').innerText());
const cta=p.locator('#tree ._categoryName').filter({hasText:/^세무사 수험$/});
if(await cta.count()){await cta.click();await p.locator('#category_name').fill('CTA');await p.locator('#category_name').press('Tab');}
for(const name of ['사업자','병·의원','법인','양도·상속·증여']){
if(await p.locator('#tree ._categoryName').filter({hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).count())continue;
await p.locator('#tree li.first-child').click();await p.locator('img._addCategoryView').click();await p.waitForTimeout(200);await p.locator('#category_name').fill(name);await p.locator('#category_name').press('Tab');
if(!await p.locator('#pub_c1').isChecked())await p.locator('#pub_c1').check();
}
out('category_unsaved',await p.locator('#tree').innerText());await p.locator('#submit_button').click();await p.waitForTimeout(3000);
await p.goto('https://admin.blog.naver.com/AdminCategoryView.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1200);out('category_saved',await p.locator('#tree').innerText());
await p.goto('https://blog.naver.com/tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(2000);for(const f of p.frames())if(f.url().includes('PostList'))out('category_links',await f.locator('a').evaluateAll(es=>es.map(e=>({text:e.innerText,href:e.href})).filter(e=>e.href.includes('from=postList'))));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('layout_boxes',await p.locator('[id]').evaluateAll(es=>es.filter(e=>/wz|area|layout|external|widget/i.test(e.id)).map(e=>({id:e.id,tag:e.tagName,cls:e.className,html:e.outerHTML.slice(0,250)})).slice(-180)));
await p.locator('#addExternalWidget').click();await p.waitForTimeout(500);
out('widget_dialog',await p.locator('input,textarea,a,button').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0).map(e=>({tag:e.tagName,id:e.id,cls:e.className,name:e.name,text:e.innerText,html:e.outerHTML.slice(0,600)})).slice(-80)));
const s=(await p.screenshot({type:'jpeg',quality:45})).toString('base64');for(let i=0;i<s.length;i+=30000)out('widgetdialog_shot_'+i,s.slice(i,i+30000));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();