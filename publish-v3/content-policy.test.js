'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {enrich,categoryFor,validateQuality}=require('./content-policy');const {verifyLayout}=require('./layout');
test('route real blog category numbers from topic',()=>{
  for(const [title,num] of [['병원 개원 인테리어',11],['유튜버 장비 비용',10],['변호사 수임료',10],['쇼핑몰 부가세',10],['법인 임원퇴직금',12],['상속주택 양도세',13],['일반 세무 안내',8]])assert.equal(categoryFor({title}).number,num);
});
test('append fixed card automatically and reject thin articles and missing images',()=>{
  const b=[{type:'paragraph',runs:[{text:'내용'}]}];const j=enrich({title:'병원 개원',blocks:b},'v89');
  assert.equal(j.blocks.at(-1).file,'office_contact.jpeg');assert.equal(j.category_no,11);assert.equal(b.length,1);assert.throws(()=>validateQuality(j),/five_body/);
});
test('footer must be last and relative image positions must match text',()=>{
  const job={blocks:[{type:'image'},{type:'paragraph',runs:[{text:'본문'}]},{type:'image'}]};
  verifyLayout(job,[{type:'image',ratio:1.5},{type:'text',text:'본문'},{type:'image',ratio:1179/604}]);
  assert.throws(()=>verifyLayout(job,[{type:'text',text:'본문'},{type:'image',ratio:1.5},{type:'image',ratio:1179/604}]),/order/);
  assert.throws(()=>verifyLayout(job,[{type:'image',ratio:1.5},{type:'image',ratio:1179/604},{type:'text',text:'본문'}]),/not_last/);
  assert.throws(()=>verifyLayout(job,[{type:'image',ratio:1.5},{type:'text',text:'본문'},{type:'image',ratio:1.5}]),/dimensions/);
});
