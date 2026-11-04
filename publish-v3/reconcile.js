'use strict';
const {publishedURL,fingerprint,execute}=require('./core');

// Never replay an uncertain create. Verify the known post, optionally update only
// its tags, then commit both durable records. Existing slot reservations stay put.
async function reconcile(scheduler,{content_id,url,repair_tags=false}) {
  if(!Number.isInteger(content_id)||!publishedURL(url)||publishedURL(url)!==url)throw Error('invalid_reconciliation_target');
  let state=scheduler.state();
  const entry=state.items.find(i=>i.content_id===content_id);
  const article=scheduler.item(content_id);
  if(!entry||!article||!['BLOCKED','PUBLISHED'].includes(entry.status))throw Error('blocked_publication_required');
  const record=scheduler.jobs.get(entry.job_id);
  if(!record||record.hash!==fingerprint(article.job)||record.id!==article.job.id)throw Error('publication_identity_mismatch');
  if(!['NEEDS_RECONCILIATION','PUBLISHED'].includes(record.status))throw Error('uncertain_or_published_job_required');
  if(record.url&&record.url!==url)throw Error('published_target_changed');
  let verification;
  const inspect=async()=>{const adapter=scheduler.adapterFactory();try{return await adapter.inspectPublished(article.job,url);}finally{await adapter.close?.();}};
  try {verification=await inspect();}
  catch(error) {
    if(!repair_tags||!String(error.message).startsWith('published_tag_missing:'))throw error;
    // inspectPublished checks title, category, every text block, formatting and
    // image layout before tags. Only this specific final check permits repair.
    const repair={...article.job,id:article.job.id+'-tags-repair',action:'update',update_scope:'tags',target_url:url,expected_title:article.job.title};
    const previous=scheduler.jobs.get(repair.id);
    if(previous&&previous.status!=='PUBLISHED')throw Error('tag_repair_requires_reconciliation');
    await execute(scheduler.jobs,repair,scheduler.adapterFactory());
    verification=await inspect();
  }
  if(verification.url!==url)throw Error('reconciled_url_mismatch');
  record.status='PUBLISHED';record.url=url;record.verification=verification;
  record.reconciliation={previous_error:record.error||null,at:new Date(scheduler.clock()).toISOString(),method:'verified_existing_post'};
  delete record.error;record.updated_at=record.reconciliation.at;scheduler.jobs.put(record);
  state=scheduler.state();const current=state.items.find(i=>i.content_id===content_id);
  current.status='PUBLISHED';current.url=url;delete current.error;
  for(const slot of state.slots.filter(i=>i.job_id===record.id))slot.status='PUBLISHED';
  scheduler.save(state);
  return {status:'PUBLISHED',content_id,url,verification};
}
module.exports={reconcile};
