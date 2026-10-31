'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Scheduler,localTime}=require('./scheduler');const {Store}=require('./core');
function job(n) {
  const blocks=[];for(let i=0;i<6;i++){blocks.push({type:'image',file:'p'+i+'.png',alt:'도식'});blocks.push({type:'heading',runs:[{text:'FAQ 가상 사례 '+i,bold:true}]});blocks.push({type:'paragraph',runs:[{text:'가상 사례의 증빙과 거래 내용을 확인하고 상담 자료를 정리합니다. '.repeat(30)}]});}
  blocks.push({type:'paragraph',runs:[{text:'명함의 연락처로 상담 문의를 남겨주세요.'}]});return {id:String(n).padStart(3,'0')+'-test',title:'병원 상담 '+n,blog:'tlsehdduq0152',mode:'publish',blocks};
}
test('KST slots survive restart, skip 001–037 and publish at most four without catching up',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-schedule-'));let now=new Date('2026-10-31T22:59:00Z'),published=0;
  const jobs=new Store(path.join(dir,'jobs')),options={clock:()=>now,adapterFactory:()=>({prepare:async()=>{},verifyEditor:async()=>{},publish:async()=>{published++;},verifyPublished:async()=> 'https://blog.naver.com/tlsehdduq0152/'+(100+published),close:async()=>{}})};
  try {
    let s=new Scheduler(dir,jobs,options);s.configure({enabled:true,starts_at:'2026-10-31T23:00:00Z'});
    assert.throws(()=>s.ready(37,job(37)),/already_published/);for(let n=38;n<=42;n++)s.ready(n,job(n));
    assert.equal((await s.publishDue()).status,'NOT_STARTED');
    for(const [iso,n] of [['2026-10-31T23:00:00Z',38],['2026-11-01T03:00:00Z',39],['2026-11-01T07:00:00Z',40],['2026-11-01T09:00:00Z',41]]) {
      now=new Date(iso);const result=await s.publishDue();assert.equal(result.status,'PUBLISHED');assert.equal(result.content_id,n);
      s=new Scheduler(dir,jobs,options);s.recover();assert.equal((await s.publishDue()).status,'SLOT_ALREADY_RESERVED');
    }
    now=new Date('2026-11-01T09:45:00Z');assert.equal((await s.publishDue()).status,'OUTSIDE_SLOT');assert.equal(published,4);
    now=new Date('2026-11-01T23:00:00Z');assert.equal((await s.publishDue()).content_id,42);assert.equal(localTime(now).day,'2026-11-02');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('uncertain final click blocks subsequent numbers and never retries publication',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-uncertain-'));let now=new Date('2026-10-31T23:00:00Z'),clicks=0;
  try {
    const jobs=new Store(path.join(dir,'jobs'));const s=new Scheduler(dir,jobs,{clock:()=>now,adapterFactory:()=>({prepare:async()=>{},verifyEditor:async()=>{},publish:async()=>{clicks++;throw Error('connection_lost');},close:async()=>{}})});
    s.configure({enabled:true,starts_at:now.toISOString()});s.ready(38,job(38));s.ready(39,job(39));
    assert.equal((await s.publishDue()).status,'BLOCKED');assert.equal(jobs.get('038-test').status,'NEEDS_RECONCILIATION');
    now=new Date('2026-11-01T03:00:00Z');assert.equal((await s.publishDue()).status,'WAITING_FOR_RECONCILIATION');assert.equal(clicks,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('generation retries are bounded and malformed public legal appendices cannot enter the queue',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-generation-'));let calls=0;
  try {
    const s=new Scheduler(dir,new Store(path.join(dir,'jobs')),{clock:()=>new Date('2026-10-31T12:00:00Z'),generate:async()=>{calls++;throw Error('openai_429_credit_balance_exhausted');}});
    for(let n=0;n<5;n++)await s.fillOne();assert.equal(calls,3);assert.equal(s.state().items[0].content_id,38);
    const bad=job(38);bad.blocks.push({type:'paragraph',runs:[{text:'확인한 법령과 적용 기준'}]});assert.throws(()=>s.ready(38,bad),/legal_appendix/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
