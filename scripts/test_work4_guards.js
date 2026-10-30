"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const start = source.indexOf("async function verifyPersistedDraft(frame, page, job) {");
const end = source.indexOf("async function runJob() {", start);
assert.ok(start >= 0 && end > start);
const verifier = source.slice(start, end);
async function testVerify({formatting=true,title=true,images=true}={}) {
  let opened=0;
  const frame={locator(sel){
    if(sel===".se-documentTitle")return {innerText:async()=>title?"Expected title":"Other"};
    if(sel===".se-component.se-text")return {allInnerTexts:async()=>["Expected body"]};
    if(sel===".se-component.se-image")return {count:async()=>images?2:0};
    throw new Error("unexpected selector");
  }};
  const ctx={
    openSavedDraftFromList:async()=>{opened++;},
    findEditorFrame:async()=>frame,
    bodyMatchesJob:()=>true,
    footerImageIsLast:async()=>true,
    layoutMatchesJob:async()=>true,
    verifyBoldBlocks:async()=>formatting,
    out(){},
  };
  vm.runInNewContext(verifier+"; this.verify=verifyPersistedDraft;",ctx);
  const args=[frame,{waitForTimeout:async()=>{}},{title:"Expected title",images:["one"],bold_blocks:["Expected body"]}];
  if(formatting&&title&&images)assert.equal(await ctx.verify(...args),true);
  else await assert.rejects(ctx.verify(...args),/reopen_verification_failed/);
  assert.equal(opened,1);
}
(async()=>{
  await testVerify();
  await testVerify({formatting:false});
  await testVerify({title:false});
  await testVerify({images:false});
  assert.match(source,/result\\.draft_reopen_verified !== true/);
  assert.equal((source.match(/result\\.draft_reopen_verified = await verifyPersistedDraft\\(frame, page, job\\);/g)||[]).length,3);
  console.log("PASS persisted-draft reopen gate");
})().catch(e=>{console.error(e);process.exitCode=1;});
