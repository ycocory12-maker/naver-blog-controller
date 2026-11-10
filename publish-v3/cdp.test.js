'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');const {websocketEndpoint}=require('./cdp');
test('CDP version uses exact path and local Host; websocket stays on configured internal service',async()=>{
  let observed;const server=http.createServer((req,res)=>{observed={url:req.url,host:req.headers.host};res.end(JSON.stringify({webSocketDebuggerUrl:'ws://localhost:9222/devtools/browser/abc-123'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
  try {assert.equal(await websocketEndpoint('http://127.0.0.1:'+port),`ws://127.0.0.1:${port}/devtools/browser/abc-123`);assert.deepEqual(observed,{url:'/json/version',host:'localhost:'+port});}finally{await new Promise(r=>server.close(r));}
});
