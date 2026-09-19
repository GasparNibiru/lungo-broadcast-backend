const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildNotifications,createNotifications}=require('../src/services/notifications');
test('notifications include upcoming unpaid bills and training updates, exclude paid and future bills',()=>{
 const now=new Date('2026-09-19T12:00:00Z');const inputs={trainings:[{id:'t',title:'Novo curso',createdAt:'2026-09-01',updatedAt:'2026-09-19'}],payments:[{id:'late',due_date:'2026-09-18',status:'overdue',expected_amount:50},{id:'today',due_date:'2026-09-19',status:'pending'},{id:'soon',due_date:'2026-09-26',status:'pending'},{id:'future',due_date:'2026-09-27',status:'pending'},{id:'paid',due_date:'2026-09-18',status:'paid'},{id:'cancel',due_date:'2026-09-18',status:'cancelled'}]};
 const items=buildNotifications(inputs,now);assert.equal(items.length,4);assert.equal(items.filter(x=>x.kind==='billing').length,3);assert.ok(items.some(x=>x.title==='Treinamento atualizado'));assert.ok(items.some(x=>x.id.endsWith(':today')));assert.ok(buildNotifications(inputs,new Date('2026-09-20T12:00:00Z')).some(x=>x.id==='payment:today:2026-09-19:late'));
});
test('billing is restricted to supervisor or owner and subscriptions are organization-scoped',async()=>{
 let calls=[];const db={from(table){calls.push(table);const q={select(){return q;},eq(k,v){assert.equal(k,'organization_id');assert.equal(v,'org');return q;},in(k,v){if(k==='subscription_id')assert.deepEqual(v,['sub']);return q;},lte(){return q;},order(){return q;},limit(){return q;},then(resolve){return Promise.resolve({data:table==='subscriptions'?[{id:'sub'}]:[]}).then(resolve);}};return q;}};
 const load=createNotifications({db,isOwner:async()=>false,trainings:async user=>{assert.equal(user.organizationId,'org');return [];}});const broker={id:'b',organizationId:'org',role:'broker'};
 assert.equal((await load(broker)).scope,'org:b');assert.equal(calls.length,0);await load({...broker,role:'supervisor'});assert.deepEqual(calls,['subscriptions','payments']);
 const partial=createNotifications({db,isOwner:async()=>false,trainings:()=>{throw Error('private path');}});assert.deepEqual((await partial(broker)).failed,['Treinamentos']);
});
