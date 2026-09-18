'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('scheduled messages require the authenticated CRM WhatsApp connection before writing',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lungo-schedule-'));
 const env={CLIENTS_FILE_PATH:path.join(dir,'clients.json'),LEADS_FILE_PATH:path.join(dir,'leads.json'),CUSTOMER_CLIENTS_FILE_PATH:path.join(dir,'customers.json'),EVOLUTION_BASE_URL:'https://evolution.invalid',EVOLUTION_API_KEY:'test',SCHEDULED_FOLLOWUPS_DISABLED:'false'};
 const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 fs.writeFileSync(env.CLIENTS_FILE_PATH,JSON.stringify([{token:'OWNER',instanceName:'crm-owner',ativo:true},{token:'OTHER',instanceName:'crm-other',ativo:true},{token:'MISSING',ativo:true}]));
 fs.writeFileSync(env.LEADS_FILE_PATH,JSON.stringify([{id:'lead',instanceName:'crm-owner'}]));fs.writeFileSync(env.CUSTOMER_CLIENTS_FILE_PATH,'[]');
 const axios=require('axios'),express=require('express'),originalGet=axios.get;
 let status='close',calls=[];
 axios.get=async url=>{calls.push(url);if(status==='timeout')throw new Error('timeout');return {status:200,data:{instance:{state:status}}};};
 // Do not start the background sender in this isolated HTTP test.
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const modulePath=require.resolve('../src/scheduled-followups');delete require.cache[modulePath];
 const {register}=require(modulePath);t.mock.timers.reset();require.cache[require.resolve('express')].exports=express;
 const app=express();app.use(express.json());register(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const availability=token=>fetch(base+'/api/scheduled/availability',{headers:{'x-client-token':token}});
 const save=token=>fetch(base+'/api/scheduled/leads/lead',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,data:'2099-01-01',hora:'09:00',mensagem:'Teste'})});
 try{
  assert.equal((await availability('INVALID')).status,403);assert.equal(calls.length,0);
  assert.equal((await availability('MISSING')).status,409);assert.equal(calls.length,0);
  let response=await availability('OWNER');assert.equal(response.status,409);assert.match((await response.json()).error,/Conecte seu WhatsApp/);
  assert.equal((await save('OWNER')).status,409);assert.equal(JSON.parse(fs.readFileSync(env.LEADS_FILE_PATH))[0].mensagemProgramada,undefined);
  status='open';assert.equal((await availability('OWNER')).status,200);assert.equal((await save('OTHER')).status,404);
  assert.equal((await save('OWNER')).status,200);assert.equal(JSON.parse(fs.readFileSync(env.LEADS_FILE_PATH))[0].mensagemProgramada.mensagem,'Teste');
  assert.ok(calls.some(x=>x.endsWith('/crm-owner')));assert.ok(calls.some(x=>x.endsWith('/crm-other')));assert.ok(calls.every(x=>!x.includes('lungo_ai')));
  status='close';assert.equal((await save('OWNER')).status,409,'connection loss after opening prevents save');
  status='timeout';assert.equal((await availability('OWNER')).status,503);
  process.env.SCHEDULED_FOLLOWUPS_DISABLED='true';assert.equal((await save('OWNER')).status,503);
 }finally{
  await new Promise(r=>server.close(r));axios.get=originalGet;delete require.cache[modulePath];
  for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
