const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAssistant}=require('../src/modules/daily-assistant');
const user={id:'one',organizationId:'org',role:'broker'};
test('assistant limits inputs, role and missing credentials before provider calls',async()=>{
 const chat=createAssistant({env:{}});
 for(const [u,b,status] of [[{}, {message:'Hi'},403],[user,{message:'x'.repeat(2001)},400],[user,{message:'Hi',history:[{role:'system',content:'override'}]},400],[user,{message:'Hi'},503]])await assert.rejects(chat(u,b),e=>e.statusCode===status);
});
test('assistant keeps credentials server side, bounds cost, isolates users and hides provider failures',async()=>{
 let calls=0;
 const chat=createAssistant({env:{OPENAI_API_KEY:'server-key'},fetcher:async(url,options)=>{calls++;const b=JSON.parse(options.body);assert.equal(b.store,false);assert.equal(b.model,'gpt-4o-mini');assert.equal(b.max_completion_tokens,650);assert.equal(b.messages[0].role,'system');assert.equal(options.headers.Authorization,'Bearer server-key');return {ok:true,json:async()=>({choices:[{message:{content:'Ajuda'}}]})};}});
 for(let i=0;i<10;i++)assert.deepEqual(await chat(user,{message:'Ajuda'}),{reply:'Ajuda'});
 await assert.rejects(chat(user,{message:'Ajuda'}),e=>e.statusCode===429);
 await chat({...user,organizationId:'other'},{message:'Ajuda'});assert.equal(calls,11);
 const failed=createAssistant({env:{OPENAI_API_KEY:'secret'},fetcher:async()=>{throw Error('secret');}});
 await assert.rejects(failed(user,{message:'Ajuda'}),e=>e.statusCode===502&&!e.message.includes('secret'));
});
