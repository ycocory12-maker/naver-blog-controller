'use strict';
const http=require('node:http');
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const {Store,validate,execute}=require('./core');
const {NaverAdapter}=require('./naver');
function start(env=process.env,options={}) {
  if(!env.DATA_DIR || !env.API_TOKEN || env.API_TOKEN.length<32 || !env.CDP_ENDPOINT) throw Error('DATA_DIR, API_TOKEN (32+ chars), CDP_ENDPOINT required');
  if(!path.isAbsolute(env.DATA_DIR)) throw Error('DATA_DIR_must_be_absolute_persistent_volume');
  const store=new Store(path.join(env.DATA_DIR,'jobs')); let busy=false;
  const assets=path.join(env.DATA_DIR,'assets');fs.mkdirSync(assets,{recursive:true});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8');
    const send=(code,data)=>{res.statusCode=code;res.end(JSON.stringify(data));};
    res.setHeader('cache-control','no-store');
    if(req.method==='GET' && req.url==='/health') return send(200,{ok:true,busy,version:'3.1.0'});
    const incoming=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+env.API_TOKEN);
    if(incoming.length!==expected.length || !crypto.timingSafeEqual(incoming,expected)) return send(401,{error:'unauthorized'});
    const asset=req.url.match(/^\/assets\/([a-zA-Z0-9_-]+\.png)$/);
    if(req.method==='PUT' && asset) {
      if(busy) return send(409,{error:'worker_busy'});
      try {
        let size=0,chunks=[];req.setTimeout(15000,()=>req.destroy());
        for await(const c of req) {size+=c.length;if(size>15*1024*1024) throw Error('payload_too_large');chunks.push(c);}
        const buffer=Buffer.concat(chunks);
        if(buffer.length<24 || !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii',12,16)!=='IHDR') return send(400,{error:'invalid_png'});
        const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
        if(!width || !height || width>8192 || height>8192) return send(400,{error:'invalid_dimensions'});
        const file=path.join(assets,asset[1]),hash=crypto.createHash('sha256').update(buffer).digest('hex');
        if(fs.existsSync(file)) {
          if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash) return send(409,{error:'asset_name_already_used'});
        } else {
          const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,buffer);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        }
        return send(200,{file:asset[1],sha256:hash,width,height});
      } catch(e) {return send(400,{error:e.message});}
    }
    const match=req.url.match(/^\/jobs\/([a-zA-Z0-9_-]{1,80})$/);
    if(req.method==='GET' && match) { const job=store.get(match[1]); return send(job?200:404,job || {error:'not_found'}); }
    const retry=req.url.match(/^\/jobs\/([a-zA-Z0-9_-]{1,80})\/retry$/);
    if(req.method!=='POST' || (req.url!=='/jobs' && !retry)) return send(404,{error:'not_found'});
    if(busy) return send(409,{error:'worker_busy'});
    busy=true;
    try {
      let size=0, chunks=[];
      req.setTimeout(15000,()=>req.destroy());
      for await(const chunk of req) { size+=chunk.length; if(size>1024*1024) throw Error('payload_too_large'); chunks.push(chunk); }
      const previous=retry?store.get(retry[1]):null;
      if(retry && previous?.status!=='FAILED') return send(409,{error:'only_pre_publish_failed_jobs_can_retry'});
      const job=validate(retry?previous.job:JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const old=store.get(job.id);
      if(old && !retry) {
        const {fingerprint}=require('./core');
        if(old.hash!==fingerprint(job)) return send(409,{error:'id_already_used_with_different_content'});
        return send(['PUBLISHED','DRAFT_SAVED'].includes(old.status)?200:409,old);
      }
      store.put({id:job.id,hash:require('./core').fingerprint(job),job,status:'QUEUED',updated_at:new Date().toISOString()});
      const adapter=options.adapterFactory ? options.adapterFactory() : new NaverAdapter({endpoint:env.CDP_ENDPOINT,assets,chromium:require('playwright-core').chromium});
      send(202,{id:job.id,status:'ACCEPTED',status_url:'/jobs/'+job.id});
      await execute(store,job,adapter);
    } catch(e) {
      if(!res.writableEnded) send(400,{error:String(e.message).slice(0,200)});
      else console.error(JSON.stringify({event:'job_failed',error:e.message}));
    } finally { busy=false; }
  });
  server.requestTimeout=20000;
  server.listen(Number(env.PORT ?? 3000),options.host); return server;
}
if(require.main===module) start();
module.exports={start};
