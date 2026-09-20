const {test}=require('node:test');const assert=require('node:assert/strict');
const {scoreCommercial,publicQuestions}=require('../src/services/recruitment-assessment');
test('commercial rubric has no artificial floor and does not expose scoring to candidates',()=>{
 assert.equal(scoreCommercial([1,2,0,3,1,2,0,3]).score,100);
 const low=scoreCommercial([0,1,3,0,0,0,1,0]);assert.equal(low.score,0);assert.ok(low.interview.length>=4);
 assert.equal(publicQuestions().length,8);assert.ok(publicQuestions().every(q=>!q.points&&!q.dimension));
 assert.throws(()=>scoreCommercial([0]),/todas/);assert.throws(()=>scoreCommercial(Array(8).fill(4)),/todas/);
});
test('versioned completion preserves existing tests, requires commercial answers for new ones and scopes read receipts',async()=>{
 const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),express=require('express');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lungo-rh-')),file=path.join(dir,'recruitment.json'),oldEnv=process.env.RECRUITMENT_FILE_PATH;
 process.env.RECRUITMENT_FILE_PATH=file;
 const hash=t=>crypto.createHash('sha256').update(t).digest('hex');
 fs.writeFileSync(file,JSON.stringify({vacancies:[],candidates:[{id:'pending',organizationId:'org',stage:'teste_enviado',email:'old@example.com',disc:{}},{id:'old',organizationId:'org',disc:{tokenHash:hash('old')}},{id:'new',organizationId:'org',disc:{tokenHash:hash('new'),assessmentVersion:2}},{id:'foreign',organizationId:'other',disc:{}}]}));
 const authPath=require.resolve('../src/middleware/require-access'),routePath=require.resolve('../src/routes/recruitment'),oldAuth=require.cache[authPath],oldRoute=require.cache[routePath];
 const mailPath=require.resolve('../src/services/access-email'),oldMail=require.cache[mailPath]; let releaseMail, dismissalMails=0,archivals=0;
 require.cache[mailPath]={id:mailPath,filename:mailPath,loaded:true,exports:{sendRecruitmentDismissalEmail:async({email})=>{assert.equal(email,'updated@example.com');dismissalMails++;return {sent:true};},sendRecruitmentEmail:()=>new Promise(resolve=>{releaseMail=()=>resolve({messageId:'mock'});})}};
 require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{requireAccess:()=> (req,res,next)=>{req.accessUser={id:'s',organizationId:'org',role:'supervisor'};next();}}};delete require.cache[routePath];
 const supervisorPath=require.resolve('../src/services/supervisor'),oldSupervisor=require.cache[supervisorPath];require.cache[supervisorPath]={id:supervisorPath,filename:supervisorPath,loaded:true,exports:{organizationBroker:async()=>({id:'broker',email:'updated@example.com'}),archiveSupervisorBroker:async()=>{archivals++;}}};
 const app=express();app.use(express.json());app.use(require(routePath));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const answers=Array.from({length:12},()=>({most:0,least:1}));const post=(token,body)=>fetch(base+'/api/public/recruitment/disc/'+token+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
 const patchEmail=(id,email)=>fetch(base+'/api/supervisor/recruitment/candidates/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
 assert.equal((await patchEmail('pending','invalid')).status,400);
 assert.equal((await patchEmail('foreign','new@example.com')).status,404);
 assert.equal((await patchEmail('pending',' new@example.com ')).status,200);
 assert.equal(JSON.parse(fs.readFileSync(file)).candidates[0].email,'new@example.com');
 assert.equal((await patchEmail('old','new@example.com')).status,409);
 const update=body=>fetch(base+'/api/supervisor/recruitment/candidates/pending',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await update({hiredUserId:'broker'})).status,409);
 assert.equal((await update({stage:'aprovado',hirePending:true})).status,200);
 let hire=JSON.parse(fs.readFileSync(file)).candidates[0];assert.ok(hire.approvedAt);assert.equal(hire.accessGrantedAt,undefined);
 assert.equal((await update({stage:'entrevista'})).status,200);
 assert.equal((await patchEmail('pending','corrigido@example.com')).status,200);
 assert.equal(JSON.parse(fs.readFileSync(file)).candidates[0].email,'corrigido@example.com');
 assert.equal((await update({hiredUserId:'broker',hirePending:false})).status,200);
 assert.equal((await patchEmail('pending','blocked@example.com')).status,409);
 hire=JSON.parse(fs.readFileSync(file)).candidates[0];assert.ok(hire.accessGrantedAt);assert.equal(hire.hirePending,false);
 const granted=hire.accessGrantedAt;await update({seen:true});assert.equal(JSON.parse(fs.readFileSync(file)).candidates[0].accessGrantedAt,granted);

 assert.equal((await post('old',{answers})).status,200);assert.equal((await post('new',{answers})).status,400);
 const publicTest=await (await fetch(base+'/api/public/recruitment/disc/new')).json();assert.equal(publicTest.assessmentVersion,2);assert.equal(publicTest.commercialQuestions.length,8);
 assert.equal((await post('new',{answers,assessmentVersion:2,commercialAnswers:[1,2,0,3,1,2,0,3]})).status,200);assert.equal((await post('new',{answers})).status,410);
 const saved=JSON.parse(fs.readFileSync(file));saved.candidates.shift();assert.equal(saved.candidates[0].disc.result.commercial,undefined);assert.equal(saved.candidates[1].disc.result.commercial.score,100);assert.equal(saved.candidates[1].stage,'teste_realizado');assert.equal(saved.candidates[1].seenAt,null);
 const dismiss=id=>fetch(base+'/api/supervisor/recruitment/candidates/'+id+'/dismiss',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal((await dismiss('foreign')).status,404);assert.equal((await dismiss('pending')).status,200);assert.equal((await dismiss('pending')).status,200);assert.equal(dismissalMails,1);assert.equal(archivals,1);assert.ok(JSON.parse(fs.readFileSync(file)).candidates[0].dismissedAt);
 assert.equal((await fetch(base+'/api/supervisor/recruitment/candidates/pending',{method:'DELETE'})).status,409);
 const latest=JSON.parse(fs.readFileSync(file));latest.candidates.push({id:'mail',organizationId:'org',stage:'novo',email:'mail@example.com',updatedAt:'before'});fs.writeFileSync(file,JSON.stringify(latest));
 const sending=fetch(base+'/api/supervisor/recruitment/candidates/mail/disc/send',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 while(!releaseMail) await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await fetch(base+'/api/supervisor/recruitment/candidates/mail',{method:'DELETE'})).status,200);
 releaseMail();assert.equal((await sending).status,409);assert.ok(!JSON.parse(fs.readFileSync(file)).candidates.some(c=>c.id==='mail'));
 const response=await fetch(base+'/api/supervisor/recruitment/candidates/foreign',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({seen:true})});assert.equal(response.status,404);
 }finally{if(oldSupervisor)require.cache[supervisorPath]=oldSupervisor;else delete require.cache[supervisorPath];if(oldMail)require.cache[mailPath]=oldMail;else delete require.cache[mailPath];await new Promise(r=>server.close(r));if(oldAuth)require.cache[authPath]=oldAuth;else delete require.cache[authPath];if(oldRoute)require.cache[routePath]=oldRoute;else delete require.cache[routePath];if(oldEnv===undefined)delete process.env.RECRUITMENT_FILE_PATH;else process.env.RECRUITMENT_FILE_PATH=oldEnv;fs.rmSync(dir,{recursive:true,force:true});}
});
