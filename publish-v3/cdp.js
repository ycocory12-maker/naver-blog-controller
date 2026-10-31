'use strict';
const http=require('node:http'),https=require('node:https');
async function websocketEndpoint(endpoint) {
  const target=new URL(endpoint);
  if(['ws:','wss:'].includes(target.protocol)) return endpoint;
  if(!['http:','https:'].includes(target.protocol)) throw Error('invalid_cdp_protocol');
  const url=new URL('/json/version',target);
  const version=await new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?https:http).get(url,{headers:{Host:'localhost:'+ (url.port || (url.protocol==='https:'?'443':'80'))}},res=>{
      let data='';res.setEncoding('utf8');
      res.on('data',chunk=>{data+=chunk;if(data.length>65536)req.destroy(Error('cdp_response_too_large'));});
      res.on('end',()=>{if(res.statusCode!==200)return reject(Error('cdp_version_http_'+res.statusCode));try{resolve(JSON.parse(data));}catch(e){reject(e);}});
    });req.setTimeout(10000,()=>req.destroy(Error('cdp_timeout')));req.on('error',reject);
  });
  const ws=new URL(version.webSocketDebuggerUrl);
  if(!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(ws.pathname)) throw Error('invalid_cdp_browser_endpoint');
  ws.protocol=target.protocol==='https:'?'wss:':'ws:';ws.host=target.host;
  return ws.toString();
}
async function connect(chromium,endpoint) {
  const ws=await websocketEndpoint(endpoint),u=new URL(endpoint);
  return chromium.connectOverCDP(ws,{headers:{Host:'localhost:'+(u.port || '9222')},timeout:30000});
}
module.exports={websocketEndpoint,connect};
