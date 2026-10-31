'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {validate,renderBlock,publishedURL,Store,execute}=require('./core');
const job=()=>({id:'topic-001',blog:'tlsehdduq0152',mode:'publish',title:'테스트',blocks:[{type:'paragraph',runs:[{text:'핵심 내용',bold:true,highlight:true}]}]});
const setup=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-test-'));return {store:new Store(dir),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};};
const adapter=(overrides={})=>({prepare:async()=>{},verifyEditor:async()=>{},publish:async()=>{},verifyPublished:async()=> 'https://blog.naver.com/tlsehdduq0152/12345',close:async()=>{},...overrides});
test('reject another blog and image path traversal',()=>{
  assert.throws(()=>validate({...job(),blog:'other'}));
  assert.throws(()=>validate({...job(),blocks:[{type:'image',file:'../secret.png',alt:'x'}]}));
});
test('escape content and render emphasis/table markup',()=>{
  const h=renderBlock({type:'paragraph',runs:[{text:'<script>&',bold:true,highlight:true}]});
  assert.ok(h.includes('&lt;script&gt;&amp;'));assert.ok(h.includes('font-weight:700'));assert.ok(h.includes('background-color:#fff59d'));
  assert.ok(renderBlock({type:'table',rows:[['구분','내용'],['A','B']]}).includes('<th'));
});
test('canonical URL only from target blog, never write pages or hostile hosts',()=>{
  assert.equal(publishedURL('https://blog.naver.com/tlsehdduq0152/12345'),'https://blog.naver.com/tlsehdduq0152/12345');
  assert.equal(publishedURL('https://blog.naver.com/PostView.naver?blogId=tlsehdduq0152&logNo=123'),'https://blog.naver.com/tlsehdduq0152/123');
  for(const u of ['https://blog.naver.com/other/123','https://blog.naver.com.evil.test/tlsehdduq0152/123','https://blog.naver.com/tlsehdduq0152?Redirect=Write','http://blog.naver.com/tlsehdduq0152/123']) assert.equal(publishedURL(u),null);
});
test('publish once; persisted retry returns same URL without publishing',async()=>{
  const {store,cleanup}=setup();let count=0;
  try {const a=adapter({publish:async()=>{count++;assert.equal(store.get('topic-001').status,'PUBLISHING');}});await execute(store,job(),a);const r=await execute(new Store(store.dir),job(),a);assert.equal(r.status,'PUBLISHED');assert.equal(count,1);} finally {cleanup();}
});
test('formatting failure prevents publish',async()=>{
  const {store,cleanup}=setup();let count=0;
  try {await assert.rejects(execute(store,job(),adapter({verifyEditor:async()=>{throw Error('highlight_not_preserved');},publish:async()=>count++})));assert.equal(count,0);assert.equal(store.get('topic-001').status,'FAILED');} finally {cleanup();}
});
test('uncertain final click persists reconciliation and blocks retry',async()=>{
  const {store,cleanup}=setup();let count=0;
  try {const a=adapter({publish:async()=>{count++;throw Error('connection_lost');}});await assert.rejects(execute(store,job(),a));assert.equal(store.get('topic-001').status,'NEEDS_RECONCILIATION');await assert.rejects(execute(store,job(),a),/reconciliation/);assert.equal(count,1);} finally {cleanup();}
});
test('post verification failure cannot report success',async()=>{
  const {store,cleanup}=setup();try {await assert.rejects(execute(store,job(),adapter({verifyPublished:async()=>null})));assert.equal(store.get('topic-001').status,'NEEDS_RECONCILIATION');} finally {cleanup();}
});
test('publication settings failure happens before the irreversible click boundary',async()=>{
  const {store,cleanup}=setup();let clicked=false;
  try {await assert.rejects(execute(store,job(),adapter({preparePublication:async()=>{throw Error('public_visibility_not_verified');},publish:async()=>{clicked=true;}})));assert.equal(clicked,false);assert.equal(store.get(job().id).status,'FAILED');}finally{cleanup();}
});
test('same id with changed body is rejected without overwriting record',async()=>{
  const {store,cleanup}=setup();try {await execute(store,job(),adapter());await assert.rejects(execute(store,{...job(),title:'수정'},adapter()),/different_content/);assert.equal(store.get('topic-001').job.title,'테스트');} finally {cleanup();}
});
test('crash marker and worker lock block automatic replay',async()=>{
  const {store,cleanup}=setup();try {const unlock=store.lock();await assert.rejects(execute(store,job(),adapter()));unlock();store.put({id:job().id,hash:require('./core').fingerprint(job()),status:'PUBLISHING'});await assert.rejects(execute(store,job(),adapter()),/reconciliation/);assert.equal(store.get(job().id).status,'PUBLISHING');} finally {cleanup();}
});
test('concurrent attempts cannot enter editor twice',async()=>{
  const {store,cleanup}=setup();let release; const gate=new Promise(r=>release=r);let prepared=0;
  try {const pending=execute(store,job(),adapter({prepare:async()=>{prepared++;await gate;}}));await assert.rejects(execute(store,{...job(),id:'second'},adapter()));release();await pending;assert.equal(prepared,1);} finally {cleanup();}
});
