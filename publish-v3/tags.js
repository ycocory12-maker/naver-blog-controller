'use strict';
function publishedTags(anchors) {
  const found=[];
  for(const a of anchors) {
    const text=String(a.text||'').trim().replace(/^#/,'');
    if(/tag/i.test((a.href||'')+' '+(a.class||'')) && /^[가-힣a-zA-Z0-9_]{1,30}$/.test(text))found.push(text);
  }
  return [...new Set(found)];
}
function assertTags(expected,actual) {for(const t of expected||[])if(!actual.includes(t))throw Error('published_tag_missing:'+t);}
async function waitForTags(read,expected,{timeout=15000,interval=250,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const deadline=clock()+timeout;
  for(;;) {
    const actual=publishedTags(await read());
    try{assertTags(expected,actual);return actual;}
    catch(error){if(clock()>=deadline)throw error;}
    await sleep(interval);
  }
}
module.exports={publishedTags,assertTags,waitForTags};

