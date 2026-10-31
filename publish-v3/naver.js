'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {BLOG, renderBlock, publishedURL} = require('./core');
const norm = s => s.replace(/[\s\u200b\ufeff]/g,'');
class NaverAdapter {
  constructor({endpoint, assets, chromium}) { this.endpoint=endpoint; this.assets=path.resolve(assets); this.chromium=chromium; }
  async locateEditor() {
    for(let i=0;i<40;i++) {
      for(const frame of this.page.frames()) if(await frame.locator('.se-documentTitle').count()===1) return frame;
      if(this.page.url().includes('nid.naver.com')) throw Error('LOGIN_REQUIRED');
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('editor_not_found_or_login_required');
  }
  async categories() {
    this.browser=await require('./cdp').connect(this.chromium,this.endpoint);
    const context=this.browser.contexts()[0];if(!context)throw Error('browser_context_missing');
    this.page=await context.newPage();await this.page.goto(`https://blog.naver.com/${BLOG}`,{waitUntil:'domcontentloaded'});
    await new Promise(r=>setTimeout(r,1500));
    const frames=[];
    for(const f of this.page.frames()) frames.push({url:f.url(),links:await f.locator('a').evaluateAll(es=>es.map(e=>({text:e.innerText.trim(),href:e.getAttribute('href'),onclick:e.getAttribute('onclick'),class:e.className})).filter(e=>/category|카테고리/i.test((e.href||'')+' '+(e.onclick||'')+' '+e.class)))});
    return {blog:BLOG,frames};
  }
  async button(name) {
    for(const frame of this.page.frames()) {
      const b=frame.getByRole('button',{name,exact:true});
      if(await b.count()===1 && await b.isVisible()) return b;
    }
    throw Error('unique_visible_button_missing:'+name);
  }
  async pasteHTML(html,plainText) {
    // Use a real clipboard paste so SmartEditor handles formatting in its model.
    await this.frame.evaluate(async ({html,plainText}) => {
      const d=document.createElement('div'); d.innerHTML=html;
      const plain=plainText ?? d.textContent;
      for(let i=0;i<4;i++) {
        await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})]);
        await new Promise(r=>setTimeout(r,80));
        const items=await navigator.clipboard.read();let actualHTML='';
        for(const item of items)if(item.types.includes('text/html')){actualHTML=await (await item.getType('text/html')).text();break;}
        const check=document.createElement('div');check.innerHTML=actualHTML;
        if(await navigator.clipboard.readText()===plain && check.textContent===d.textContent)return;
      }
      throw Error('clipboard_content_not_verified');
    },{html,plainText});
    await this.page.keyboard.press('Control+V');
  }
  async focusAppend() {
    const last=this.frame.locator('.se-component.se-text .se-module-text').last();
    if(!await last.count())throw Error('append_text_module_missing');
    await last.scrollIntoViewIfNeeded();await last.click();await this.page.keyboard.press('Control+End');
    if(!await last.evaluate(e=>e.classList.contains('se-is-empty')) && norm(await last.innerText())) {
      await this.page.keyboard.press('Enter');await this.page.keyboard.press('Enter');
    }
  }
  async prepare(job) {
    this.jobId=job.id;
    this.progress?.('connecting_browser');
    for(const b of job.blocks.filter(b=>b.type==='image')) {
      const file=path.join(this.assets,b.file);
      if(!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size>15*1024*1024) throw Error('image_missing_or_too_large:'+b.file);
      const resolved=fs.realpathSync(file);
      if(path.dirname(resolved)!==fs.realpathSync(this.assets)) throw Error('image_outside_asset_directory');
    }
    this.browser=await require('./cdp').connect(this.chromium,this.endpoint);
    const context=this.browser.contexts()[0]; if(!context) throw Error('browser_context_missing');
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://blog.naver.com'});
    // Use an isolated tab; never overwrite an arbitrary existing tab or draft.
    this.page=await context.newPage();
    this.progress?.('opening_editor');
    if(job.action==='update') {
      await this.page.goto(job.target_url,{waitUntil:'domcontentloaded'});
      let post;
      for(let n=0;n<40 && !post;n++) {for(const f of this.page.frames())if(await f.locator('.se-main-container').count()===1){post=f;break;}if(!post)await new Promise(r=>setTimeout(r,250));}
      if(!post || !(await post.locator('body').innerText()).includes(job.expected_title))throw Error('update_original_post_not_verified');
      const backup={url:job.target_url,title:job.expected_title,body:await post.locator('.se-main-container').innerText(),saved_at:new Date().toISOString()};
      fs.writeFileSync(path.join(this.assets,job.id+'-before-update.json'),JSON.stringify(backup,null,2));
      let edit=post.getByRole('link',{name:'수정',exact:true});
      if(!await edit.count())edit=post.getByRole('button',{name:'수정',exact:true});
      if(await edit.count()!==1)throw Error('unique_edit_control_missing');
      await edit.click();
    } else await this.page.goto(`https://blog.naver.com/${BLOG}?Redirect=Write${job.category_no?'&categoryNo='+job.category_no:''}`,{waitUntil:'domcontentloaded'});
    this.frame=await this.locateEditor();
    // Recovery prompts can appear after the editor modules have loaded.
    for(let i=0;i<(job.action==='update'?0:24);i++) {
      const recovery=this.frame.getByText(/작성 중인 글이 있습니다|이어서 작성하시겠습니까/);
      if(await recovery.count() && await recovery.first().isVisible()) {
        const cancel=this.frame.getByRole('button',{name:'취소',exact:true});
        if(await cancel.count()!==1) throw Error('recovery_cancel_not_unique');
        await cancel.click();break;
      }
      await new Promise(r=>setTimeout(r,250));
    }
    const title=this.frame.locator('.se-documentTitle .se-title-text');
    const body=this.frame.locator('.se-component.se-text .se-module-text').first();
    if(await title.count()!==1 || !await body.count()) throw Error('editor_fields_missing');
    if(job.action==='update') {
      if(norm(await title.innerText())!==norm(job.expected_title))throw Error('update_editor_title_mismatch');
      await body.click();await this.page.keyboard.press('Control+A');await this.page.keyboard.press('Control+A');await this.page.keyboard.press('Backspace');
      await new Promise(r=>setTimeout(r,500));
      const left=(await this.frame.locator('.se-component:not(.se-documentTitle)').allInnerTexts()).join('').replace(/글감과 함께 나의 일상을 기록해보세요!/g,'');
      if(norm(left) || await this.frame.locator('.se-component.se-image,.se-component.se-table').count())throw Error('update_body_clear_not_verified');
    }
    // Placeholder copy is rendered as innerText even in an empty SmartEditor module.
    const emptyTitle=await title.evaluate(e=>e.classList.contains('se-is-empty'));
    const emptyBody=await body.evaluate(e=>e.classList.contains('se-is-empty'));
    if((!emptyTitle && job.action!=='update') || !emptyBody || await this.frame.locator('.se-component.se-image, .se-component.se-table').count()) throw Error('nonempty_editor_requires_manual_recovery');
    this.progress?.('entering_title');
    await title.click();if(job.action==='update'){await this.page.keyboard.press('Control+A');await this.page.keyboard.press('Backspace');}await this.page.keyboard.insertText(job.title);
    await body.click();
    let index=0,buffer=[];
    const flush=async()=>{
      if(!buffer.length)return;
      this.progress?.('text_group_ending_at_'+index);
      const inputs=buffer.map(b=>b.runs?{...b,runs:b.runs.map(r=>r.href?{...r,text:r.text+' '+r.href,href:undefined}:r)}:b);
      const html=inputs.map(renderBlock).join('<p><br></p>')+'<p><br></p>';
      const plain=inputs.map(b=>b.rows?b.rows.map(r=>r.join('\t')).join('\n'):b.runs.map(r=>r.text).join('')).join('\n\n')+'\n\n';
      await this.pasteHTML(html,plain);
      const phrases=buffer.flatMap(b=>b.rows?b.rows.flat():b.runs.map(r=>r.text)).map(norm);
      await this.frame.waitForFunction(parts=>{const text=(document.body.innerText || '').replace(/[\s\u200b\ufeff]/g,'');let offset=0;for(const p of parts){const at=text.indexOf(p,offset);if(at<0)return false;offset=at+p.length;}return true;},phrases,{timeout:10000});
      await new Promise(r=>setTimeout(r,150));
      await this.page.keyboard.press('ArrowDown');await this.page.keyboard.press('End');await this.page.keyboard.press('Enter');
      const paragraph=this.frame.locator('.se-component.se-text .se-module-text p').last();
      if(await paragraph.count()) {
        await paragraph.scrollIntoViewIfNeeded();await paragraph.click();
        await paragraph.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange',{bubbles:true}));});
        await this.page.keyboard.press('ArrowRight');
      }
      buffer=[];
    };
    for(const b of job.blocks) {
      index++;
      if(b.type==='image') {
        await flush();this.progress?.(`block_${index}_image`);
        const before=await this.frame.locator('.se-component.se-image').count();
        const input=this.frame.locator('input[type="file"][accept*="image"]');
        if(await input.count())await input.last().setInputFiles(path.join(this.assets,b.file));
        else {
          const [chooser]=await Promise.all([this.page.waitForEvent('filechooser',{timeout:10000}),(await this.button(/^사진/)).click()]);
          await chooser.setFiles(path.join(this.assets,b.file));
        }
        await this.frame.waitForFunction(n=>document.querySelectorAll('.se-component.se-image').length===n+1,before,{timeout:60000});
        await this.frame.waitForFunction(()=>[...document.querySelectorAll('.se-component.se-image img')].every(img=>img.complete && img.naturalWidth>0),null,{timeout:60000});
        if(index<job.blocks.length) {
          const last=this.frame.locator('.se-component.se-image').last();await last.click();
          await this.page.keyboard.press('ArrowDown');await this.page.keyboard.press('End');await this.page.keyboard.press('Enter');
          const following=this.frame.locator('.se-component.se-text .se-module-text').last();
          if(await following.evaluate(e=>e.classList.contains('se-is-empty')))await following.click();
        }
      } else {
        buffer.push(b);
      }
    }
    await flush();
  }
  async verifyContent(frame,job,published=false) {
    const root=frame.locator(published?'.se-main-container':'body');
    if(await root.count()!==1) throw Error('content_container_missing');
    const snapshot=await root.evaluate(el=>({
      text:el.innerText,
      images:el.querySelectorAll('.se-component.se-image').length,
      tables:[...el.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>c.innerText))),
      styles:[...el.querySelectorAll('span,strong,b,mark')].map(e=>({text:e.textContent,bold:parseInt(getComputedStyle(e).fontWeight)>=600,bg:getComputedStyle(e).backgroundColor})),
      units:[...el.querySelectorAll('.se-component')].filter(e=>!e.parentElement.closest('.se-component') && !e.matches('.se-documentTitle')).map(e=>e.matches('.se-image')?{type:'image',ratio:(e.querySelector('img')?.naturalWidth||0)/(e.querySelector('img')?.naturalHeight||1)}:{type:'text',text:e.innerText,empty:!!e.querySelector('.se-module-text.se-is-empty') && !e.querySelector('.se-module-text:not(.se-is-empty)')}).filter(e=>e.type==='image' || (!e.empty && e.text.trim()))
    }));
    const actual=norm(snapshot.text); let offset=0;
    for(const b of job.blocks) {
      if(b.type==='image') continue;
      const texts=b.type==='table'?b.rows.flat():b.runs.map(r=>r.text);
      for(const text of texts) { const n=norm(text), at=actual.indexOf(n,offset); if(at<0) throw Error('content_missing_or_out_of_order'); offset=at+n.length; }
      if(b.type==='table' && !snapshot.tables.some(t=>JSON.stringify(t.map(r=>r.map(norm)))===JSON.stringify(b.rows.map(r=>r.map(norm))))) throw Error('table_format_not_preserved');
      for(const r of b.runs || []) {
        if(r.bold && !snapshot.styles.some(s=>s.bold && norm(s.text).includes(norm(r.text)))) throw Error('bold_not_preserved');
        if(!r.bold && !snapshot.styles.some(s=>!s.bold && norm(s.text).includes(norm(r.text)))) throw Error('unwanted_bold_in_plain_text');
        if(r.highlight && !snapshot.styles.some(s=>!['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','transparent'].includes(s.bg) && norm(s.text).includes(norm(r.text)))) throw Error('highlight_not_preserved');
        if(!r.highlight && !snapshot.styles.some(s=>['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','transparent'].includes(s.bg) && norm(s.text).includes(norm(r.text)))) throw Error('unwanted_highlight_in_plain_text');
      }
    }
    if(snapshot.images!==job.blocks.filter(b=>b.type==='image').length) throw Error('image_count_mismatch');
    if(job.profile==='v89')require('./layout').verifyLayout(job,snapshot.units);
    if(!published && norm(await frame.locator('.se-documentTitle').innerText())!==norm(job.title)) throw Error('title_mismatch');
  }
  async verifyEditor(job) { await this.verifyContent(this.frame,job); }
  async saveDraft() {
    // Draft persistence needs reopening and verification; unsupported until UI calibration.
    throw Error('draft_mode_not_calibrated_use_publish');
  }
  async preparePublication(job) {
    this.progress?.('publication_settings');
    await (await this.button('발행')).click();
    if(job.category) {
      const current=this.frame.getByRole('button',{name:job.category,exact:true});
      if(await current.count()!==1 || !await current.isVisible()) {
        const panels=this.frame.getByText('카테고리',{exact:true});
        if(await panels.count()!==1)throw Error('category_label_not_unique');
        const row=panels.locator('xpath=..');const picker=row.getByRole('button');
        if(await picker.count()!==1)throw Error('category_picker_not_unique');await picker.click();
        let choice=this.frame.getByRole('option',{name:job.category,exact:true});
        if(!await choice.count())choice=this.frame.getByText(job.category,{exact:true});
        if(await choice.count()!==1)throw Error('category_choice_not_unique');await choice.click();
      }
      const chosen=this.frame.getByRole('button',{name:job.category,exact:true});
      if(await chosen.count()!==1 || !await chosen.isVisible())throw Error('category_selection_not_verified');
    }
    // A second explicit Publish button is required; unknown layouts fail closed.
    if(job.tags?.length) {
      const tag=this.page.getByPlaceholder('태그 입력');
      if(await tag.count()!==1) throw Error('tag_field_not_calibrated');
      for(const t of job.tags) { await tag.fill(t); await tag.press('Enter'); }
    }
    // Confirm public visibility rather than inheriting a previous private setting.
    let selected=false;
    for(const f of this.page.frames()) {
      const radio=f.getByRole('radio',{name:'전체공개',exact:true});
      if(await radio.count()===1) { if(job.visibility!=='preserve')await radio.check();selected=await radio.isChecked();break; }
    }
    if(!selected && job.visibility!=='preserve') throw Error('public_visibility_not_verified');
    const close=this.frame.getByRole('button',{name:'발행 설정 닫기',exact:true});
    if(await close.count()!==1 || !await close.isVisible()) throw Error('publication_panel_not_verified');
    const panel=close.locator('xpath=ancestor::div[.//button[normalize-space(.)="발행"]][1]');
    this.finalButton=panel.getByRole('button',{name:'발행',exact:true});
    if(await this.finalButton.count()!==1 || !await this.finalButton.isVisible()) throw Error('unique_confirmation_button_missing');
  }
  async publish() {
    await this.finalButton.click();
  }
  async verifyPublished(job) {
    let url;
    for(let i=0;i<60;i++) {
      url=publishedURL(this.page.url());
      if(!url) for(const f of this.page.frames()) { url=publishedURL(f.url()); if(url) break; }
      if(url) break;
      await new Promise(r=>setTimeout(r,500));
    }
    if(!url) throw Error('publish_response_uncertain');
    await this.page.goto(url,{waitUntil:'domcontentloaded'});
    for(let i=0;i<40;i++) {
      for(const f of this.page.frames()) if(await f.locator('.se-main-container').count()===1) {
        if(!(await f.locator('body').innerText()).includes(job.title)) throw Error('published_title_missing');
        if(job.category && !norm(await f.locator('body').innerText()).includes(norm('이 블로그 '+job.category+' 카테고리 글')))throw Error('published_category_not_verified');
        await this.verifyContent(f,job,true); return url;
      }
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('published_content_not_verified');
  }
  async close() {
    // This tab was created by this worker; leave all pre-existing user tabs untouched.
    if(this.page) await this.page.close({runBeforeUnload:false}).catch(()=>{});
    if(this.browser) await this.browser.close();
  }
  async inspectPublished(job,url) {
    if(!publishedURL(url)) throw Error('invalid_published_url');
    this.browser=await require('./cdp').connect(this.chromium,this.endpoint);
    const context=this.browser.contexts()[0];if(!context)throw Error('browser_context_missing');
    this.page=await context.newPage();await this.page.goto(url,{waitUntil:'domcontentloaded'});
    const verified=await this.verifyPublished(job);
    let frame;for(const f of this.page.frames()) if(await f.locator('.se-main-container').count()===1){frame=f;break;}
    if(!frame) throw Error('published_container_missing');
    // A tall element screenshot is clipped by Naver's parent iframe viewport.
    // Capture actual viewport segments after scrolling each section into view.
    const file=job.id+'-published.png',tableFile=job.id+'-table.png',bottomFile=job.id+'-bottom.png';
    await frame.locator('.se-main-container .se-component').first().scrollIntoViewIfNeeded();
    await this.page.screenshot({path:path.join(this.assets,file)});
    if(await frame.locator('.se-main-container table').count()) {
      await frame.locator('.se-main-container table').first().scrollIntoViewIfNeeded();
      await this.page.screenshot({path:path.join(this.assets,tableFile)});
    }
    await frame.locator('.se-main-container .se-component').last().scrollIntoViewIfNeeded();
    await this.page.screenshot({path:path.join(this.assets,bottomFile)});
    return {url:verified,screenshot:file,table_screenshot:tableFile,bottom_screenshot:bottomFile,verified_at:new Date().toISOString()};
  }
  async diagnostics() {
    if(!this.page) return {stage:'browser_connection'};
    if(this.jobId) await this.page.screenshot({path:path.join(this.assets,this.jobId+'-debug.png')}).catch(()=>{});
    const pages=[];
    for(const frame of this.page.frames()) pages.push({url:frame.url(),editor:await frame.locator('.se-documentTitle').count(),buttons:await frame.getByRole('button').allTextContents(),fields:await frame.locator('.se-title-text,.se-component.se-text .se-module-text').evaluateAll(es=>es.map(e=>({tag:e.tagName,class:e.className,text:e.innerText.slice(0,100)}))),focus:await frame.evaluate(()=>({tag:document.activeElement?.tagName,class:document.activeElement?.className}))});
    return {url:this.page.url(),frames:pages,document:this.frame?await this.frame.evaluate(()=>({images:document.querySelectorAll('.se-component.se-image').length,tables:document.querySelectorAll('.se-component table').length,tail:document.body.innerText.slice(-1500),fileInputs:[...document.querySelectorAll('input[type=file]')].map(e=>e.outerHTML),photoButtons:[...document.querySelectorAll('button')].filter(e=>e.innerText.startsWith('사진')).map(e=>e.outerHTML),paragraphs:[...document.querySelectorAll('.se-component.se-text p')].slice(-3).map(e=>({class:e.className,text:e.innerText})),categoryMarkup:[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && e.textContent==='카테고리').map(e=>e.parentElement.outerHTML.slice(0,2000))})):null,screenshot:this.jobId?this.jobId+'-debug.png':null};
  }
}
module.exports={NaverAdapter};
