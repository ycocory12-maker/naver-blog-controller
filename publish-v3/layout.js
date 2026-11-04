'use strict';
const norm=s=>s.replace(/[\s\u200b\ufeff]/g,'');
function verifyLayout(job,units) {
  const meaningful=units.filter(u=>u.type==='image' || norm(u.text || ''));
  if(meaningful.at(-1)?.type!=='image')throw Error('business_card_is_not_last');
  const ratio=meaningful.at(-1).ratio;
  if(!ratio || Math.abs(ratio-1179/604)>.04)throw Error('business_card_dimensions_mismatch');
  const actual=meaningful.map(u=>u.type==='image'?'⟦IMAGE⟧':norm(u.text)).join('');let offset=0;
  for(const b of job.blocks) {
    const texts=b.type==='image'?['⟦IMAGE⟧']:b.rows?b.rows.flat():b.runs.map(r=>r.text);
    for(const t of texts) {
      const wanted=norm(t),at=actual.indexOf(wanted,offset);
      if(at<0 || actual.slice(offset,at).includes('⟦IMAGE⟧'))throw Error('image_text_order_mismatch');
      offset=at+wanted.length;
    }
  }
}
module.exports={verifyLayout};
