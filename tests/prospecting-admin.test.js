'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createAdminService } = require('../src/modules/prospecting/admin');
const { createAdminRouter } = require('../src/routes/prospecting-admin');
let db, server, base, id, org;
const calls = [];
const adapter = {
  async rpc(name, args) {
    calls.push(args);
    try { return { data: (await db.query(`SELECT ${name}($1,$2,$3,$4,$5) AS result`, Object.values(args))).rows[0].result }; }
    catch(e) { return { error: { message:e.message } }; }
  },
  from(table) {
    assert(['users','prospecting_wallets','prospecting_token_movements'].includes(table));
    const filters = []; let start = 0, end = 9999, single = false;
    const q = { select(){return q;}, eq(k,v){filters.push(r=>r[k]===v);return q;}, in(k,vs){filters.push(r=>vs.includes(r[k]));return q;}, order(){return q;}, range(a,b){start=a;end=b;return q;}, maybeSingle(){single=true;return q;},
      async then(resolve,reject) { try {
        let rows = (await db.query(table === 'users' ? "SELECT u.*, 'Pessoa Teste' AS name, 'teste@example.com' AS email, jsonb_build_object('name','Corretora','status',o.status) AS organizations FROM users u JOIN organizations o ON o.id=u.organization_id" : `SELECT * FROM ${table}`)).rows;
        rows=rows.filter(r=>filters.every(f=>f(r)));const count=rows.length;rows=rows.slice(start,end+1);resolve({data:single?rows[0]||null:rows,count});
      } catch(e){reject(e);} }
    };return q;
  }
};
const service = createAdminService({getDb:()=>adapter});
before(async()=>{
  db=new PGlite();await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/prospecting.sql'),'utf8'));
  id=randomUUID();org=randomUUID();await db.query('INSERT INTO organizations(id) VALUES($1)',[org]);await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'broker')",[id,org]);
  process.env.ADMIN_ACCESS_KEY='synthetic-admin-only';
  const app=express();app.use(express.json());app.use(createAdminRouter({service}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(r=>server.close(r));await db.close();delete process.env.ADMIN_ACCESS_KEY;});
test('all administration routes reject missing/wrong admin credentials including broker access',async()=>{
  for(const suffix of ['/users',`/users/${id}`,`/users/${id}/credits`])for(const admin of ['', 'broker-token']){
    const r=await fetch(base+'/api/admin/prospecting'+suffix,{method:suffix.endsWith('credits')?'POST':'GET',headers:{'x-admin-key':admin,'x-access-token':'broker-token'}});
    assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
  assert.equal(calls.length,0);
});
test('list and detail do not initialize wallets or renew free credits',async()=>{
  const data=await service.list();assert.equal(data.users[0].wallet,null);
  assert.equal((await service.detail(id)).wallet,null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM prospecting_wallets')).rows[0].n,0);
  assert.equal(calls.length,0);
});
test('invalid amounts, reasons, users and pages cannot write credits',async()=>{
  const body={amount:10,reason:'Teste',requestId:randomUUID()};
  for(const amount of [0,-1,1.5,'10',1000001])await assert.rejects(service.credit(id,{...body,amount}));
  await assert.rejects(service.credit(id,{...body,reason:' '}));await assert.rejects(service.credit(id,{...body,requestId:'bad'}));
  await assert.rejects(service.credit('bad',body));await assert.rejects(service.list({page:'-1'}));
  assert.equal(calls.length,0);
});
test('real SQL credits once on concurrent/repeated requests and rejects changed payload',async()=>{
  const body={amount:37,reason:'Compra teste',requestId:randomUUID(),adminReference:'untrusted'};
  const responses=await Promise.all([service.credit(id,body),service.credit(id,body)]);assert.deepEqual(responses[0],responses[1]);
  const w=(await db.query('SELECT * FROM prospecting_wallets WHERE user_id=$1',[id])).rows[0];assert.equal(Number(w.extra_balance),37);assert.equal(Number(w.free_balance),0);
  const history=await service.detail(id);assert.equal(history.movements.length,1);assert.equal(Number(history.movements[0].delta),37);
  assert(calls.every(c=>c.p_admin_reference==='admin-master'));
  await assert.rejects(service.credit(id,{...body,amount:38}),{statusCode:409});
  const operation=(await db.query('SELECT actor_reference FROM prospecting_operations')).rows[0];assert.equal(operation.actor_reference,'admin-master');
});
test('inactive user or organization cannot receive credits',async()=>{
  const body={amount:10,reason:'Teste',requestId:randomUUID()};const count=calls.length;
  await db.query("UPDATE users SET status='inactive' WHERE id=$1",[id]);await assert.rejects(service.credit(id,body),{statusCode:409});
  await db.query("UPDATE users SET status='active' WHERE id=$1",[id]);await db.query("UPDATE organizations SET status='inactive' WHERE id=$1",[org]);await assert.rejects(service.credit(id,body),{statusCode:409});assert.equal(calls.length,count);
});
