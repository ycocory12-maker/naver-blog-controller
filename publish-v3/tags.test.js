'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {publishedTags,assertTags}=require('./tags');
test('wait for delayed published tags; missing tags still fail after the bounded deadline',async()=>{
 const {waitForTags}=require('./tags');let time=0,reads=0;
 const options={timeout:1000,interval:250,clock:()=>time,sleep:async ms=>{time+=ms;}};
 const tags=await waitForTags(async()=>++reads<4?[]:[{text:'#배송비',href:'/PostListByTagName.naver?tagName=x'}],['배송비'],options);
 assert.deepEqual(tags,['배송비']);assert.equal(reads,4);assert.equal(time,750);
 await assert.rejects(waitForTags(async()=>[],['missing'],options),/published_tag_missing:missing/);
 assert.equal(time,1750);
});
test('verify actual tag links rather than body keywords or tag settings controls',()=>{
 const links=[{text:'#부모자녀차용증',href:'/PostList.naver?tagName=parent'},{text:'증여세상담',class:'tag_item',href:'/tags/a'},{text:'신동엽세무사',href:'/profile'},{text:'태그 수정',class:'tag-edit'}];
 const tags=publishedTags(links);assert.deepEqual(tags,['부모자녀차용증','증여세상담']);assertTags(['부모자녀차용증'],tags);assert.throws(()=>assertTags(['신동엽세무사'],tags),/missing/);
});

