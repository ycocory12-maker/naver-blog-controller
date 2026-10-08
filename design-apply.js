const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

const shot=async name=>{const s=(await p.screenshot({type:'jpeg',quality:75})).toString('base64');for(let i=0;i<s.length;i+=30000)out(name+'_shot_'+i,s.slice(i,i+30000));};
const PUBLIC='https://blog.naver.com/tlsehdduq0152';
await p.goto(PUBLIC,{waitUntil:'domcontentloaded'});await p.waitForTimeout(2000);await shot('verified_pc');
for(const [name,id] of [['사업자',10],['병·의원',11],['법인',12],['양도·상속·증여',13],['CTA',1]]){
await p.goto(PUBLIC,{waitUntil:'domcontentloaded'});await p.waitForTimeout(1200);
let link;for(const f of p.frames()){if(f.url().includes('ExternalWidgetRender')){const el=f.getByRole('link',{name,exact:true});if(await el.count()){link=el;break;}}}if(!link)throw Error('menu_link_missing:'+name);
const beforePages=new Set(p.context().pages());const meta=await link.evaluate(e=>({href:e.href,target:e.target}));await link.click();await p.waitForTimeout(2000);const added=p.context().pages().filter(q=>!beforePages.has(q));out('click_destination',{name,meta,newPages:added.map(q=>({url:q.url(),frames:q.frames().map(f=>f.url())}))});for(const q of added)await q.close();
out('menu_verified',{name,expectedCategory:id,url:p.url(),frames:p.frames().map(f=>f.url()),text:(await p.locator('body').innerText()).slice(0,400)});
}
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
out('saved_layout',await p.evaluate(()=>({type:DD.layoutType,top:DD.wtopAreaWidgets,left:DD.wleftAreaWidgets,right:DD.wrightAreaWidgets})));await shot('verified_admin');
await p.goto('https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);out('saved_colors',await p.locator('#background_inputbox_color,#menuBasicFontColor_inputbox_color,#poststyle_fontcolor3_inputbox_color,#title_height,#chk_title_display').evaluateAll(es=>es.map(e=>({id:e.id,value:e.value,checked:e.checked}))));
await p.setViewportSize({width:390,height:844});
await p.goto('https://m.blog.naver.com/tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1800);
await p.getByRole('button',{name:'카테고리 이동',exact:true}).click();await p.waitForTimeout(700);out('mobile_category',{text:(await p.locator('body').innerText()).slice(0,2000),links:await p.locator('a').evaluateAll(es=>es.map(e=>({text:e.innerText,href:e.href})).filter(x=>/categoryNo|category/.test(x.href)).slice(0,30))});out('mobile',{url:p.url(),text:(await p.locator('body').innerText()).slice(0,6000),links:await p.locator('a,button').evaluateAll(es=>es.map(e=>({tag:e.tagName,text:e.innerText,aria:e.getAttribute('aria-label'),href:e.getAttribute('href')})).filter(x=>/카테고리|CTA|사업자|병|법인|양도/.test(x.text+x.aria+x.href)).slice(0,30))});await shot('verified_mobile');
out('verification_done',true);
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();