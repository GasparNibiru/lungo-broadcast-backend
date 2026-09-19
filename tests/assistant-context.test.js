const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarize,createContext}=require('../src/services/assistant-context');
const supervisor={id:'s',organizationId:'org',role:'supervisor'};
const fixtures={users:[{id:'b',role:'broker',status:'active',name:'B'},{id:'off',role:'broker',status:'inactive'}],leads:[
 {id:'one',brokerUserId:'b',status:'fechamento',valorNegocio:'1.200,50',closedAt:'2026-09-03T12:00:00Z'},
 {id:'two',brokerUserId:'s',nome:'Maior histórico',status:'fechamento',valorNegocio:9000,closedAt:'2024-02-01T12:00:00Z'},
 {id:'three',brokerUserId:'s',status:'fechamento',valorNegocio:100,updatedAt:'2026-09-01'},
 {id:'cancel',brokerUserId:'b',status:'fechamento',valorNegocio:999999},
 {id:'other',brokerUserId:'foreign',status:'fechamento',valorNegocio:9999999},
 {id:'off',brokerUserId:'off',status:'fechamento',valorNegocio:9999999},
 {id:'open',brokerUserId:'b',status:'novo',valorNegocio:9999999}
 ],sales:[{id:'f',source_kind:'lead_closing',source_id:'one',seller_user_id:'b',client_name:'Financeiro',sale_amount:1200.5,closed_at:'2026-09-03T12:00:00Z',status:'pending'},{id:'c',source_kind:'lead_closing',source_id:'cancel',sale_amount:999999,status:'cancelled'}],receivables:[]};
test('all-time highest, cancellation, deduplication, monthly totals and broker isolation',()=>{
 const data=summarize(supervisor,fixtures,new Date('2026-09-19T12:00:00Z'));
 assert.equal(data.sales.highest[0].client,'Maior histórico');assert.equal(data.sales.highest[0].amount,9000);assert.equal(data.sales.count,3);assert.equal(data.sales.monthValue,1200.5);assert.equal(data.sales.withoutClosingDate,1);assert.equal(data.team.count,1);assert.equal(data.team.members[0].salesThisMonth,1);
 const broker=summarize({...supervisor,id:'s',role:'broker'},fixtures);assert.equal(broker.team,undefined);assert.equal(broker.finance,undefined);assert.equal(broker.sales.count,2);
});
test('database reads enforce organization, paginate beyond 1000, exclude secrets and skip supervisor tables for brokers',async()=>{
 const calls=[];const db={from(table){let filters=[],start=0;const q={select(columns){assert.ok(!columns.includes('*'));return q;},eq(k,v){filters.push([k,v]);return q;},order(){return q;},range(a){start=a;calls.push({table,filters,start});assert.ok(filters.some(([k,v])=>k==='organization_id'&&v==='org'));return Promise.resolve({data:table==='finance_sales'&&start===0?Array.from({length:1000},(_,i)=>({id:String(i),sale_amount:1,status:'pending'})):table==='finance_sales'?[{id:'last',client_name:'Beyond first page',sale_amount:20000,status:'pending'}]:[]});}};return q;}};
 const legacy={organizationLeads:async org=>{assert.equal(org,'org');return [];}};
 const loader=createContext({db,legacy});const data=await loader(supervisor);assert.equal(data.sales.highest[0].client,'Beyond first page');assert.ok(calls.some(x=>x.start===1000));calls.length=0;await loader({...supervisor,role:'broker'});assert.equal(calls.length,0);
});
