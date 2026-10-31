'use strict';
const fs=require('node:fs'),path=require('node:path');
const {validate}=require('./core');
async function main() {
  const [action,configFile,jobFile]=process.argv.slice(2);
  if(!['upload','publish','retry','verify','status'].includes(action) || !configFile || !jobFile) throw Error('usage: node client.js upload|publish|retry|verify|status settings.json job.json');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8')),job=validate(JSON.parse(fs.readFileSync(jobFile,'utf8')));
  const origin='https://naver-publisher-v3-production.up.railway.app';
  const headers={authorization:'Bearer '+config.API_TOKEN};
  async function request(route,options={}) {
    const response=await fetch(origin+route,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(60000)});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error('non_json_response:'+response.status);}
    if(!response.ok) throw Error(JSON.stringify({http:response.status,...data}));return data;
  }
  if(action==='upload') {
    for(const b of job.blocks.filter(b=>b.type==='image')) console.log(JSON.stringify(await request('/assets/'+b.file,{method:'PUT',headers:{'content-type':'image/png'},body:fs.readFileSync(path.join(path.dirname(jobFile),b.file))})));
  } else if(action==='publish') {
    const {job:payload,...result}=await request('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(job)});console.log(JSON.stringify(result));
  } else if(action==='retry') console.log(JSON.stringify(await request('/jobs/'+job.id+'/retry',{method:'POST'})));
  else if(action==='verify') {
    const proof=await request('/jobs/'+job.id+'/verify',{method:'POST'});
    const response=await fetch(origin+'/assets/'+proof.screenshot,{headers,signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('screenshot_download_failed');
    fs.writeFileSync(path.join(path.dirname(jobFile),'published.png'),Buffer.from(await response.arrayBuffer()));
    for(const [key,name] of [['table_screenshot','published-table.png'],['bottom_screenshot','published-bottom.png']]) if(proof[key]) {
      const img=await fetch(origin+'/assets/'+proof[key],{headers,signal:AbortSignal.timeout(60000)});if(!img.ok)throw Error('evidence_download_failed');fs.writeFileSync(path.join(path.dirname(jobFile),name),Buffer.from(await img.arrayBuffer()));
    }
    fs.writeFileSync(path.join(path.dirname(jobFile),'verification.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
  } else {const {job:payload,...state}=await request('/jobs/'+job.id);fs.writeFileSync(path.join(path.dirname(jobFile),'runtime-status.json'),JSON.stringify(state,null,2));console.log(JSON.stringify(state,null,2));}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
