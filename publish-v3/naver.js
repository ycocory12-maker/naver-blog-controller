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
  async button(name) {
    for(const frame of this.page.frames()) {
      const b=frame.getByRole('button',{name,exact:true});
      if(await b.count()===1 && await b.isVisible()) return b;
    }
    throw Error('unique_visible_button_missing:'+name);
  }
  async pasteHTML(html) {
    // Use a real clipboard paste so SmartEditor handles formatting in its model.
    await this.frame.evaluate(async html => {
      const d=document.createElement('div'); d.innerHTML=html;
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([d.textContent],{type:'text/plain'})})]);
    },html);
    await this.page.keyboard.press('Control+V');
  }
  async prepare(job) {
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
    await this.page.goto(`https://blog.naver.com/${BLOG}?Redirect=Write`,{waitUntil:'domcontentloaded'});
    this.frame=await this.locateEditor();
    // Recovery prompts can appear after the editor modules have loaded.
    for(let i=0;i<24;i++) {
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
    // Placeholder copy is rendered as innerText even in an empty SmartEditor module.
    const emptyTitle=await title.evaluate(e=>e.classList.contains('se-is-empty'));
    const emptyBody=await body.evaluate(e=>e.classList.contains('se-is-empty'));
    if(!emptyTitle || !emptyBody || await this.frame.locator('.se-component.se-image, .se-component.se-table').count()) throw Error('nonempty_editor_requires_manual_recovery');
    this.progress?.('entering_title');
    await title.click();await this.page.keyboard.insertText(job.title);
    await body.click();
    let index=0;
    for(const b of job.blocks) {
      this.progress?.(`block_${++index}_${b.type}`);
      if(b.type==='image') {
        const before=await this.frame.locator('.se-component.se-image').count();
        const [chooser]=await Promise.all([this.page.waitForEvent('filechooser',{timeout:10000}),(await this.button(/^사진/)).click()]);
        await chooser.setFiles(path.join(this.assets,b.file));
        await this.frame.waitForFunction(n=>document.querySelectorAll('.se-component.se-image').length===n+1,before,{timeout:60000});
        const last=this.frame.locator('.se-component').last(); await last.click();
        await this.page.keyboard.press('ArrowDown'); await this.page.keyboard.press('End'); await this.page.keyboard.press('Enter');
      } else {
        await this.pasteHTML(renderBlock(b));
        const expected=b.type==='table'?b.rows.flat().join(''):b.runs.map(r=>r.text).join('');
        await this.frame.waitForFunction(text=>(document.body.innerText || '').replace(/[\s\u200b\ufeff]/g,'').includes(text),norm(expected),{timeout:10000});
        await this.page.keyboard.press('ArrowDown'); await this.page.keyboard.press('End'); await this.page.keyboard.press('Enter');
      }
    }
  }
  async verifyContent(frame,job,published=false) {
    const root=frame.locator(published?'.se-main-container':'body');
    if(await root.count()!==1) throw Error('content_container_missing');
    const snapshot=await root.evaluate(el=>({
      text:el.innerText,
      images:el.querySelectorAll('.se-component.se-image').length,
      tables:[...el.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>c.innerText))),
      styles:[...el.querySelectorAll('span,strong,b,mark')].map(e=>({text:e.textContent,bold:parseInt(getComputedStyle(e).fontWeight)>=600,bg:getComputedStyle(e).backgroundColor}))
    }));
    const actual=norm(snapshot.text); let offset=0;
    for(const b of job.blocks) {
      if(b.type==='image') continue;
      const texts=b.type==='table'?b.rows.flat():b.runs.map(r=>r.text);
      for(const text of texts) { const n=norm(text), at=actual.indexOf(n,offset); if(at<0) throw Error('content_missing_or_out_of_order'); offset=at+n.length; }
      if(b.type==='table' && !snapshot.tables.some(t=>JSON.stringify(t.map(r=>r.map(norm)))===JSON.stringify(b.rows.map(r=>r.map(norm))))) throw Error('table_format_not_preserved');
      for(const r of b.runs || []) {
        if(r.bold && !snapshot.styles.some(s=>s.bold && norm(s.text).includes(norm(r.text)))) throw Error('bold_not_preserved');
        if(r.highlight && !snapshot.styles.some(s=>!['rgba(0, 0, 0, 0)','rgb(255, 255, 255)','transparent'].includes(s.bg) && norm(s.text).includes(norm(r.text)))) throw Error('highlight_not_preserved');
      }
    }
    if(snapshot.images!==job.blocks.filter(b=>b.type==='image').length) throw Error('image_count_mismatch');
    if(!published && norm(await frame.locator('.se-documentTitle').innerText())!==norm(job.title)) throw Error('title_mismatch');
  }
  async verifyEditor(job) { await this.verifyContent(this.frame,job); }
  async saveDraft() {
    // Draft persistence needs reopening and verification; unsupported until UI calibration.
    throw Error('draft_mode_not_calibrated_use_publish');
  }
  async publish(job) {
    await (await this.button('발행')).click();
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
      if(await radio.count()===1) { await radio.check(); selected=await radio.isChecked(); break; }
    }
    if(!selected) throw Error('public_visibility_not_verified');
    await (await this.button('발행')).click();
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
        await this.verifyContent(f,job,true); return url;
      }
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('published_content_not_verified');
  }
  async close() {
    // Keep a failed editor open for manual recovery; disconnect only this CDP client.
    if(this.browser) await this.browser.close();
  }
  async diagnostics() {
    if(!this.page) return {stage:'browser_connection'};
    const pages=[];
    for(const frame of this.page.frames()) pages.push({url:frame.url(),editor:await frame.locator('.se-documentTitle').count(),buttons:await frame.getByRole('button').allTextContents(),fields:await frame.locator('.se-title-text,.se-component.se-text .se-module-text').evaluateAll(es=>es.map(e=>({tag:e.tagName,class:e.className,text:e.innerText.slice(0,100)}))),focus:await frame.evaluate(()=>({tag:document.activeElement?.tagName,class:document.activeElement?.className}))});
    return {url:this.page.url(),frames:pages};
  }
}
module.exports={NaverAdapter};
