'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const path=require('node:path');
const {Store,validate,execute}=require('./core');
const {NaverAdapter}=require('./naver');
function start(env=process.env) {
  if(!env.DATA_DIR || !env.API_TOKEN || env.API_TOKEN.length<32 || !env.CDP_ENDPOINT) throw Error('DATA_DIR, API_TOKEN (32+ chars), CDP_ENDPOINT required');
  if(!path.isAbsolute(env.DATA_DIR)) throw Error('DATA_DIR_must_be_absolute_persistent_volume');
  const store=new Store(path.join(env.DATA_DIR,'jobs')); let busy=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8');
    const send=(code,data)=>{res.statusCode=code;res.end(JSON.stringify(data));};
    if(req.method==='GET' && req.url==='/health') return send(200,{ok:true,busy});
    const incoming=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+env.API_TOKEN);
    if(incoming.length!==expected.length || !crypto.timingSafeEqual(incoming,expected)) return send(401,{error:'unauthorized'});
    const match=req.url.match(/^\/jobs\/([a-zA-Z0-9_-]{1,80})$/);
    if(req.method==='GET' && match) { const job=store.get(match[1]); return send(job?200:404,job || {error:'not_found'}); }
    if(req.method!=='POST' || req.url!=='/jobs') return send(404,{error:'not_found'});
    if(busy) return send(409,{error:'worker_busy'});
    busy=true;
    try {
      let size=0, chunks=[];
      req.setTimeout(15000,()=>req.destroy());
      for await(const chunk of req) { size+=chunk.length; if(size>1024*1024) throw Error('payload_too_large'); chunks.push(chunk); }
      const job=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const old=store.get(job.id);
      if(old) {
        const {fingerprint}=require('./core');
        if(old.hash!==fingerprint(job)) return send(409,{error:'id_already_used_with_different_content'});
        return send(['PUBLISHED','DRAFT_SAVED'].includes(old.status)?200:409,old);
      }
      send(202,{id:job.id,status:'ACCEPTED',status_url:'/jobs/'+job.id});
      const {chromium}=require('playwright-core');
      await execute(store,job,new NaverAdapter({endpoint:env.CDP_ENDPOINT,assets:path.join(env.DATA_DIR,'assets'),chromium}));
    } catch(e) {
      if(!res.writableEnded) send(400,{error:String(e.message).slice(0,200)});
      else console.error(JSON.stringify({event:'job_failed',error:e.message}));
    } finally { busy=false; }
  });
  server.requestTimeout=20000;
  server.listen(Number(env.PORT || 3000)); return server;
}
if(require.main===module) start();
module.exports={start};
