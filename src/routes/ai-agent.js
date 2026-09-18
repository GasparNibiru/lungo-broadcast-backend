'use strict';
const express = require('express');
const {requireAccess} = require('../middleware/require-access');
const requireAdmin = require('../middleware/require-admin');
const {createService} = require('../modules/ai-agent/service');
const service = createService(require('../database/supabase'));
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const endpoint=fn=>async(req,res)=>{try{
  if((req.params.org&&!UUID.test(req.params.org))||(req.params.id&&!UUID.test(req.params.id)))return res.status(400).json({ok:false,error:'Identificador inválido.'});
  res.set('Cache-Control','no-store');res.json({ok:true,...await fn(req)});
}catch(e){const status=[400,401,403,404,409,502,503].includes(e.statusCode)?e.statusCode:500;res.status(status).json({ok:false,error:status===500?'Não foi possível concluir a operação do agente.':e.message});}};
router.use('/api/supervisor/ai-agent',requireAccess('supervisor'));
router.get('/api/supervisor/ai-agent',endpoint(req=>service.status(req.accessUser.organizationId)));
router.put('/api/supervisor/ai-agent',endpoint(req=>service.save(req.accessUser.organizationId,req.body||{})));
router.post('/api/supervisor/ai-agent/enabled',endpoint(req=>service.enable(req.accessUser.organizationId,req.body?.enabled)));
router.get('/api/supervisor/ai-agent/connection',endpoint(req=>service.connection(req.accessUser.organizationId)));
router.post('/api/supervisor/ai-agent/connection',endpoint(req=>service.connection(req.accessUser.organizationId,true)));
router.post('/api/ai-agent/webhook/:org',endpoint(async req=>{await service.receive(req.params.org,req.get('x-agent-secret'),req.body||{});return {}; }));
router.use('/api/admin/ai-agents',requireAdmin);
router.get('/api/admin/ai-agents',endpoint(async()=>({agents:await service.adminList()})));
router.get('/api/admin/ai-agents/:org',endpoint(req=>service.adminDetails(req.params.org)));
router.post('/api/admin/ai-agents/:org/credits',endpoint(async req=>({wallet:await service.topup(req.params.org,req.body||{})})));
router.post('/api/admin/ai-agents/:org/jobs/:id/resolve',endpoint(async req=>{await service.resolve(req.params.org,req.params.id,req.body?.outcome);return {};}));
let timer;
function start(){
  if(timer||process.env.AI_AGENT_ENABLED!=='true')return;
  let busy=false;
  timer=setInterval(async()=>{if(busy)return;busy=true;try{await service.tick();}catch{console.error('[ai-agent] Worker temporarily unavailable; no automatic ambiguous resend.');}finally{busy=false;}},2000);
  timer.unref();
}
module.exports={router,start};
