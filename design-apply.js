const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});
for(const [name,url] of [['public','https://blog.naver.com/tlsehdduq0152'],['admin','https://admin.blog.naver.com/tlsehdduq0152/config/category']]){
await p.goto(url,{waitUntil:'domcontentloaded'});await p.waitForTimeout(2000);
out(name+'_url',p.url());
for(const fr of p.frames()){out(name+'_frame',{url:fr.url(),text:(await fr.locator('body').innerText().catch(()=>'' )).slice(0,14000),links:await fr.locator('a').evaluateAll(es=>es.map(e=>({text:e.innerText,href:e.href})).filter(e=>/category|메뉴|카테고리/.test(e.href+e.text)).slice(0,80)),inputs:await fr.locator('input,select,button').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,name:e.name,type:e.type,value:e.type==='password'?'[hidden]':e.value,text:e.innerText})).slice(0,100))});}
const buf=await p.screenshot();out(name+'_shot',buf.toString('base64'));
}
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();