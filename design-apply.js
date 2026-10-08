const http=require('http');const {chromium}=require('playwright-core');
const out=(k,v)=>console.log(k+'='+JSON.stringify(v));
(async()=>{let b,p;try{
const v=await new Promise((resolve,reject)=>{http.get({hostname:'naver-chromium.railway.internal',port:9222,path:'/json/version',headers:{Host:'localhost:9222'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s)))}).on('error',reject)});
b=await chromium.connectOverCDP('ws://naver-chromium.railway.internal:9222'+new URL(v.webSocketDebuggerUrl).pathname,{headers:{Host:'localhost:9222'}});
p=await b.contexts()[0].newPage();await p.setViewportSize({width:1440,height:1000});

await p.setViewportSize({width:390,height:844});
await p.goto('https://m.blog.naver.com/tlsehdduq0152',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1800);
await p.getByRole('button',{name:'카테고리 이동',exact:true}).evaluate(e=>e.click());await p.waitForTimeout(1000);
out('mobile_category',{url:p.url(),text:(await p.locator('body').innerText()).slice(0,2000),links:await p.locator('a,button').evaluateAll(es=>es.map(e=>({tag:e.tagName,text:e.innerText,href:e.getAttribute('href')})).filter(x=>/^(CTA|사업자|병·의원|법인|양도·상속·증여)/.test(x.text)).slice(0,15))});
const s=(await p.screenshot({type:'jpeg',quality:75})).toString('base64');for(let i=0;i<s.length;i+=30000)out('verified_mobile_menu_shot_'+i,s.slice(i,i+30000));out('mobile_verification_done',true);
}catch(e){out('error',e.message)}finally{if(p)await p.close();if(b)await b.close()}})();