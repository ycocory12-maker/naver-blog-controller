'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('./core'),{inventory,cleanup}=require('./maintenance');
test('cleanup removes only hash-backed published assets and keeps queued, uncertain, shared and footer files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naver-maintenance-'));try{
  const assets=path.join(dir,'assets');fs.mkdirSync(assets);const jobs=new Store(path.join(dir,'jobs'));
  for(const f of ['old.png','shared.png','ready.png','uncertain.png','office_contact.jpeg','orphan.png'])fs.writeFileSync(path.join(assets,f),f);
  const blocks=files=>files.map(file=>({type:'image',file}));jobs.put({id:'old',status:'PUBLISHED',url:'https://blog.naver.com/tlsehdduq0152/123',job:{blocks:blocks(['old.png','shared.png','office_contact.jpeg'])}});
  jobs.put({id:'uncertain',status:'NEEDS_RECONCILIATION',job:{blocks:blocks(['uncertain.png'])}});
  const scheduler={state:()=>({items:[{job_id:'next',content_id:70,status:'READY'}]}),item:()=>({job:{blocks:blocks(['ready.png','shared.png'])}})};
  const context={dataDir:dir,assets,jobs,scheduler},before=inventory(context),old=before.files.find(f=>f.file==='old.png');
  assert.deepEqual(before.files.filter(f=>f.can_remove).map(f=>f.file),['old.png']);
  assert.throws(()=>cleanup(context,{backup_receipt:'local-backup',files:[{file:'old.png',sha256:old.sha256,backup_sha256:'bad'}]}),/backup_hash/);
  assert.throws(()=>cleanup(context,{backup_receipt:'local-backup',files:[{file:'old.png',sha256:old.sha256,backup_sha256:old.sha256},{file:'shared.png'}]}),/not_removable/);assert.ok(fs.existsSync(path.join(assets,'old.png')));
  const result=cleanup(context,{backup_receipt:'local-backup',files:[{file:'old.png',sha256:old.sha256,backup_sha256:old.sha256}]});assert.equal(result.removed_files,1);assert.equal(fs.existsSync(path.join(assets,'old.png')),false);
  for(const f of ['shared.png','ready.png','uncertain.png','office_contact.jpeg','orphan.png'])assert.ok(fs.existsSync(path.join(assets,f)));
  assert.equal(jobs.get('old').status,'PUBLISHED');assert.equal(new Store(path.join(dir,'maintenance')).get(result.id).status,'COMPLETED');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});