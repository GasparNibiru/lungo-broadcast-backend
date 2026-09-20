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
 fs.writeFileSync(file,JSON.stringify({vacancies:[],candidates:[{id:'old',organizationId:'org',disc:{tokenHash:hash('old')}},{id:'new',organizationId:'org',disc:{tokenHash:hash('new'),assessmentVersion:2}},{id:'foreign',organizationId:'other',disc:{}}]}));
 const authPath=require.resolve('../src/middleware/require-access'),routePath=require.resolve('../src/routes/recruitment'),oldAuth=require.cache[authPath],oldRoute=require.cache[routePath];
 require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{requireAccess:()=> (req,res,next)=>{req.accessUser={id:'s',organizationId:'org',role:'supervisor'};next();}}};delete require.cache[routePath];
 const app=express();app.use(express.json());app.use(require(routePath));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const answers=Array.from({length:12},()=>({most:0,least:1}));const post=(token,body)=>fetch(base+'/api/public/recruitment/disc/'+token+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
 assert.equal((await post('old',{answers})).status,200);assert.equal((await post('new',{answers})).status,400);
 const publicTest=await (await fetch(base+'/api/public/recruitment/disc/new')).json();assert.equal(publicTest.assessmentVersion,2);assert.equal(publicTest.commercialQuestions.length,8);
 assert.equal((await post('new',{answers,assessmentVersion:2,commercialAnswers:[1,2,0,3,1,2,0,3]})).status,200);assert.equal((await post('new',{answers})).status,410);
 const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.candidates[0].disc.result.commercial,undefined);assert.equal(saved.candidates[1].disc.result.commercial.score,100);assert.equal(saved.candidates[1].stage,'teste_realizado');assert.equal(saved.candidates[1].seenAt,null);
 const response=await fetch(base+'/api/supervisor/recruitment/candidates/foreign',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({seen:true})});assert.equal(response.status,404);
 }finally{await new Promise(r=>server.close(r));if(oldAuth)require.cache[authPath]=oldAuth;else delete require.cache[authPath];if(oldRoute)require.cache[routePath]=oldRoute;else delete require.cache[routePath];if(oldEnv===undefined)delete process.env.RECRUITMENT_FILE_PATH;else process.env.RECRUITMENT_FILE_PATH=oldEnv;fs.rmSync(dir,{recursive:true,force:true});}
});
