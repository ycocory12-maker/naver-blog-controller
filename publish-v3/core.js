'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BLOG = 'tlsehdduq0152';
const escape = x => String(x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function validate(job) {
  if (!job || !/^[a-zA-Z0-9_-]{1,80}$/.test(job.id || '')) throw Error('invalid_id');
  if (job.blog !== BLOG || job.mode !== 'publish') throw Error('invalid_destination_or_mode');
  if (typeof job.title !== 'string' || !job.title.trim() || job.title.length > 100) throw Error('invalid_title');
  if (!Array.isArray(job.blocks) || !job.blocks.length || job.blocks.length > 100) throw Error('invalid_blocks');
  for (const b of job.blocks) {
    if (!b || !['paragraph','heading','table','image'].includes(b.type)) throw Error('unsupported_block');
    if (b.type === 'image') {
      if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg)$/i.test(b.file || '') || typeof b.alt !== 'string') throw Error('invalid_image');
    } else if (b.type === 'table') {
      if (!Array.isArray(b.rows) || b.rows.length < 2 || b.rows.length > 30 || !Array.isArray(b.rows[0]) || ![2,3].includes(b.rows[0].length)) throw Error('invalid_table');
      if (b.rows.some(r => !Array.isArray(r) || r.length !== b.rows[0].length || r.some(c => typeof c !== 'string' || !c.trim()))) throw Error('invalid_table_cells');
    } else {
      if (!Array.isArray(b.runs) || !b.runs.length || b.runs.some(r => typeof r.text !== 'string' || !r.text.trim() || r.text.length > 10000)) throw Error('invalid_runs');
      for(const r of b.runs) if(r.href) { const u=new URL(r.href); if(u.protocol!=='https:' || u.username || u.password) throw Error('invalid_link'); }
    }
  }
  if (job.tags && (!Array.isArray(job.tags) || job.tags.length > 30 || job.tags.some(t => typeof t !== 'string' || !/^[가-힣a-zA-Z0-9_]{1,30}$/.test(t)))) throw Error('invalid_tags');
  if(job.action && !['create','update'].includes(job.action))throw Error('invalid_action');
  if(job.update_scope && (job.update_scope!=='tags'||job.action!=='update'||!job.tags?.length))throw Error('invalid_update_scope');
  if(job.action==='update' && (!publishedURL(job.target_url) || publishedURL(job.target_url)!==job.target_url || typeof job.expected_title!=='string' || !job.expected_title.trim()))throw Error('verified_update_target_required');
  require('./content-policy').validateQuality(job);
  return job;
}
function renderBlock(b) {
  if (b.type === 'image') throw Error('image_requires_native_upload');
  if (b.type === 'table') return '<table style="border-collapse:collapse;width:100%;font-size:16px"><tbody>' + b.rows.map((r,i) => '<tr>' + r.map(c => `<${i?'td':'th'} style="border:1px solid #aaa;padding:10px;font-weight:${i?'400':'700'};background-color:${i?'#ffffff':'#e6f1dd'};">${escape(c)}</${i?'td':'th'}>`).join('') + '</tr>').join('') + '</tbody></table>';
  const text = b.runs.map(r => {const span=`<span style="font-size:${b.type==='heading'?'24':'16'}px;color:#202020;font-weight:${r.bold?'700':'400'};background-color:${r.highlight?'#fff59d':'#ffffff'};">${escape(r.text)}</span>`;return r.href?`<a href="${escape(r.href)}">${span}</a>`:span;}).join('');
  return b.type === 'heading' ? `<h2>${text}</h2>` : `<p>${text}</p>`;
}
function fingerprint(job) { return crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex'); }
function publishedURL(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['blog.naver.com','m.blog.naver.com'].includes(u.hostname)) return null;
    let id;
    const m = u.pathname.match(new RegExp(`^/${BLOG}/(\\d+)$`));
    if (m) id = m[1];
    if (/^\/PostView\.naver$/.test(u.pathname) && u.searchParams.get('blogId') === BLOG) id = u.searchParams.get('logNo');
    return /^\d+$/.test(id || '') ? `https://blog.naver.com/${BLOG}/${id}` : null;
  } catch { return null; }
}
class Store {
  constructor(dir) { this.dir = path.resolve(dir); fs.mkdirSync(this.dir,{recursive:true}); }
  file(id) { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw Error('invalid_id'); return path.join(this.dir,id+'.json'); }
  get(id) { try { return JSON.parse(fs.readFileSync(this.file(id),'utf8')); } catch(e) { if(e.code==='ENOENT') return null; throw e; } }
  put(record) {
    const file = this.file(record.id), tmp = file+'.'+crypto.randomUUID()+'.tmp';
    const fd = fs.openSync(tmp,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify(record,null,2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp,file);
    const d = fs.openSync(this.dir,'r'); try { fs.fsyncSync(d); } catch(e) { if(process.platform!=='win32') throw e; } finally { fs.closeSync(d); }
  }
  lock() { const p = path.join(this.dir,'.worker-lock'); const fd=fs.openSync(p,'wx',0o600); fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()})); fs.closeSync(fd); return ()=>fs.unlinkSync(p); }
}
async function execute(store, job, adapter) {
  validate(job);
  const unlock = store.lock();
  let record;
  try {
    const hash = fingerprint(job), old = store.get(job.id);
    if (old) {
      if (old.hash !== hash) throw Error('id_already_used_with_different_content');
      if (['PUBLISHED','DRAFT_SAVED'].includes(old.status)) return old;
      // Editing may have persisted a partial draft; uncertain publish may already be live.
      if(old.status !== 'QUEUED') throw Error('existing_job_requires_reconciliation');
    }
    record = {id:job.id,hash,job,status:'EDITING',updated_at:new Date().toISOString()};
    store.put(record);
    adapter.progress = step => {record.step=step;record.updated_at=new Date().toISOString();store.put(record);};
    const save = status => { record.status=status; record.updated_at=new Date().toISOString(); store.put(record); };
    await adapter.prepare(job);
    await adapter.verifyEditor(job);
    if (job.mode === 'draft') { await adapter.saveDraft(job); save('DRAFT_SAVED'); return record; }
    await adapter.preparePublication?.(job);
    // Persist BEFORE the click. A crash from this point must never trigger another publish.
    save('PUBLISHING');
    await adapter.publish(job);
    save('VERIFYING');
    const url = publishedURL(await adapter.verifyPublished(job));
    if (!url) throw Error('published_url_not_verified');
    if(job.action==='update' && url!==job.target_url)throw Error('updated_post_id_changed');
    record.url=url; save('PUBLISHED');
    return record;
  } catch(e) {
    if(record) { record.status=['PUBLISHING','VERIFYING'].includes(record.status)?'NEEDS_RECONCILIATION':'FAILED'; record.updated_at=new Date().toISOString();record.error=String(e.message).slice(0,500); if(adapter.diagnostics) record.diagnostics=await adapter.diagnostics().catch(()=>({unavailable:true})); store.put(record); }
    throw e;
  } finally { try { await adapter.close?.(); } finally { unlock(); } }
}
module.exports={BLOG,escape,validate,renderBlock,fingerprint,publishedURL,Store,execute};
