const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

p.on('dialog',d=>d.accept().catch(()=>{}));p.on('pageerror',e=>out('page_error',e.message));
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1500);
out('layout_backup',await p.evaluate(()=>({type:DD.layoutType,wtop:DD.wtopAreaWidgets,wleft:DD.wleftAreaWidgets,wright:DD.wrightAreaWidgets})));
for(let i=1;i<=5;i++)if(!await p.locator('#ex_'+i).isVisible())await p.locator('label[for="w_'+i+'"]').click();
await p.evaluate(()=>{const target=document.getElementById('left_menu_l');for(let i=1;i<=5;i++)target.appendChild(document.getElementById('ex_'+i));DD.setResize();});
out('layout_prepared',await p.evaluate(()=>{DD._preprocessForm(document.layoutForm);return Array.from(document.layoutForm.elements).filter(e=>/Widgets|layoutType|enabledExternalWidgets/.test(e.name)).map(e=>({name:e.name,value:e.value}));}));
await p.locator('#doApplyConfirm').click();await p.waitForTimeout(3500);out('layout_save_url',p.url());
await p.goto('https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);out('layout_saved',await p.evaluate(()=>({type:DD.layoutType,wtop:DD.wtopAreaWidgets,wleft:DD.wleftAreaWidgets,wright:DD.wrightAreaWidgets})));
await p.goto('https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
for(const [id,color] of [['background_inputbox_color','#FFFFFF'],['menuBasicFontColor_inputbox_color','#102039'],['menuBoldFontColor_inputbox_color','#1239C2'],['poststyle_fontcolor3_inputbox_color','#1239C2']]){
await p.locator('#'+id).evaluate((e,c)=>{e.value=c;e.dispatchEvent(new Event('input',{bubbles:true}));e.parentElement.querySelector('button._changeColor').click();},color);}
await p.locator('a.btn_submit._showConfirmLayer').click();await p.waitForTimeout(500);await p.locator('a.button_next._submit').filter({hasText:'적용'}).first().click();await p.waitForTimeout(3000);
await p.goto('https://admin.blog.naver.com/Remocon.naver?blogId=tlsehdduq0152&loadType=admin&Redirect=Remocon&SelectedMenu=title',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
out('color_saved',await p.locator('#background_inputbox_color,#menuBasicFontColor_inputbox_color,#menuBoldFontColor_inputbox_color,#poststyle_fontcolor3_inputbox_color').evaluateAll(es=>es.map(e=>({id:e.id,value:e.value}))));
await p.goto('https://blog.naver.com/tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(2000);
const s=(await p.screenshot({type:'jpeg',quality:70})).toString('base64');for(let i=0;i<s.length;i+=30000)out('finalpc_shot_'+i,s.slice(i,i+30000));
out('public_frames',p.frames().map(f=>f.url()));
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();