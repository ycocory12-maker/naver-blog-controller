'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events');const {start}=require('./server');
test('HTTP authentication, PNG uploads, durable acceptance and duplicate protection',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-api-'));let publishCount=0,release;
  const gate=new Promise(r=>release=r);
  const server=start({DATA_DIR:dir,API_TOKEN:'a'.repeat(40),CDP_ENDPOINT:'unused',PORT:'0'},{host:'127.0.0.1',adapterFactory:()=>({prepare:async()=>gate,verifyEditor:async()=>{},publish:async()=>{publishCount++;},verifyPublished:async()=> 'https://blog.naver.com/tlsehdduq0152/123',close:async()=>{}})});
  await once(server,'listening');const url='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer '+'a'.repeat(40)};
  try {
    assert.equal((await fetch(url+'/health')).status,200);
    assert.equal((await fetch(url+'/jobs/001')).status,401);
    assert.equal((await fetch(url+'/jobs/001',{headers})).status,404);
    assert.equal((await fetch(url+'/assets/x.png',{method:'PUT',headers,body:'not an image'})).status,400);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=','base64');
    const uploaded=await fetch(url+'/assets/x.png',{method:'PUT',headers,body:png});assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).width,1);
    const changed=Buffer.from(png);changed[changed.length-1]^=1;
    assert.equal((await fetch(url+'/assets/x.png',{method:'PUT',headers,body:changed})).status,409);
    const job={id:'001',blog:'tlsehdduq0152',mode:'publish',title:'테스트',blocks:[{type:'paragraph',runs:[{text:'원고'}]}]};
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(job)})).status,202);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'jobs/001.json'))).status,'EDITING');
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify({...job,id:'002'})})).status,409);
    release();let state;
    for(let i=0;i<100;i++){state=await (await fetch(url+'/jobs/001',{headers})).json();if(state.status==='PUBLISHED')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(state.status,'PUBLISHED');assert.equal(publishCount,1);
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(job)})).status,200);
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify({...job,title:'수정'})})).status,409);
    assert.equal(publishCount,1);
    const {Store,fingerprint}=require('./core');const store=new Store(path.join(dir,'jobs'));
    const failed={...job,id:'failed'};
    store.put({id:failed.id,job:failed,hash:fingerprint(failed),status:'FAILED'});
    assert.equal((await fetch(url+'/jobs/failed/retry',{method:'POST',headers})).status,202);
    for(let i=0;i<100;i++){const result=store.get('failed');if(result.status==='PUBLISHED')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(store.get('failed').status,'PUBLISHED');assert.equal(publishCount,2);
    const uncertain={...job,id:'uncertain'};
    store.put({id:uncertain.id,job:uncertain,hash:fingerprint(uncertain),status:'NEEDS_RECONCILIATION'});
    assert.equal((await fetch(url+'/jobs/uncertain/retry',{method:'POST',headers})).status,409);
    assert.equal(publishCount,2);
  } finally {release();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
