const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',d=>d.accept().catch(()=>{}));p.on('pageerror',e=>out('page_error',e.message));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('registered',await p.locator('[id="ExternalWidget.targetUlList"] label[title]').evaluateAll(es=>es.map(e=>({name:e.title,for:e.htmlFor}))));
await p.locator('#skinselect_10').click();await p.waitForTimeout(800);
out('layout10_zones',await p.locator('[id]').evaluateAll(es=>es.filter(e=>Array.from(e.children).some(c=>c.classList.contains('drag_area'))).map(e=>({id:e.id,tag:e.tagName,cls:e.className,children:Array.from(e.children).map(c=>({id:c.id,text:c.innerText?.slice(0,80)}))}))));
out('layout_funcs',await p.evaluate(()=>({apply:typeof openCheckLayer==='function'?openCheckLayer.toString():'',DDkeys:typeof DD==='object'?Object.keys(DD):[],scriptSrc:Array.from(document.scripts).map(s=>s.src).filter(Boolean)})));
const s=(await p.screenshot({type:'jpeg',quality:45})).toString('base64');for(let i=0;i<s.length;i+=30000)out('dragged_shot_'+i,s.slice(i,i+30000));
await p.locator('#doApplyConfirm').click();await p.waitForTimeout(800);
out('pages',p.context().pages().map(p=>p.url()));for(const q of p.context().pages())if(q!==p&&q.url().includes('Layout')){out('popup',await q.locator('body').innerText());out('popup_controls',await q.locator('a,button,input').evaluateAll(es=>es.map(e=>e.outerHTML)));}out('confirm_html',await p.locator('a,input,button').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0&&/적용|확인|저장/.test(e.innerText||e.value||e.outerHTML)).map(e=>e.outerHTML).slice(-25)));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();