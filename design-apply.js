const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});
for(const [name,url] of [['category','https://admin.blog.naver.com/AdminCategoryView.naver?blogId=tlsehdduq0152'],['layout','https://admin.blog.naver.com/LayoutSelect.naver?blogId=tlsehdduq0152']]){
await p.goto(url,{waitUntil:'domcontentloaded'});await p.waitForTimeout(2000);
out(name+'_url',p.url());
for(const fr of p.frames()){if(fr.url()==='about:blank')continue;out(name+'_details',{url:fr.url(),text:(await fr.locator('body').innerText()).slice(-12000),html:await fr.locator('a,button,img,input,textarea,ul,select').evaluateAll(es=>es.filter(e=>!e.closest('#gnb')&&!e.closest('.gnb')&&!e.id.startsWith('nsvc')&&!e.id.startsWith('all_')).map(e=>e.outerHTML).filter(s=>/category|tree|위젯|widget|추가|등록|확인|적용|titleArea|topArea|leftArea|rightArea|bottomArea|layoutType/i.test(s)).map(s=>s.slice(0,7000)).slice(-100))});}
const buf=await p.screenshot({type:'jpeg',quality:35});const str=buf.toString('base64');for(let i=0;i<str.length;i+=30000)out(name+'_shot_'+i,str.slice(i,i+30000));
}
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();