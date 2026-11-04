'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store,fingerprint}=require('./core');const {Scheduler}=require('./scheduler');const {reconcile}=require('./reconcile');
const url='https://blog.naver.com/tlsehdduq0152/123456';
function fixture(factory){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-reconcile-'));
 const jobs=new Store(path.join(dir,'jobs')),s=new Scheduler(dir,jobs,{adapterFactory:factory});
 const job={id:'051-test',content_id:51,blog:'tlsehdduq0152',mode:'publish',title:'Existing post',tags:['tag'],blocks:[{type:'paragraph',runs:[{text:'Original unchanged body'}]}]};
 s.db.put({id:'article-051',job});s.save({...s.state(),items:[{content_id:51,job_id:job.id,status:'BLOCKED'}],slots:[{key:'2026-11-04T12',job_id:job.id,status:'BLOCKED'}]});
 jobs.put({id:job.id,job,hash:fingerprint(job),status:'NEEDS_RECONCILIATION',error:'published_tag_missing:tag'});
 return {s,jobs,job,dispose:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('reconcile an already published post without a new publish; retain slot and original fingerprint',async()=>{
 let clicks=0;const f=fixture(()=>({inspectPublished:async()=>({url}),publish:async()=>{clicks++;}}));
 try{await reconcile(f.s,{content_id:51,url});assert.equal(clicks,0);assert.equal(f.jobs.get(f.job.id).status,'PUBLISHED');assert.equal(f.jobs.get(f.job.id).hash,fingerprint(f.job));assert.equal(f.s.state().slots.length,1);assert.equal(f.s.state().slots[0].status,'PUBLISHED');await reconcile(f.s,{content_id:51,url});assert.equal(clicks,0);}
 finally{f.dispose();}
});
test('only tag verification failure permits an update of the existing post; verify again after repair',async()=>{
 let fixed=false,clicks=0,checks=0;const f=fixture(()=>({inspectPublished:async()=>{checks++;if(!fixed)throw Error('published_tag_missing:tag');return {url};},prepare:async job=>{assert.equal(job.action,'update');assert.equal(job.update_scope,'tags');assert.equal(job.target_url,url);assert.deepEqual(job.blocks,f.job.blocks);},verifyEditor:async()=>{},publish:async()=>{clicks++;fixed=true;},verifyPublished:async()=>url}));
 try{await reconcile(f.s,{content_id:51,url,repair_tags:true});assert.equal(clicks,1);assert.equal(checks,2);assert.equal(f.s.state().items[0].status,'PUBLISHED');}
 finally{f.dispose();}
});
test('body mismatch, hostile URL, changed identity and uncertain repair keep the publication blocked',async()=>{
 let clicks=0;const f=fixture(()=>({inspectPublished:async()=>{throw Error('content_missing_or_out_of_order');},publish:async()=>{clicks++;}}));
 try{await assert.rejects(reconcile(f.s,{content_id:51,url,repair_tags:true}),/content_missing/);await assert.rejects(reconcile(f.s,{content_id:51,url:'https://example.com/x',repair_tags:true}),/invalid/);assert.equal(clicks,0);assert.equal(f.s.state().items[0].status,'BLOCKED');
 f.s.adapterFactory=()=>({inspectPublished:async()=>{throw Error('published_tag_missing:tag');}});f.jobs.put({id:'051-test-tags-repair',status:'NEEDS_RECONCILIATION'});await assert.rejects(reconcile(f.s,{content_id:51,url,repair_tags:true}),/tag_repair_requires/);
 const r=f.jobs.get(f.job.id);r.hash='changed';f.jobs.put(r);await assert.rejects(reconcile(f.s,{content_id:51,url}),/identity/);
 }finally{f.dispose();}
});
