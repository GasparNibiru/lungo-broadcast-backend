const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const store=require('../src/services/recruitment-store');
test('reconcile legacy granted access and remove linked recruitment only inside organization',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-link-')),old=process.env.RECRUITMENT_FILE_PATH;process.env.RECRUITMENT_FILE_PATH=path.join(dir,'data.json');
 try {
 const broker={id:'b',name:'Maria',email:'m@example.com',phone:'11999999999',tokenActive:true,createdAt:'2026-09-20T10:00:00Z'};
 const candidate={id:'c',organizationId:'org',name:'Maria',email:'m@example.com',hirePending:true,stage:'aprovado'};
 store.save({vacancies:[],candidates:[candidate,{...candidate,id:'foreign',organizationId:'other'}]});
 store.reconcile('org',[broker]);let data=store.load();assert.equal(data.candidates[0].hiredUserId,'b');assert.equal(data.candidates[0].hirePending,false);assert.equal(data.candidates[0].accessGrantedAt,broker.createdAt);assert.equal(data.candidates[1].hiredUserId,undefined);
 store.removeBroker('org',broker);assert.equal(store.load().candidates.length,2);assert.ok(store.load().candidates[0].accessRemovedAt);assert.equal(store.load().candidates[0].dismissedAt,undefined);
 store.save({vacancies:[],candidates:[candidate]});store.removeBroker('org',broker);assert.equal(store.load().candidates.length,1);assert.equal(store.load().candidates[0].hiredUserId,'b');
 store.save({vacancies:[],candidates:[{...candidate,dismissedAt:'2026-09-20',phone:'11999999999'}]});assert.equal(store.blocked(store.load(),'org','M@example.com',''),true);assert.equal(store.blocked(store.load(),'org','','(11) 99999-9999'),true);assert.equal(store.blocked(store.load(),'other','m@example.com','11999999999'),false);
 store.save({vacancies:[],candidates:[candidate,{...candidate,id:'duplicate'}]});store.reconcile('org',[broker]);assert.ok(store.load().candidates.every(c=>!c.hiredUserId));
 store.removeBroker('org',broker);assert.equal(store.load().candidates.length,2);
 }finally {if(old===undefined)delete process.env.RECRUITMENT_FILE_PATH;else process.env.RECRUITMENT_FILE_PATH=old;fs.rmSync(dir,{recursive:true,force:true});}
});
