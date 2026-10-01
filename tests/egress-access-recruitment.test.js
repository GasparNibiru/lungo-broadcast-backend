'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const express=require('express');
const presentation=require('../src/services/recruitment-view');
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{
  module,exports:module.exports,require(name){if(Object.hasOwn(deps,name))return deps[name];throw Error('Unmocked dependency '+name);},
  console,process:{env:{}},URL,Buffer,__dirname:path.join(__dirname,'../src',path.dirname(file))
},{filename:file});return module.exports;}
function fixture(){
  const calls=[];
  const row={id:'access-row',status:'active',expires_at:null,users:{id:'u',organization_id:'org',role:'supervisor',name:'Teste',email:'test@example.invalid',status:'active',profile_photo_url:'photo',organizations:{id:'org',name:'Corretora',status:'active',logo_url:'logo'}}};
  let finalized=false;
  const db={from(table){const call={table,method:'select',filters:[]},q={select(fields){call.fields=fields;return q;},eq(k,v){call.filters.push([k,v]);return q;},neq(k,v){call.filters.push([k,v]);return q;},order(){return q;},update(){call.method='update';return q;},maybeSingle(){return q;},then(resolve,reject){calls.push(call);const data=call.method==='update'?null:table==='access_tokens'?row:[{id:'b',name:'Broker',email:'b@example.invalid',phone:'',status:'active',created_at:'2026-01-01',profile_photo_url:'UNUSED-PHOTO',access_tokens:[{status:'active',expires_at:null}]}];return Promise.resolve({data,error:null}).then(resolve,reject);}};return q;},async rpc(name){calls.push({rpc:name});return {data:finalized,error:null};}};
  const auth=load('middleware/require-access.js',{crypto,'../database/supabase':db});
  return {db,auth,row,calls,setFinalized(v){finalized=v;}};
}
const request=()=>({headers:{'x-access-token':'synthetic-access'}});
async function invoke(middleware,req){let next=0,status=200;const res={status(n){status=n;return this;},json(){return this;}};await middleware(req,res,()=>next++);await new Promise(r=>setImmediate(r));return {next,status};}

test('ordinary auth excludes images; nested middleware reuses only that request and rechecks role',async()=>{
  const f=fixture(),req=request();
  assert.equal((await invoke(f.auth.requireAccess(),req)).next,1);
  assert.equal((await invoke(f.auth.requireAccess('supervisor'),req)).next,1);
  assert.equal(f.calls.length,4);
  assert.doesNotMatch(f.calls[0].fields,/profile_photo_url|logo_url/);
  assert.equal(req.accessUser.profilePhotoUrl,'');assert.equal(req.accessUser.organization.logoUrl,'');
  assert.equal((await invoke(f.auth.requireAccess('broker'),req)).status,403);
  assert.equal(f.calls.length,4);
  f.row.users.status='inactive';
  assert.equal((await invoke(f.auth.requireAccess(),request())).status,401);
  assert.equal(f.calls.length,5); // New request always revalidates, no shared permission cache.
});
test('login/session presentation still returns photo and logo; expired/cancelled access denied',async()=>{
  const f=fixture(),req=request();
  await invoke(f.auth.requireAccess([],{includePresentation:true}),req);
  assert.match(f.calls[0].fields,/profile_photo_url/);assert.match(f.calls[0].fields,/logo_url/);
  assert.equal(req.accessUser.profilePhotoUrl,'photo');assert.equal(req.accessUser.organization.logoUrl,'logo');
  f.row.expires_at='2000-01-01';assert.equal((await invoke(f.auth.requireAccess(),request())).status,401);
  f.row.expires_at=null;f.setFinalized(true);assert.equal((await invoke(f.auth.requireAccess(),request())).status,401);
  assert.equal((await invoke(f.auth.requireAccess(),{headers:{}})).status,401);
});
test('changed credentials on same request are not covered by previous validation',async()=>{
  const f=fixture(),req=request();await invoke(f.auth.requireAccess(),req);
  req.headers['x-access-token']='other-synthetic-access';f.row.users.organizations.status='inactive';
  assert.equal((await invoke(f.auth.requireAccess(),req)).status,401);assert.equal(f.calls.length,5);
});
test('recruitment projection removes photos, preserves tenant isolation, stable change version and brief notification',()=>{
  const data={vacancies:[{organizationId:'org',title:'Vaga',logo:'LOGO'}],candidates:[
    {id:'a',organizationId:'org',name:'Teste',createdAt:'2026-01-01',profilePhotoUrl:'a'.repeat(100000),profile_photo_url:'b',photo:'c',disc:{token:'PRIVATE',completedAt:'2026-01-02',result:{match:80}}},
    {id:'foreign',organizationId:'other',name:'Other',createdAt:'2026-01-02'}]};
  const a=presentation.view(data,'org'),light=presentation.updates(data,'org');
  assert.equal(a.candidates.length,1);assert.equal(a.vacancy.logo,'LOGO');
  assert.doesNotMatch(JSON.stringify(a),/profilePhotoUrl|profile_photo_url|"photo"|PRIVATE|foreign/);
  assert.equal(light.version,a.version);assert.equal(light.notification.id,'a');
  assert.ok(Buffer.byteLength(JSON.stringify(light))<500);
  data.candidates[1].name='Changed';assert.equal(presentation.view(data,'org').version,a.version);
  data.candidates[0].seenAt='2026-01-03';assert.notEqual(presentation.view(data,'org').version,a.version);
  assert.equal(presentation.updates(data,'org').notification,null);
});
test('mounted supervisor/RH routers authenticate once; brief poll never queries brokers/sales; full view uses narrow broker query',async()=>{
  const f=fixture();
  const service=load('services/supervisor.js',{'../database/supabase':f.db,'./admin-accesses':{},'./legacy-broker-access':{},'./access-token-vault':{}});
  const supervisor=load('routes/supervisor.js',{express,'../middleware/require-access':f.auth,'../services/supervisor':service,'../services/legacy-broker-access':{ensure:async()=>null},'../services/subscription-cancellation':{}});
  const data={vacancies:[{organizationId:'org',title:'Vaga',logo:'LOGO'}],candidates:[]};
  let reconciled=0,saved=0;
  const recruitment=load('routes/recruitment.js',{express,fs,path,crypto,'../middleware/require-access':f.auth,'../services/access-email':{},'../services/recruitment-assessment':{},'../services/supervisor':service,'../services/recruitment-view':presentation,'../services/recruitment-store':{load:()=>data,save:()=>saved++,reconcile(org,brokers){assert.equal(org,'org');assert.equal(brokers.length,1);assert.equal(brokers[0].tokenActive,true);assert.equal(brokers[0].profilePhotoUrl,undefined);reconciled++;}}});
  const app=express();app.use(supervisor);app.use(recruitment);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  const get=async path=>{const response=await fetch(url+path,{headers:{'x-access-token':'synthetic-access'}});assert.equal(response.status,200);return response.json();};
  try {
    let result=await get('/api/supervisor/recruitment/updates');assert.ok(result.version);assert.equal(f.calls.length,4);assert.equal(reconciled,0);
    f.calls.length=0;result=await get('/api/supervisor/recruitment');assert.equal(result.vacancy.logo,'LOGO');assert.equal(f.calls.length,5);assert.equal(reconciled,1);assert.equal(saved,0);
    const brokers=f.calls.find(c=>c.table==='users'&&c.method==='select');assert.doesNotMatch(brokers.fields,/photo|sales|last_login|last_used/);assert.ok(brokers.filters.some(([k,v])=>k==='organization_id'&&v==='org'));
    f.calls.length=0;result=await get('/api/supervisor/session');assert.equal(result.user.profilePhotoUrl,'photo');assert.equal(result.user.organization.logoUrl,'logo');assert.equal(f.calls.length,4);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
