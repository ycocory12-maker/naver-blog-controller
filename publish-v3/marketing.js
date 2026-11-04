'use strict';
function validateMarketing(job) {
  const text=job.blocks.flatMap(b=>b.runs?.map(r=>r.text) || b.rows?.flat() || []).join('\n');
  if(/확인한\s*법령|법령과\s*적용\s*기준|^\s*(참고\s*법령|관련\s*법령|출처\s*모음)/m.test(text))throw Error('public_legal_appendix_forbidden');
  if(!job.blocks.some(b=>b.type==='paragraph'&&b.runs.some(r=>/상담/.test(r.text))))throw Error('consultation_call_to_action_required');
  const lastText=[...job.blocks].reverse().find(b=>b.type==='paragraph');
  if(!lastText || !lastText.runs.some(r=>/상담|문의|연락/.test(r.text)))throw Error('consultation_close_required');
  if(/무조건\s*절세|100%\s*(절세|비과세|환급)|반드시\s*환급|세무조사\s*없/.test(text))throw Error('unsupported_marketing_guarantee');
}
module.exports={validateMarketing};
