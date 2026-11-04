'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {imageInfo}=require('./images');
test('read JPEG dimensions without altering the business card file',()=>{
  const b=Buffer.from([255,216,255,192,0,17,8,2,92,4,155,3,1,17,0,2,17,0,3,17,0,255,217]);
  assert.deepEqual(imageInfo(b),{height:604,width:1179,type:'image/jpeg'});
  assert.throws(()=>imageInfo(Buffer.from('not an image')));
});
