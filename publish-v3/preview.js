'use strict';
const fs=require('node:fs'),path=require('node:path');
const {validate,renderBlock,escape}=require('./core');
function preview(job, imagePrefix='') {
  validate(job);
  return '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(job.title)+'</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;color:#20372c;font:18px/1.85 "Malgun Gothic",sans-serif;background:#fffef9}h1{font-size:34px;line-height:1.4}h2{margin-top:42px;font-size:25px}p{margin:24px 0}img{width:100%;height:auto;border-radius:20px}th{color:#214e30}a{color:#286a44}table{font-size:16px}footer{color:#748174;font-size:14px;border-top:1px solid #ddd;margin-top:40px}</style><h1>'+escape(job.title)+'</h1>'+job.blocks.map(b=>b.type==='image'?`<img src="${escape(imagePrefix+b.file)}" alt="${escape(b.alt)}">`:renderBlock(b)).join('\n')+'<footer>원고·서식 미리보기 · 네이버 게시 결과는 별도 확인</footer></html>';
}
if(require.main===module){const file=process.argv[2];const job=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(path.join(path.dirname(file),'preview.html'),preview(job));}
module.exports={preview};
