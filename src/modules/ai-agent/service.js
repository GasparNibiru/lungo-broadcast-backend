'use strict';
const crypto = require('node:crypto');
const d = require('./domain');
function createService(db, env = process.env, fetcher = fetch) {
  const take = result => { if(result.error) throw d.error('Não foi possível acessar os dados do agente. Verifique a implantação do módulo.',503); return result.data; };
  const rpc = async (name,args) => take(await db.rpc(name,args));
  const find = async org => take(await db.from('ai_agents').select('*').eq('organization_id',org).maybeSingle());
  const secret = org => crypto.createHmac('sha256',env.AI_AGENT_WEBHOOK_SECRET || '').update(org).digest('hex');
  const readiness = () => ({ ai:Boolean(env.OPENAI_API_KEY), evolution:Boolean(env.EVOLUTION_BASE_URL && env.EVOLUTION_API_KEY), webhook:Boolean(env.AI_AGENT_WEBHOOK_SECRET && env.AI_AGENT_PUBLIC_URL), worker:env.AI_AGENT_ENABLED === 'true' });
  function requireReady() { if(Object.values(readiness()).some(v=>!v)) throw d.error('A conexão do agente ainda depende da configuração do servidor.',503); }
  async function evolution(method,route,body) {
    if(!env.EVOLUTION_BASE_URL || !env.EVOLUTION_API_KEY) throw d.error('Conexão WhatsApp indisponível no servidor.',503);
    const response = await fetcher(env.EVOLUTION_BASE_URL.replace(/\/+$/,'')+route,{method,headers:{apikey:env.EVOLUTION_API_KEY,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    let data; try { data=await response.json(); } catch { data={}; }
    if(!response.ok) throw Object.assign(d.error('Não foi possível completar a operação no WhatsApp.',502),{providerStatus:response.status});
    return data;
  }
  async function status(org) {
    const agent=await find(org), wallet=agent?await rpc('ai_wallet_refresh',{p_org:org,p_activate:false}):null;
    const events=agent?take(await db.from('ai_credit_events').select('id,kind,units,note,created_at').eq('organization_id',org).order('created_at',{ascending:false}).limit(30)):[];
    const pending=agent?take(await db.from('ai_jobs').select('id,state').eq('organization_id',org).in('state',['uncertain']).limit(1)):[];
    return {agent:agent?{settings:agent.settings,enabled:agent.enabled}:null,wallet:d.walletView(wallet),events,needsReview:pending.length>0,readiness:readiness(),packages:d.PACKAGES,supportPhone:'5555992102864',model:d.MODEL};
  }
  async function save(org,body) {
    const config=d.settings(body),current=await find(org);
    if(current?.enabled) throw d.error('Pause o agente antes de editar sua configuração.',409);
    if(current) take(await db.from('ai_agents').update({settings:config,updated_at:new Date().toISOString()}).eq('organization_id',org));
    else take(await db.from('ai_agents').insert({organization_id:org,settings:config,instance_name:`lungo_ai_${env.APP_ENV==='staging'?'stg':'prd'}_${org.replace(/-/g,'')}`}));
    return status(org);
  }
  async function connection(org,connect=false) {
    const agent=await find(org);if(!agent)throw d.error('Salve a configuração antes de conectar.');
    const name=encodeURIComponent(agent.instance_name);
    let state;
    try { state=await evolution('GET',`/instance/connectionState/${name}`); }
    catch(e) {if(![404,400].includes(e.providerStatus))throw e;state={instance:{state:'close'}};if(connect){
      requireReady();
      try {await evolution('POST','/instance/create',{instanceName:agent.instance_name,integration:'WHATSAPP-BAILEYS',qrcode:true});}catch(createError){if(createError.providerStatus!==409)throw createError;}
    }}
    const connected=state.instance?.state==='open';
    if(connect){
      requireReady();
      const url=new URL(`/api/ai-agent/webhook/${org}`,env.AI_AGENT_PUBLIC_URL);
      if(url.protocol!=='https:')throw d.error('Configure um endereço HTTPS para o agente.',503);
      await evolution('POST',`/webhook/set/${name}`,{webhook:{enabled:true,url:url.href,byEvents:false,base64:false,headers:{'x-agent-secret':secret(org)},events:['MESSAGES_UPSERT']}});
    }
    if(connected || !connect)return {connected,state:state.instance?.state || 'close'};
    const qr=await evolution('GET',`/instance/connect/${name}`);
    return {connected:false,state:'connecting',qrCodeBase64:qr.base64||qr.qrcode?.base64||null,qrCode:qr.code||qr.qrcode?.code||null};
  }
  async function enable(org,enabled) {
    if(typeof enabled!=='boolean')throw d.error('Estado inválido.');
    const agent=await find(org);if(!agent)throw d.error('Salve a configuração primeiro.');
    if(enabled){ requireReady(); d.settings(agent.settings);const c=await connection(org);if(!c.connected)throw d.error('Conecte o WhatsApp dedicado antes de ativar.',409);await rpc('ai_wallet_refresh',{p_org:org,p_activate:true}); }
    take(await db.from('ai_agents').update({enabled,updated_at:new Date().toISOString()}).eq('organization_id',org));return status(org);
  }
  async function receive(org,provided,body) {
    const expected=Buffer.from(secret(org)), token=Buffer.from(String(provided||''));
    if(!env.AI_AGENT_WEBHOOK_SECRET || token.length!==expected.length || !crypto.timingSafeEqual(token,expected))throw d.error('Não autorizado.',401);
    if(env.AI_AGENT_ENABLED!=='true')return;
    const agent=await find(org);
    if(!agent?.enabled || body.instance!==agent.instance_name)return;
    const incoming=d.inbound(body);if(!incoming || incoming.phone===agent.settings.summaryPhone)return;
    const organization=take(await db.from('organizations').select('status').eq('id',org).maybeSingle());if(organization?.status!=='active')return;
    const wallet=await rpc('ai_wallet_refresh',{p_org:org,p_activate:false});
    if(!wallet || wallet.free_units+wallet.paid_units<1)return;
    take(await db.from('ai_jobs').upsert({...incoming,organization_id:org},{onConflict:'organization_id,message_id',ignoreDuplicates:true}));
  }
  async function generate(agent,conversation,job) {
    const response=await fetcher('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({model:d.MODEL,store:false,temperature:0.3,max_completion_tokens:1500,response_format:d.responseFormat,messages:[{role:'system',content:d.prompt(agent.settings,conversation)},...d.contextMessages(conversation.history),{role:'user',content:job.input_text}]})});
    if(!response.ok)throw d.error('Falha no serviço de IA.',502);
    const data=await response.json(),choice=data.choices?.[0];
    if(choice?.finish_reason!=='stop' || choice.message?.refusal)throw d.error('Resposta de IA indisponível.',502);
    let output;try{output=JSON.parse(choice.message.content);}catch{throw d.error('Resposta inválida do modelo.',502);}
    return {...d.replyResult(output,conversation,agent.settings,job),usage:{model:d.MODEL,inputTokens:Number(data.usage?.prompt_tokens||0),outputTokens:Number(data.usage?.completion_tokens||0)}};
  }
  async function tick() {
    if(Object.values(readiness()).some(v=>!v))return;
    const job=await rpc('ai_claim_job',{});if(!job?.id)return;
    let sending=false;
    try {
      const agent=await find(job.organization_id);
      if(!agent?.enabled)throw d.error('Agente pausado.',409);
      let result=null,output=job.input_text;
      if(job.kind==='reply'){
        const conversation=take(await db.from('ai_conversations').select('*').eq('organization_id',job.organization_id).eq('phone',job.phone).maybeSingle())||{};
        result=await generate(agent,conversation,job);output=result.message;
      }
      // Recheck pause and tenant status after generation, immediately before sending.
      const finalized=await db.rpc('finalize_due_subscription_cancellation',{p_organization_id:job.organization_id});
      if(finalized.error || finalized.data===true)throw d.error('Assinatura indisponível.',409);
      const current=await find(job.organization_id),org=take(await db.from('organizations').select('status').eq('id',job.organization_id).maybeSingle());
      if(!current?.enabled || org?.status!=='active')throw d.error('Agente pausado.',409);
      const claimed=take(await db.from('ai_jobs').update({state:'sending',output_text:output,result}).eq('id',job.id).eq('state','processing').select('id').maybeSingle());
      if(!claimed)return;
      sending=true;
      const response=await evolution('POST',`/message/sendText/${encodeURIComponent(agent.instance_name)}`,{number:job.phone,text:output});
      if(!response.key?.id)throw d.error('Entrega sem confirmação.',502);
      await rpc('ai_finish_job',{p_id:job.id,p_outcome:'sent',p_provider_id:response.key.id});
    } catch(e) {
      // Never retry ambiguous WhatsApp delivery automatically (prevents duplicate replies/charges).
      await rpc('ai_finish_job',{p_id:job.id,p_outcome:sending?'uncertain':'failed',p_provider_id:null});
    }
  }
  async function adminList() {
    const agents=take(await db.from('ai_agents').select('organization_id,settings,enabled').order('created_at',{ascending:false}));
    return Promise.all(agents.map(async a=>({...a,wallet:d.walletView(await rpc('ai_wallet_refresh',{p_org:a.organization_id,p_activate:false}))})));
  }
  async function adminDetails(org) {
    const events=take(await db.from('ai_credit_events').select('*').eq('organization_id',org).order('created_at',{ascending:false}).limit(100));
    const jobs=take(await db.from('ai_jobs').select('id,phone,kind,state,created_at,error_code').eq('organization_id',org).in('state',['uncertain']).order('created_at',{ascending:false}).limit(30));
    return {events,jobs};
  }
  async function topup(org,body) {
    if(!Number.isInteger(body.credits)||body.credits<1||body.credits>100000||!/^[-a-f0-9]{36}$/i.test(body.requestId||'')||d.text(body.note,240).length<3)throw d.error('Informe quantidade, referência e descrição válidas.');
    return d.walletView(await rpc('ai_add_credits',{p_org:org,p_request:body.requestId,p_credits:body.credits,p_note:d.text(body.note,240)}));
  }
  async function resolve(org,id,outcome) {
    if(!['sent','failed'].includes(outcome))throw d.error('Resultado inválido.');
    const job=take(await db.from('ai_jobs').select('id,state').eq('organization_id',org).eq('id',id).maybeSingle());
    if(job?.state!=='uncertain')throw d.error('Envio não está pendente de revisão.',409);
    await rpc('ai_finish_job',{p_id:id,p_outcome:outcome,p_provider_id:null});
  }
  return {status,save,connection,enable,receive,tick,adminList,adminDetails,topup,resolve};
}
module.exports={createService};
