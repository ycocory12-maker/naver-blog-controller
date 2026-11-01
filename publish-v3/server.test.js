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
test('production profile adds topic category and footer and blocks thin jobs before browser input',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-profile-'));let received;
  const server=start({DATA_DIR:dir,API_TOKEN:'b'.repeat(40),CDP_ENDPOINT:'unused',PORT:'0',CONTENT_PROFILE:'v89'},{host:'127.0.0.1',adapterFactory:()=>({prepare:async job=>{received=job;},verifyEditor:async()=>{},publish:async()=>{},verifyPublished:async()=> 'https://blog.naver.com/tlsehdduq0152/456',close:async()=>{}})});
  await once(server,'listening');const url='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer '+'b'.repeat(40)};
  try {
    const base={id:'thin',blog:'tlsehdduq0152',mode:'publish',title:'병원 개원 세무',blocks:[{type:'paragraph',runs:[{text:'짧은 원고'}]}]};
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(base)})).status,400);assert.equal(received,undefined);
    const blocks=[];for(let i=0;i<6;i++){blocks.push({type:'image',file:'picture'+i+'.png',alt:'설명'});blocks.push({type:'heading',runs:[{text:'FAQ 가상 사례 '+i,bold:true}]});blocks.push({type:'paragraph',runs:[{text:'가상 사례의 지출 내용과 증빙을 검토하고 질문에 답합니다. '.repeat(40)}]});}
    const payload={...base,id:'full',blocks};
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(payload)})).status,202);
    assert.equal(received.category,'병·의원');assert.equal(received.category_no,11);assert.equal(received.blocks.at(-1).file,'office_contact.jpeg');assert.equal(received.blocks.filter(b=>b.type==='image').length,7);
    for(let i=0;i<100;i++){const r=await(await fetch(url+'/jobs/full',{headers})).json();if(r.status==='PUBLISHED')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal((await fetch(url+'/jobs',{method:'POST',headers,body:JSON.stringify(payload)})).status,200);
  }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
