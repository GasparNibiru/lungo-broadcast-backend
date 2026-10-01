'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const trainingId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const hiddenId = '10000000-0000-4000-8000-000000000003';
function load(file, dependencies) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), {
    module, exports:module.exports, require(name) { if (!(name in dependencies)) throw Error(name); return dependencies[name]; },
    process:{env:{}}, __dirname:__dirname, URL
  }); return module.exports;
}
test('manual confirmations are idempotent, scoped, server dated and omit playback payloads', async () => {
  const records = [], calls = [];
  const db = {from(table) {
    assert.equal(table,'training_confirmations');
    const call={filters:[]}; calls.push(call);
    const query={select(fields){call.fields=fields;return query;},eq(k,v){call.filters.push([k,v]);return query;},order(){return query;},
      upsert(row,options){call.row=row;call.options=options;return query;},then(resolve,reject){
        if(call.row){assert.equal(call.options.ignoreDuplicates,true);assert.equal(call.row.confirmed_at,undefined);
          assert.equal(call.options.onConflict,'training_id,user_id,organization_id');
          if(!records.some(r=>r.training_id===call.row.training_id&&r.user_id===call.row.user_id&&r.organization_id===call.row.organization_id)) records.push({...call.row,confirmed_at:'2026-10-02T12:00:00Z'});
          return Promise.resolve({error:null}).then(resolve,reject);
        }
        return Promise.resolve({data:records.filter(r=>call.filters.every(([k,v])=>r[k]===v)),error:null}).then(resolve,reject);
      }};return query;
  }};
  const store=load('services/training-confirmations.js',{'../database/supabase':db});
  const user={id:'broker',name:'Nome',organizationId:'org',role:'broker'};
  await assert.rejects(store.confirm(trainingId,{...user,role:'supervisor'}), error=>error.statusCode===403);
  assert.equal(calls.length,0);
  const [first,second]=await Promise.all([store.confirm(trainingId,user),store.confirm(trainingId,user)]);
  assert.equal(records.length,1);assert.equal(first.confirmedAt,second.confirmedAt);
  assert.equal((await store.list({organizationId:'foreign'})).length,0);
  await store.confirm(trainingId,{...user,organizationId:'foreign'});
  assert.equal((await store.list({organizationId:'foreign'})).length,1);
  assert.equal((await store.list({organizationId:'org'})).length,1);
  assert.equal(first.percent,undefined);
  assert.ok(calls.filter(c=>c.fields).every(c=>!c.fields.includes('*')));
});

test('confirmation API requires explicit declaration, enforces visibility/identity and retires automatic writes', async () => {
  const users={broker:{id:'b',name:'Broker',role:'broker',organizationId:'org'},supervisor:{id:'s',name:'Supervisor',role:'supervisor',organizationId:'org'},foreign:{id:'f',name:'Foreign',role:'supervisor',organizationId:'other'}};
  const rows=new Map(), writes=[], reads=[];
  const trainings=[{id:trainingId,title:'Global',active:true,ownerType:'admin'}, {id:foreignId,title:'Other',active:true,ownerType:'supervisor',organizationId:'other'}, {id:hiddenId,active:false,ownerType:'admin'}];
  const confirmationStore={async confirm(id,user){writes.push({id,user});const key=id+user.id;if(!rows.has(key))rows.set(key,{trainingId:id,userId:user.id,userName:user.name,userRole:user.role,organizationId:user.organizationId,confirmedAt:'2026-10-02T12:00:00Z'});return rows.get(key);},async list(filters){reads.push(filters);return [...rows.values()].filter(row=>Object.entries(filters).every(([k,v])=>row[k]===v));}};
  const auth={requireAccess(roles){return (req,res,next)=>{const user=users[req.headers['x-access-token']];if(!user)return res.sendStatus(401);if(![].concat(roles).includes(user.role))return res.sendStatus(403);req.accessUser=user;next();};}};
  const router=load('routes/trainings-v2-db.js',{express,path,'../middleware/require-admin':(_req,res)=>res.sendStatus(403),'../middleware/require-access':auth,'../database/supabase':{},'../services/access-email':{},'../services/training-confirmations':confirmationStore,
    '../services/training-store':{ensureLegacyImported:async()=>{},getTraining:async id=>trainings.find(t=>t.id===id),listTrainings:async()=>trainings,listProgress:async()=>{throw Error('legacy progress must not be read');},saveProgress:async()=>{throw Error('automatic progress must not be saved');}}});
  const app=express();app.use(express.json(),router);app.use((error,req,res,next)=>res.status(500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(url,{token='broker',body,method=body?'POST':'GET'}={})=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/training-center${url}`,{method,headers:{'x-access-token':token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json().catch(()=>null)};
  };
  try{
    assert.equal((await request(`/${trainingId}/confirm`,{token:'',body:{confirmed:true}})).status,401);
    assert.equal((await request(`/${trainingId}/confirm`,{token:'supervisor',body:{confirmed:true}})).status,403);
    const readsBefore=reads.length;
    const supervisorLibrary=await request('',{token:'supervisor'});
    assert.equal(supervisorLibrary.status,200);assert.equal(supervisorLibrary.data.trainings[0].confirmation,null);
    assert.equal(reads.length,readsBefore,'supervisor library does not query own confirmations');
    assert.equal((await request(`/${trainingId}/confirm`,{body:{confirmed:false}})).status,400);
    for(const id of [foreignId,hiddenId])assert.equal((await request(`/${id}/confirm`,{body:{confirmed:true}})).status,404);
    assert.equal((await request('/bad/confirm',{body:{confirmed:true}})).status,400);
    assert.equal((await request(`/${trainingId}/progress`,{body:{duration:100,currentTime:100}})).status,410);
    assert.equal(writes.length,0);
    let result=await request(`/${trainingId}/confirm`,{body:{confirmed:true,userId:'fake',organizationId:'other',confirmedAt:'1900-01-01'}});
    assert.equal(result.status,200);assert.equal(writes[0].user.id,'b');assert.equal(result.data.confirmation.confirmedAt,'2026-10-02T12:00:00Z');
    result=await request('');assert.equal(result.data.trainings.length,1);assert.equal(result.data.trainings[0].confirmation.confirmedAt,'2026-10-02T12:00:00Z');assert.equal(result.data.trainings[0].progress,undefined);
    result=await request(`/${trainingId}/metrics`,{token:'supervisor'});assert.equal(result.status,404);
    result=await request(`/supervisor/${trainingId}/metrics`,{token:'supervisor'});assert.equal(result.data.viewers.length,1);assert.equal(result.data.viewers[0].userName,'Broker');
    result=await request(`/supervisor/${trainingId}/metrics`,{token:'foreign'});assert.equal(result.data.viewers.length,0);
    assert.equal((await request(`/supervisor/${foreignId}/metrics`,{token:'supervisor'})).status,404);
    assert.equal((await request(`/supervisor/${trainingId}/metrics`,{token:'broker'})).status,403);
    assert.ok(reads.some(f=>f.organizationId==='org'&&f.userRole==='broker'));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
