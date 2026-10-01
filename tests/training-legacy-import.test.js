const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(failProgress=false){
  const lessons=[
    {id:'global',title:'Global',url:'global',ownerType:'admin',ownerUserId:id(99)},
    {id:'orphan-owner',title:'Team',url:'team',ownerType:'supervisor',organizationId:id(1),ownerUserId:id(99)},
    {id:'valid-owner',title:'Valid',url:'valid',ownerType:'supervisor',organizationId:id(1),ownerUserId:id(3)},
    {id:'cross-owner',title:'Cross',url:'cross',ownerType:'supervisor',organizationId:id(1),ownerUserId:id(4)},
    {id:'foreign-org',title:'Missing org',url:'missing',ownerType:'supervisor',organizationId:id(99),ownerUserId:id(3)}
  ];
  const progress=[
    {trainingId:'orphan-owner',userId:id(3),organizationId:id(1),percent:25},
    {trainingId:'global',userId:id(99),organizationId:id(1)},
    {trainingId:'orphan-owner',userId:id(4),organizationId:id(2)},
    {trainingId:id(99),userId:id(3),organizationId:id(1)}
  ];
  const tables={organizations:[{id:id(1)},{id:id(2)}],users:[{id:id(3),organization_id:id(1)},{id:id(4),organization_id:id(2)}],training_contents:[],training_progress:[],training_data_imports:[]};
  const calls=[];
  const db={from(table){const call={table,filters:[],mode:'select'};calls.push(call);const query={
    select(){return query;},eq(k,v){call.filters.push(row=>row[k]===v);return query;},in(k,values){call.filters.push(row=>values.includes(row[k]));return query;},maybeSingle(){call.single=true;return query;},
    upsert(rows,options){call.mode='upsert';call.rows=rows;call.options=options;return query;},insert(row){call.mode='insert';call.rows=[row];return query;},
    then(resolve,reject){return Promise.resolve().then(()=>{
      if(call.mode==='select'){const rows=tables[table].filter(row=>call.filters.every(f=>f(row)));return {data:call.single?rows[0]||null:rows,error:null};}
      if(table==='training_progress'&&failProgress){failProgress=false;return {error:Error('temporary progress failure')};}
      for(const row of call.rows){
        if(table==='training_contents'){
          assert.ok(!row.owner_user_id||tables.users.some(user=>user.id===row.owner_user_id),'owner FK');
          assert.ok(!row.organization_id||tables.organizations.some(org=>org.id===row.organization_id),'org FK');
        }
        if(table==='training_progress'){
          assert.ok(tables.users.some(user=>user.id===row.user_id),'progress user FK');
          assert.ok(tables.training_contents.some(t=>t.id===row.training_id),'progress training FK');
        }
        const keys=(call.options?.onConflict||'import_key').split(',');
        if(!tables[table].some(existing=>keys.every(k=>existing[k]===row[k])))tables[table].push(row);
      }
      return {error:null};
    }).then(resolve,reject);}
  };return query;}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/training-store.js'),'utf8'),{module,exports:module.exports,process:{env:{NODE_ENV:'staging'}},require(name){return {fs:{existsSync:()=>true,readFileSync:file=>JSON.stringify(file==='lessons'?lessons:progress)},crypto,'../database/supabase':db}[name];}});
  return {store:module.exports,tables,calls,lessons};
}
test('legacy import tolerates absent owners without broadening team visibility or importing orphan progress',async()=>{
  const f=fixture();await f.store.ensureLegacyImported('lessons','progress');
  assert.equal(f.tables.training_contents.length,4);
  const team=f.tables.training_contents.find(t=>t.title==='Team');assert.equal(team.owner_user_id,null);assert.equal(team.organization_id,id(1));assert.equal(team.owner_type,'supervisor');
  assert.equal(f.tables.training_contents.find(t=>t.title==='Valid').owner_user_id,id(3));
  assert.equal(f.tables.training_contents.find(t=>t.title==='Cross').owner_user_id,null);
  assert.equal(f.tables.training_progress.length,1);assert.equal(f.tables.training_progress[0].percent,25);
  assert.equal(f.tables.training_data_imports.length,1);
  assert.equal(f.lessons[1].ownerUserId,id(99),'source records unchanged');
  const before=f.calls.length;await f.store.ensureLegacyImported('lessons','progress');assert.equal(f.calls.length,before+1,'completed import only checks marker');
});
test('retry after partial import reuses lesson IDs and does not duplicate contents',async()=>{
  const f=fixture(true);await assert.rejects(f.store.ensureLegacyImported('lessons','progress'),/temporary/);
  const ids=f.tables.training_contents.map(t=>t.id);assert.equal(f.tables.training_data_imports.length,0);
  await f.store.ensureLegacyImported('lessons','progress');assert.deepEqual(f.tables.training_contents.map(t=>t.id),ids);assert.equal(f.tables.training_progress.length,1);assert.equal(f.tables.training_data_imports.length,1);
});
