const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',d=>d.accept().catch(()=>{}));p.on('pageerror',e=>out('page_error',e.message));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('registered',await p.locator('[id="ExternalWidget.targetUlList"] label[title]').evaluateAll(es=>es.map(e=>({name:e.title,for:e.htmlFor}))));
for(let i=1;i<=5;i++){
const src=p.locator('#ex_'+i);if(!await src.count())throw Error('missing_widget_'+i);
if(!await src.isVisible()){await p.locator('label[for="w_'+i+'"]').click();await p.waitForTimeout(300);}
await src.scrollIntoViewIfNeeded();const target=p.locator('#top_od');await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();
await src.dragTo(target,{targetPosition:{x:25+(i-1)*123,y:box.height-3},timeout:10000});await p.waitForTimeout(600);
out('widget_drag',{id:i,parent:await src.evaluate(e=>e.parentElement.id)});
}
out('top_children',await p.locator('#top_od').evaluate(e=>Array.from(e.children).map(x=>({id:x.id,text:x.innerText}))));
const s=(await p.screenshot({type:'jpeg',quality:45})).toString('base64');for(let i=0;i<s.length;i+=30000)out('dragged_shot_'+i,s.slice(i,i+30000));
await p.locator('#doApplyConfirm').click();await p.waitForTimeout(800);
out('confirm_html',await p.locator('a,input,button').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0&&/적용|확인|저장/.test(e.innerText||e.value||e.outerHTML)).map(e=>e.outerHTML).slice(-25)));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();