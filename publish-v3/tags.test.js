'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {publishedTags,assertTags}=require('./tags');
test('verify actual tag links rather than body keywords or tag settings controls',()=>{
 const links=[{text:'#부모자녀차용증',href:'/PostList.naver?tagName=parent'},{text:'증여세상담',class:'tag_item',href:'/tags/a'},{text:'신동엽세무사',href:'/profile'},{text:'태그 수정',class:'tag-edit'}];
 const tags=publishedTags(links);assert.deepEqual(tags,['부모자녀차용증','증여세상담']);assertTags(['부모자녀차용증'],tags);assert.throws(()=>assertTags(['신동엽세무사'],tags),/missing/);
});
