'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Store,publishedURL}=require('./core');
const SAFE=/^[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg)$/i;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function records(jobs,scheduler){
 const all=fs.readdirSync(jobs.dir).filter(f=>f.endsWith('.json')).map(f=>{const r=JSON.parse(fs.readFileSync(path.join(jobs.dir,f),'utf8'));if(!r.id||!r.status)throw Error('invalid_job_record');return r;});
 for(const i of scheduler.state().items){const a=scheduler.item(i.content_id);if(!a?.job)throw Error('scheduled_article_missing');all.push({...i,job:a.job,id:i.job_id});}
 return all;
}
function size(dir){let total=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())total+=size(f);else if(e.isFile())total+=fs.statSync(f).size;}return total;}
function inventory({dataDir,assets,jobs,scheduler}){
 const protectedFiles=new Set(['office_contact.jpeg']),eligible=new Map();
 for(const r of records(jobs,scheduler)){
  const published=r.status==='PUBLISHED'&&!!publishedURL(r.url);
  for(const b of r.job?.blocks||[]){if(b.type!=='image'||!SAFE.test(b.file||''))continue;
   if(!published||b.role==='footer')protectedFiles.add(b.file);
   else{if(!eligible.has(b.file))eligible.set(b.file,[]);eligible.get(b.file).push({job_id:r.id,url:r.url});}
  }
 }
 const files=[];for(const file of fs.readdirSync(assets)){if(!SAFE.test(file))continue;const full=path.join(assets,file),st=fs.lstatSync(full);if(!st.isFile()||st.isSymbolicLink())continue;
  files.push({file,bytes:st.size,sha256:hash(fs.readFileSync(full)),can_remove:eligible.has(file)&&!protectedFiles.has(file),publications:eligible.get(file)||[]});
 }
 const used=size(dataDir),stat=fs.statfsSync(dataDir),quota=500000000,reserve=25000000;
 return {checked_at:new Date().toISOString(),quota_bytes:quota,reserve_bytes:reserve,logical_used_bytes:used,free_usable_bytes:Math.max(0,Math.min(stat.bavail*stat.bsize,quota-used)-reserve),reclaimable_bytes:files.filter(f=>f.can_remove).reduce((n,f)=>n+f.bytes,0),files};
}
function cleanup(context,request){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(request.backup_receipt||'')||!Array.isArray(request.files)||!request.files.length||request.files.length>1000)throw Error('backup_manifest_required');
 const current=inventory(context),byName=new Map(current.files.map(f=>[f.file,f])),seen=new Set();
 const selected=request.files.map(f=>{const actual=byName.get(f.file);if(seen.has(f.file)||!actual?.can_remove)throw Error('asset_not_removable:'+f.file);seen.add(f.file);
  if(actual.sha256!==f.sha256||f.backup_sha256!==actual.sha256)throw Error('backup_hash_mismatch:'+f.file);
  const full=path.join(context.assets,f.file);if(path.dirname(fs.realpathSync(full))!==fs.realpathSync(context.assets))throw Error('asset_path_invalid');return actual;});
 const audit=new Store(path.join(context.dataDir,'maintenance')),id='cleanup-'+Date.now()+'-'+crypto.randomUUID(),record={id,status:'STARTED',backup_receipt:request.backup_receipt,files:selected,started_at:new Date().toISOString()};audit.put(record);
 let removed=0;try{for(const file of selected){fs.unlinkSync(path.join(context.assets,file.file));removed+=file.bytes;}record.status='COMPLETED';record.removed_bytes=removed;record.completed_at=new Date().toISOString();audit.put(record);}catch(e){record.status='INTERRUPTED';record.error=e.message;audit.put(record);throw e;}
 return {id,status:record.status,removed_files:selected.length,removed_bytes:removed,backup_receipt:request.backup_receipt,storage:inventory(context)};
}
module.exports={inventory,cleanup};