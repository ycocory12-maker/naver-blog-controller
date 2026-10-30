"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "function boundaries must exist");
  return source.slice(a, b);
}
const runtimeSource = extract("function handleRuntimeStatus(req, res, url) {", "function handlePipelineStatus(req, res, url) {");
function callRuntime({authorized=true, job=null, running=false, malformed=false}={}) {
  const file = "/tmp/work4-runtime-job.json";
  const fakeFs = {
    existsSync: (p) => p === file ? job !== null : p === "/tmp/work4-runtime-008-1.png",
    readFileSync: () => malformed ? "{" : JSON.stringify(job),
  };
  const ctx = {
    fs:fakeFs, path, ROOT:"/app", RUNTIME_JOB_FILE:file,
    pipelineAuthorized:()=>authorized, work4RunPromise:running ? Promise.resolve() : null,
    lastResult:{status:"DRAFT_SAVED",content_id:"032",draft_saved:true,published:false},
    out(){},
  };
  vm.runInNewContext(runtimeSource+"; this.handle = handleRuntimeStatus;",ctx);
  const res={statusCode:200,setHeader(){},end(v){this.body=JSON.parse(v);}};
  ctx.handle({},res,new URL("https://example.invalid/runtime-status"));
  return res;
}
assert.equal(callRuntime({authorized:false}).statusCode,403);
assert.equal(callRuntime().body.runtime_job_present,false);
const live=callRuntime({job:{content_id:"008",images:["../tmp/work4-runtime-008-1.png","../tmp/work4-runtime-008-2.png"]},running:true});
assert.equal(live.body.runtime_content_id,"008");
assert.equal(live.body.expected_images,2);
assert.equal(live.body.present_images,1);
assert.equal(live.body.work4_running,true);
assert.equal(live.body.upload_permission_granted,false);
assert.equal(callRuntime({job:{content_id:"008",images:[]},malformed:true}).statusCode,503);

const verifySource=extract("async function verifyPersistedDraft(frame, page, job) {","async function runJob() {");
async function checkPersisted(formatting) {
  let opened=0;
  const frame={locator(sel){
    if(sel===".se-documentTitle")return {innerText:async()=>"Expected title"};
    if(sel===".se-component.se-text")return {allInnerTexts:async()=>["Expected body"]};
    if(sel===".se-component.se-image")return {count:async()=>2};
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
  vm.runInNewContext(verifySource+"; this.verify = verifyPersistedDraft;",ctx);
  const args=[frame,{waitForTimeout:async()=>{}},{title:"Expected title",images:["one"],bold_blocks:["Expected body"]}];
  if(formatting)assert.equal(await ctx.verify(...args),true);
  else await assert.rejects(ctx.verify(...args),/reopen_verification_failed/);
  assert.equal(opened,1);
}
(async()=>{
  await checkPersisted(true);
  await checkPersisted(false);
  assert.match(source,/result\\.draft_reopen_verified !== true/);
  assert.equal((source.match(/result\\.draft_reopen_verified = await verifyPersistedDraft\\(frame, page, job\\);/g)||[]).length,3);
  console.log("PASS runtime diagnostics and persisted draft guard");
})().catch(e=>{console.error(e);process.exitCode=1;});
