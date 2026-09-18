'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const d=require('../src/modules/ai-agent/domain');
const multi=require('../src/modules/ai-agent/multiramos');
const config={agentName:'Assistente Teste',companyName:'Corretora Teste',companyInfo:'Atendimento comercial',summaryPhone:'5511999998888',agentType:'multiramos'};
const job={phone:'5511888887777',input_text:'Quero cotar'};
const reply=(produto,dados=[])=>({message:'Seu resumo foi encaminhado. Um responsável entrará em contato.',profile:{nome:'Cliente Teste',produto,dados},handoff:true,explicitNewRequest:false});
test('agent selection defaults legacy accounts to health and preserves type for older clients',()=>{
 assert.equal(d.settings({...config,agentType:undefined}).agentType,'health');
 assert.equal(d.settings({...config,agentType:undefined},config).agentType,'multiramos');
 assert.throws(()=>d.settings({...config,agentType:'arbitrary-prompt'}));
 assert.equal(d.formatFor('health'),d.responseFormat);
 assert.equal(d.formatFor('multiramos').json_schema.name,'multiramos_reply');
});
test('six products have distinct profiles and summaries without health-only fields leaking into auto',()=>{
 for(const produto of multi.productNames){
  const dados=Object.keys(multi.products[produto]).map(campo=>({campo,valor:'Informação de teste'}));
  const result=d.replyResult(reply(produto,dados),{},config,job);
  assert.match(result.summary,new RegExp(`Produto: ${produto}`));
  assert.equal(result.profile._agentType,'multiramos');assert.equal(result.profile._complete,true);
  for(const label of Object.values(multi.products[produto]))assert.ok(result.summary.includes(label));
  assert.equal(result.summaryPhone,config.summaryPhone);
  assert.ok(!result.summary.includes('Vanuza'));assert.ok(!result.summary.includes('VSeg'));
  if(produto==='Seguro Auto')assert.ok(!result.summary.includes('Preferência de operadora'));
 }
});
test('multi profile rejects unknown products, mismatched data, duplicate fields and oversized input',()=>{
 for(const raw of [reply('Seguro desconhecido'),reply('Seguro de Vida',[{campo:'cpf_proponente',valor:'00000000000'}]),reply('Seguro Auto',[{campo:'email',valor:'test@example.invalid'}]),reply('Consórcio',[{campo:'bem_desejado',valor:'casa'},{campo:'bem_desejado',valor:'carro'}]),reply('Seguro Auto',[{campo:'veiculo',valor:'x'.repeat(401)}])])assert.throws(()=>d.replyResult(raw,{},config,job));
 const early=d.replyResult(reply('não informado'),{},config,job);assert.ok(early.summary.includes('Produto: não informado'));
 const declined=d.replyResult({...reply('Consórcio',[{campo:'deseja_continuar',valor:'não'}]),handoff:false},{},config,job);assert.equal(declined.summary,'');
});
test('unfinished conversations keep their type; completed conversations accept the newly selected type',()=>{
 const legacy={profile:{nome:'Ana'},history:[{role:'user',content:'Olá'}],last_summary_hash:null};
 assert.equal(d.conversationFor(config,legacy,'multiramos').type,'health');
 const pinned={...legacy,profile:{nome:'Ana',produto:'Seguro Auto',dados:[],_agentType:'multiramos',_complete:false},last_summary_hash:'older-quote'};
 assert.equal(d.conversationFor({agentType:'health'},pinned,'health').type,'multiramos');
 const completed={...legacy,profile:{...legacy.profile,_agentType:'health',_complete:true},last_summary_hash:'finished'};
 const selected=d.conversationFor(config,completed,'multiramos');assert.equal(selected.type,'multiramos');assert.equal(selected.conversation.profile.nome,'Ana');assert.deepEqual(selected.conversation.profile.dados,[]);assert.equal(selected.conversation.history,completed.history);
 assert.equal(d.conversationFor(config,{},'health').type,'health','queued messages preserve type at receipt');
 assert.equal(d.conversationFor(config,{},'multiramos').type,'multiramos');
});
test('new quotes reopen the conversation without repeated transfers for greetings',()=>{
 const completed=d.replyResult(reply('Seguro Auto'),{},config,job);
 const conversation={profile:completed.profile,history:completed.history,last_summary_hash:completed.summaryHash};
 const greeting=d.replyResult({...reply('Seguro Auto'),handoff:false},conversation,config,job);assert.equal(greeting.profile._complete,true);assert.equal(greeting.summary,'');
 const newQuote=d.replyResult({...reply('Seguro Viagem'),handoff:false,explicitNewRequest:true},conversation,config,job);assert.equal(newQuote.profile._complete,false);assert.equal(newQuote.summary,'');
 const followup=d.replyResult({...reply('Seguro Viagem'),handoff:false},{profile:newQuote.profile,last_summary_hash:newQuote.summaryHash},config,job);assert.equal(followup.profile._complete,false);
 const finished=d.replyResult(reply('Seguro Viagem'),{profile:followup.profile,last_summary_hash:followup.summaryHash},config,job);assert.ok(finished.summary.includes('Produto: Seguro Viagem'));assert.equal(finished.profile._complete,true);
});
test('adapted prompt retains original branches and project-specific handoff',()=>{
 const prompt=d.prompt(config,{});
 for(const product of multi.productNames)assert.ok(prompt.includes(product));
 for(const rule of ['CPF do proponente','contemplação','NÃO faça perguntas médicas','Não peça e-mail','no máximo UMA pergunta','responsável da corretora','próprio WhatsApp'])assert.ok(prompt.includes(rule),rule);
 assert.ok(!prompt.includes('[[TRANSFERIR_VANUZA]]'));assert.ok(!prompt.includes('VSeg'));assert.ok(!prompt.includes('VANUZA'));
 assert.match(d.prompt({...config,agentType:'health'},{}),/NÃO pergunte orçamento nem e-mail/);
});
