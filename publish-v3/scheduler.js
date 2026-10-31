'use strict';
const path=require('node:path');
const {Store,validate,execute}=require('./core');
const {enrich}=require('./content-policy');
const HOURS=[8,12,16,18];
function localTime(now) {
  const d=new Date(new Date(now).getTime()+9*3600000);
  return {day:d.toISOString().slice(0,10),hour:d.getUTCHours(),minute:d.getUTCMinutes()};
}
class Scheduler {
  constructor(dir,jobs,{generate,adapterFactory,clock=()=>new Date()}={}) {
    this.db=new Store(path.join(dir,'schedule'));this.jobs=jobs;this.generate=generate;this.adapterFactory=adapterFactory;this.clock=clock;
    if(!this.db.get('state'))this.save({id:'state',enabled:false,timezone:'Asia/Seoul',hours:HOURS,completed_through:37,starts_at:null,items:[],slots:[]});
  }
  state(){return this.db.get('state');}
  save(s){s.updated_at=new Date(this.clock()).toISOString();this.db.put(s);return s;}
  configure({enabled,starts_at}) {
    if(typeof enabled!=='boolean' || !Number.isFinite(Date.parse(starts_at)))throw Error('invalid_schedule_config');
    const s=this.state();s.enabled=enabled;s.starts_at=new Date(starts_at).toISOString();return this.save(s);
  }
  summary() {
    const s=this.state();return {...s,items:s.items.map(({content_id,job_id,title,status,url,error,generated_at})=>({content_id,job_id,title,status,url,error,generated_at})),generation_connected:!!this.generate};
  }
  item(id){return this.db.get('article-'+String(id).padStart(3,'0'));}
  ready(contentId,job,audit={}) {
    const s=this.state();if(!Number.isInteger(contentId)||contentId<=s.completed_through)throw Error('already_published_content_number');
    job=validate(enrich(job,'v89'));require('./marketing').validateMarketing(job);
    if(job.action && job.action!=='create')throw Error('scheduled_jobs_must_create');
    if(!job.id.startsWith(String(contentId).padStart(3,'0')+'-'))throw Error('content_number_mismatch');
    if(s.items.some(i=>i.content_id===contentId && i.status!=='GENERATION_FAILED'))throw Error('content_number_already_reserved');
    const record={id:'article-'+String(contentId).padStart(3,'0'),content_id:contentId,job,audit,generated_at:new Date(this.clock()).toISOString()};this.db.put(record);
    s.items=s.items.filter(i=>i.content_id!==contentId);s.items.push({content_id:contentId,job_id:job.id,title:job.title,status:'READY',generated_at:record.generated_at});s.items.sort((a,b)=>a.content_id-b.content_id);this.save(s);return record;
  }
  async fillOne() {
    let s=this.state();if(!this.generate)return {status:'GENERATION_NOT_CONNECTED'};
    if(s.items.some(i=>['GENERATING','RUNNING','BLOCKED'].includes(i.status)))return {status:'WAITING_FOR_RECONCILIATION'};
    if(s.items.filter(i=>i.status==='READY').length>=4)return {status:'QUEUE_FULL'};
    const failed=s.items.find(i=>i.status==='GENERATION_FAILED');
    const contentId=failed?.content_id || Math.max(s.completed_through,...s.items.map(i=>i.content_id))+1;
    const day=localTime(this.clock()).day;
    if(failed?.attempt_day===day && failed.attempts>=3)return {status:'GENERATION_RETRY_LIMIT',content_id:contentId};
    const entry=failed || {content_id:contentId};entry.status='GENERATING';entry.attempts=entry.attempt_day===day?(entry.attempts||0)+1:1;entry.attempt_day=day;delete entry.error;
    if(!failed)s.items.push(entry);this.save(s);
    try {
      const result=await this.generate(contentId,s.items.filter(i=>i.title).map(i=>i.title));
      // The durable article is written before it becomes eligible for publishing.
      s=this.state();const current=s.items.find(i=>i.content_id===contentId);current.status='GENERATION_FAILED';this.save(s);
      this.ready(contentId,result.job,result.audit);return {status:'READY',content_id:contentId,title:result.job.title};
    } catch(e) {s=this.state();const current=s.items.find(i=>i.content_id===contentId);current.status='GENERATION_FAILED';current.error=String(e.message).slice(0,240);this.save(s);return {status:'GENERATION_FAILED',content_id:contentId,error:current.error};}
  }
  recover() {
    const s=this.state();let changed=false;
    for(const i of s.items) {
      if(i.status==='GENERATING'){i.status='GENERATION_FAILED';i.error='interrupted_generation';changed=true;}
      if(i.status==='RUNNING') {
        const j=this.jobs.get(i.job_id),slot=s.slots.find(x=>x.job_id===i.job_id);
        if(j?.status==='PUBLISHED'){i.status='PUBLISHED';i.url=j.url;if(slot)slot.status='PUBLISHED';}
        else {i.status='BLOCKED';i.error='interrupted_publication_requires_reconciliation';if(slot)slot.status='BLOCKED';}changed=true;
      }
    }
    if(changed)this.save(s);
  }
  async publishDue() {
    const now=this.clock(),t=localTime(now);let s=this.state();
    if(!s.enabled)return {status:'DISABLED'};
    if(new Date(now)<new Date(s.starts_at))return {status:'NOT_STARTED'};
    if(!HOURS.includes(t.hour)||t.minute>20)return {status:'OUTSIDE_SLOT'};
    const key=t.day+'T'+String(t.hour).padStart(2,'0');
    if(s.slots.some(x=>x.key===key))return {status:'SLOT_ALREADY_RESERVED'};
    if(s.slots.filter(x=>x.day===t.day).length>=4)return {status:'DAILY_LIMIT'};
    const next=s.items.filter(i=>i.status!=='PUBLISHED').sort((a,b)=>a.content_id-b.content_id)[0];
    if(!next||next.status!=='READY')return {status:next?'WAITING_FOR_RECONCILIATION':'NO_READY_ARTICLE'};
    if(next.content_id!==s.completed_through+1+s.items.filter(i=>i.status==='PUBLISHED').length)return {status:'MISSING_PREVIOUS_CONTENT_NUMBER'};
    const article=this.item(next.content_id);if(!article)throw Error('queued_article_missing');
    // Reserve the slot before any browser input. An uncertain result never reuses it.
    next.status='RUNNING';s.slots.push({key,day:t.day,job_id:next.job_id,content_id:next.content_id,status:'RUNNING',at:new Date(now).toISOString()});this.save(s);
    try {
      const result=await execute(this.jobs,article.job,this.adapterFactory());
      s=this.state();const entry=s.items.find(i=>i.content_id===next.content_id),slot=s.slots.find(x=>x.key===key);
      entry.status=result.status==='PUBLISHED'?'PUBLISHED':'BLOCKED';entry.url=result.url;slot.status=entry.status;this.save(s);
      return {status:entry.status,content_id:entry.content_id,url:entry.url};
    } catch(e) {s=this.state();s.items.find(i=>i.content_id===next.content_id).status='BLOCKED';s.items.find(i=>i.content_id===next.content_id).error=String(e.message).slice(0,240);s.slots.find(x=>x.key===key).status='BLOCKED';this.save(s);return {status:'BLOCKED',content_id:next.content_id,error:String(e.message).slice(0,240)};}
  }
}
module.exports={Scheduler,localTime,HOURS};
