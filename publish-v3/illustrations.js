'use strict';
const path=require('node:path'),fs=require('node:fs');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function diagram(slide,cover=false) {
  if(!slide || slide.title.length>65 || slide.cards.length!==3 || slide.cards.some(c=>c.title.length>24||c.text.length>100))throw Error('diagram_text_too_long');
  const height=cover?1200:900;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:1200px;height:${height}px;background:#f7f9fc;color:#142238;font-family:'Noto Sans CJK KR','Noto Sans KR',sans-serif}main{height:100%;padding:76px 72px 58px;display:flex;flex-direction:column;border-top:16px solid #233d64}.eyebrow{color:#527863;letter-spacing:3px;font-size:23px;font-weight:700}h1{font-size:${cover?68:57}px;line-height:1.3;word-break:keep-all;margin:30px 0 18px;letter-spacing:-2px;max-width:1040px}.sub{font-size:28px;line-height:1.5;margin:0;color:#516175;word-break:keep-all}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin:auto 0 36px}.card{background:white;border:1px solid #dae1e9;border-radius:22px;padding:28px 25px;min-height:270px}.num{font-size:22px;color:#527863;font-weight:800}h2{font-size:32px;line-height:1.35;word-break:keep-all;margin:22px 0 18px}.card p{font-size:25px;line-height:1.6;color:#46566a;word-break:keep-all;margin:0}footer{border-top:1px solid #d5dce4;padding-top:25px;display:flex;justify-content:space-between;color:#556779;font-size:21px}.accent{height:7px;width:90px;background:#9eb9a3;margin-top:25px}</style><main><div class="eyebrow">신동엽 세무사 · 세무 상담</div><h1>${esc(slide.title)}</h1><p class="sub">${esc(slide.subtitle)}</p><div class="accent"></div><div class="cards">${slide.cards.map((c,i)=>`<section class="card"><div class="num">0${i+1}</div><h2>${esc(c.title)}</h2><p>${esc(c.text)}</p></section>`).join('')}</div><footer><span>자료를 정리하면 상담이 구체적입니다</span><span>자세한 내용은 본문에서 확인하세요</span></footer></main></html>`;
}
async function renderDiagrams({endpoint,assets,id,slides,chromium}) {
  if(slides.length!==6)throw Error('six_diagrams_required');
  const browser=await require('./cdp').connect(chromium,endpoint);let page;
  try {
    page=await browser.contexts()[0].newPage();const files=[];
    for(let i=0;i<slides.length;i++) {
      const file=id+'-'+(i?'body0'+i:'cover')+'.png';await page.setViewportSize({width:1200,height:i?900:1200});
      await page.setContent(diagram(slides[i],i===0),{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
      const bad=await page.evaluate(()=>[...document.querySelectorAll('main,.card')].some(e=>e.scrollHeight>e.clientHeight+2)||document.querySelector('main').getBoundingClientRect().bottom>innerHeight+1);
      if(bad)throw Error('diagram_overflow_'+i);
      const filePath=path.join(assets,file);if(fs.existsSync(filePath))throw Error('generated_image_name_already_used');
      await page.screenshot({path:filePath,type:'png'});files.push(file);
    }return files;
  }finally{await page?.close().catch(()=>{});await browser.close();}
}
module.exports={diagram,renderDiagrams};
