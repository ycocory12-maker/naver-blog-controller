'use strict';
const routes=[
  {name:'양도·상속·증여',number:13,test:/양도|상속|증여|차용증|주택자금|부모.*자녀/},
  {name:'병·의원',number:11,test:/병[·ㆍ]?의원|병원|의원|개원|의료|치과|한의원/},
  {name:'법인',number:12,test:/법인|임원퇴직|가지급금|인정이자/},
  {name:'사업자',number:10,test:/사업자|쇼핑몰|스마트스토어|쿠팡|변호사|법률사무소|프리랜서|유튜버|크리에이터|인터넷방송|애드센스|협찬|원천징수/}
];
function categoryFor(job) {
  const topic=[job.industry || '',job.topic || '',job.title || ''].join(' ');
  return routes.find(r=>r.test.test(topic)) || {name:'세무사',number:8};
}
function enrich(job, profile) {
  if((job.profile || profile)!=='v89')return job;
  const copy={...job,profile:'v89',blocks:job.blocks.map(b=>({...b}))};
  copy.category=categoryFor(copy).name;copy.category_no=categoryFor(copy).number;
  if(copy.action==='update' && !copy.visibility)copy.visibility='preserve';
  let images=0;for(const b of copy.blocks)if(b.type==='image' && b.role!=='footer'){if(!b.role)b.role=images===0?'cover':'body';images++;}
  if(!copy.blocks.some(b=>b.role==='footer'))copy.blocks.push({type:'image',role:'footer',file:'office_contact.jpeg',alt:'신동엽 세무사 모바일 명함'});
  return copy;
}
function validateQuality(job) {
  if(job.profile!=='v89')return;
  const {name,number}=categoryFor(job);
  if(job.category!==name || job.category_no!==number)throw Error('topic_category_mismatch');
  const footer=job.blocks.filter(b=>b.role==='footer');
  if(footer.length!==1 || job.blocks.at(-1)!==footer[0] || footer[0].type!=='image' || footer[0].file!=='office_contact.jpeg')throw Error('business_card_must_be_last');
  const illustrations=job.blocks.filter(b=>b.type==='image' && b.role!=='footer');
  if(illustrations.length<6 || illustrations.filter(b=>b.role==='cover').length!==1 || illustrations.filter(b=>b.role==='body').length<5)throw Error('cover_and_five_body_images_required');
  if(illustrations[0].role!=='cover' || new Set(illustrations.map(b=>b.file)).size!==illustrations.length)throw Error('image_mapping_invalid');
  for(let i=1;i<job.blocks.length-1;i++)if(job.blocks[i].type==='image' && job.blocks[i-1].type==='image')throw Error('body_images_must_be_distributed');
  const text=job.blocks.flatMap(b=>b.runs?.map(r=>r.text) || (b.rows?.flat() || [])).join('');
  if(text.replace(/\s/g,'').length<2600)throw Error('article_too_short_for_v89');
  if(job.blocks.filter(b=>b.type==='heading').length<6 || !/가상|사례|예시/.test(text) || !/질문|FAQ/.test(text))throw Error('substantive_sections_required');
}
module.exports={categoryFor,enrich,validateQuality};
