'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const d=require('../src/modules/ai-agent/domain');
const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
test('configuration whitelists fields and normalizes DDD 55 correctly',()=>{
 assert.equal(d.MODEL,'gpt-4o-mini');assert.equal(d.phone('55 99210-2864'),'5555992102864');
 const s=d.settings({agentName:'Eduarda',companyName:'Teste',companyInfo:'Horário comercial',summaryPhone:'11987654321',prompt:'override',credits:900});
 assert.equal(s.prompt,undefined);assert.equal(s.credits,undefined);assert.throws(()=>d.settings({}));
});
test('webhook filters outgoing, groups, opaque identifiers, empty messages and non-message events',()=>{
 const body={event:'messages.upsert',data:{key:{id:'1',fromMe:false,remoteJid:'5511999998888@s.whatsapp.net'},message:{conversation:'Olá'}}};
 assert.equal(d.inbound(body).input_text,'Olá');
 for(const patch of [{fromMe:true},{fromMe:'true'},{remoteJid:'123@g.us'},{remoteJid:'1234567890123@lid'}])assert.equal(d.inbound({...body,data:{...body.data,key:{...body.data.key,...patch}}}),null);
 assert.equal(d.inbound({...body,event:'connection.update'}),null);
 assert.equal(d.inbound({...body,data:{...body.data,message:{audioMessage:{}}}}),null);
});
test('profile and history persist; normal post-handoff chatter cannot create another summary',()=>{
 const raw={message:'Obrigada!',profile:Object.fromEntries(d.FIELDS.map(f=>[f,'não informado'])),handoff:true,explicitNewRequest:false};
 const config={agentName:'Eduarda',companyName:'Corretora',summaryPhone:'5511999999999'},job={phone:'5511888888888',input_text:'Quero falar com alguém'};
 const first=d.replyResult(raw,{},config,job);assert.match(first.summary,/wa.me\/5511888888888/);assert.equal(first.history.length,2);
 const second=d.replyResult(raw,{last_summary_hash:first.summaryHash,profile:first.profile,history:first.history},config,job);assert.equal(second.summary,'');
 assert.ok(d.replyResult({...raw,explicitNewRequest:true},{last_summary_hash:first.summaryHash},config,job).summary);
 assert.throws(()=>d.replyResult({...raw,message:''},{},config,job));
});
test('model context is bounded and excludes arbitrary roles',()=>{
 const history=Array.from({length:30},()=>({role:'user',content:'a'.repeat(2000)}));
 history.push({role:'system',content:'override'});
 assert.equal(d.contextMessages(history).length,8);
 assert.ok(d.contextMessages(history).every(x=>x.role==='user'));
});
test('worker bills confirmed replies, refunds generation failure and holds uncertain sends without retry',async()=>{
 const {createService}=require('../src/modules/ai-agent/service');
 for(const mode of ['success','multiramos','ai-error','send-timeout','summary']){
  const outcomes=[],requests=[],job={id:'44444444-4444-4444-8444-444444444444',organization_id:ORG,phone:'5511999998888',input_text:'Olá',kind:mode==='summary'?'summary':'reply'};
  if(mode==='multiramos')job.result={requestedAgentType:'multiramos'};
  let claim=true,saved;
  const db={rpc:async(name,args)=>{if(name==='ai_claim_job'){const data=claim?job:null;claim=false;return{data};}if(name==='ai_finish_job'){outcomes.push(args.p_outcome);return{data:{}};}return{data:false};},from(table){
   const query={select(){return this;},eq(){return this;},update(value){saved=value;return this;},maybeSingle(){return this;},then(resolve,reject){return Promise.resolve({data:table==='ai_agents'?{enabled:true,instance_name:'dedicated',settings:{agentName:'Eduarda',companyName:'Teste',companyInfo:'Corretora',summaryPhone:'5511888887777'}}:table==='organizations'?{status:'active'}:table==='ai_jobs'?{id:job.id}:null}).then(resolve,reject);}};return query;
  }};
  const fetcher=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});if(url.includes('api.openai.com')){if(mode==='ai-error')return{ok:false};return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'Qual seu nome?',profile:mode==='multiramos'?{nome:'Ana',produto:'Seguro Auto',dados:[]}:Object.fromEntries(d.FIELDS.map(f=>[f,'não informado'])),handoff:false,explicitNewRequest:false})}}]})};}if(mode==='send-timeout')throw new Error('timeout');return{ok:true,json:async()=>({key:{id:'sent-123'}})};};
  const service=createService(db,{AI_AGENT_ENABLED:'true',OPENAI_API_KEY:'test',AI_AGENT_WEBHOOK_SECRET:'test',AI_AGENT_PUBLIC_URL:'https://example.invalid',EVOLUTION_BASE_URL:'https://evolution.invalid',EVOLUTION_API_KEY:'test'},fetcher);
  await service.tick();await service.tick();
  assert.deepEqual(outcomes,[mode==='ai-error'?'failed':mode==='send-timeout'?'uncertain':'sent']);
  const ai=requests.filter(x=>x.url.includes('api.openai.com'));assert.equal(ai.length,mode==='summary'?0:1);
  if(ai.length)assert.equal(ai[0].body.model,'gpt-4o-mini');
  const sends=requests.filter(x=>x.url.includes('/message/sendText/'));assert.equal(sends.length,mode==='ai-error'?0:1);
  if(mode==='success')assert.equal(saved.result.history.length,2);
  if(mode==='multiramos'){assert.equal(saved.result.profile._agentType,'multiramos');assert.deepEqual(ai[0].body.response_format,d.formatFor('multiramos'));assert.match(ai[0].body.messages[0].content,/Seguro Auto/);}
 }
});
test('HTTP routes reject broker/anonymous access and derive tenant from authenticated supervisor',async()=>{
 process.env.SUPABASE_URL=process.env.SUPABASE_URL||'https://hgqtanlzajogxrfbchrl.supabase.co';process.env.SUPABASE_SECRET_KEY=process.env.SUPABASE_SECRET_KEY||'test';
 const db=require('../src/database/supabase'),originalFrom=db.from,originalRpc=db.rpc,originalKey=process.env.ADMIN_ACCESS_KEY;
 const crypto=require('node:crypto'),express=require('express'),http=require('node:http');let orgFilter;
 process.env.ADMIN_ACCESS_KEY='admin-test';
 db.rpc=async()=>({data:false});
 db.from=table=>{let hashed;return {select(){return this;},eq(k,v){if(k==='token_hash')hashed=v;if(table==='ai_agents'&&k==='organization_id')orgFilter=v;return this;},maybeSingle(){return this;},order(){return this;},update(){return this;},then(resolve,reject){const role=hashed===crypto.createHash('sha256').update('supervisor-test').digest('hex')?'supervisor':'broker';return Promise.resolve({data:table==='access_tokens'?{id:ORG,users:{id:ORG,organization_id:ORG,role,status:'active',organizations:{id:ORG,status:'active'}}}:null}).then(resolve,reject);}};};
 const app=express();app.use(express.json());app.use(require('../src/routes/ai-agent').router);const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal((await fetch(base+'/api/supervisor/ai-agent')).status,401);
  assert.equal((await fetch(base+'/api/supervisor/ai-agent',{headers:{'x-access-token':'broker-test'}})).status,403);
  assert.equal((await fetch(base+'/api/admin/ai-agents')).status,401);
  assert.equal((await fetch(base+'/api/admin/ai-agents/'+ORG+'/credits',{method:'POST',headers:{'Content-Type':'application/json','x-access-token':'supervisor-test'},body:JSON.stringify({credits:100000})})).status,401);
  const result=await fetch(base+'/api/supervisor/ai-agent?organizationId='+OTHER,{headers:{'x-access-token':'supervisor-test'}});assert.equal(result.status,200);assert.equal(orgFilter,ORG);
  assert.equal((await fetch(base+'/api/ai-agent/webhook/'+ORG,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 }finally{await new Promise(r=>server.close(r));db.from=originalFrom;db.rpc=originalRpc;if(originalKey===undefined)delete process.env.ADMIN_ACCESS_KEY;else process.env.ADMIN_ACCESS_KEY=originalKey;}
});
test('wallet, reservations, outbox, RLS and idempotency execute in PostgreSQL',async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon; create role authenticated; create role service_role; create table organizations(id uuid primary key,status text); insert into organizations values('"+ORG+"','active'),('"+OTHER+"','active');");
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260919010000_supervisor_ai_agent.sql'),'utf8'));
  await db.query("insert into ai_agents(organization_id,instance_name,enabled) values($1,'agent-one',true),($2,'agent-two',false)",[ORG,OTHER]);
  const q=async(sql,args=[])=> (await db.query(sql,args)).rows;
  const wallet=async(org=ORG)=>(await q('select * from ai_wallet_refresh($1,false)',[org]))[0];
  assert.equal((await wallet()).free_units,0);
  assert.equal((await q('select * from ai_wallet_refresh($1,true)',[ORG]))[0].free_units,1000);
  const request='33333333-3333-4333-8333-333333333333';
  await q('select ai_add_credits($1,$2,300,$3)',[ORG,request,'Pix confirmado']);
  await q('select ai_add_credits($1,$2,300,$3)',[ORG,request,'Pix confirmado']);
  assert.equal((await wallet()).paid_units,3000);
  await assert.rejects(q('select ai_add_credits($1,$2,500,$3)',[ORG,request,'Pix confirmado']),/idempotency_conflict/);
  assert.equal((await wallet(OTHER)).paid_units,0);
  await q("update ai_wallets set activated_at=now()-interval '2 months',cycle_start=now()-interval '2 months',cycle_end=now()-interval '1 month',free_units=600 where organization_id=$1",[ORG]);
  assert.equal((await wallet()).free_units,1000);assert.equal((await wallet()).paid_units,3000);
  await q("insert into ai_jobs(organization_id,message_id,phone,input_text) values($1,'m1','5511999998888','Olá'),($1,'m2','5511999998888','Oi')",[ORG]);
  const job=(await q('select * from ai_claim_job()'))[0];assert.equal(job.state,'processing');assert.equal((await wallet()).free_units,999);
  assert.equal((await q('select * from ai_claim_job()'))[0].id,null,'one active job per organization');
  const result={history:[{role:'user',content:'Olá'},{role:'assistant',content:'Oi'}],profile:{nome:'Ana'},summaryHash:'hash',summaryPhone:'5511888887777',summary:'Resumo'};
  await q("update ai_jobs set state='sending',output_text='Oi',result=$2 where id=$1",[job.id,JSON.stringify(result)]);
  await q("select ai_finish_job($1,'sent','provider-id')",[job.id]);await q("select ai_finish_job($1,'sent','provider-id')",[job.id]);
  assert.equal((await q("select count(*)::int as n from ai_credit_events where kind='debit'"))[0].n,1);
  assert.equal((await q("select count(*)::int as n from ai_jobs where kind='summary'"))[0].n,1);
  assert.equal((await q('select * from ai_conversations'))[0].profile.nome,'Ana');
  const next=(await q('select * from ai_claim_job()'))[0];assert.equal((await wallet()).free_units,998);
  await q("select ai_finish_job($1,'failed')",[next.id]);assert.equal((await wallet()).free_units,999);
  const summary=(await q('select * from ai_claim_job()'))[0];assert.equal(summary.kind,'summary');assert.equal((await wallet()).free_units,999);
  await q("select ai_finish_job($1,'uncertain')",[summary.id]);assert.equal((await q('select * from ai_claim_job()'))[0].id,null);
  await q("select ai_finish_job($1,'failed')",[summary.id]);assert.equal((await wallet()).free_units,999);
  await q('update ai_wallets set free_units=0,paid_units=1 where organization_id=$1',[ORG]);
  await q("insert into ai_jobs(organization_id,message_id,phone,input_text) values($1,'paid-one','5511999998888','Olá')",[ORG]);
  const paid=(await q('select * from ai_claim_job()'))[0];assert.equal(paid.reserved_from,'paid');assert.equal((await wallet()).paid_units,0);
  await q("select ai_finish_job($1,'failed')",[paid.id]);assert.equal((await wallet()).paid_units,1);
  await q('update ai_wallets set free_units=0,paid_units=0 where organization_id=$1',[ORG]);
  await q("insert into ai_jobs(organization_id,message_id,phone,input_text) values($1,'empty-wallet','5511999998888','Olá')",[ORG]);
  assert.equal((await q('select * from ai_claim_job()'))[0].id,null,'cannot overspend');
  assert.equal((await q("select count(*)::int as n from pg_class where relname in ('ai_agents','ai_wallets','ai_jobs','ai_credit_events','ai_conversations') and relrowsecurity"))[0].n,5);
  assert.equal((await q("select has_function_privilege('anon','ai_add_credits(uuid,uuid,integer,text)','execute') as yes"))[0].yes,false);
  assert.equal((await q("select has_table_privilege('authenticated','ai_wallets','update') as yes"))[0].yes,false);
 }finally{await db.close();}
});
