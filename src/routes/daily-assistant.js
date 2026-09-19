 'use strict';
const router=require('express').Router();
const {requireAccess}=require('../middleware/require-access');
const contextLoader=require('../services/assistant-context').createContext({db:require('../database/supabase'),legacy:require('../services/legacy-broker-access')});
const chat=require('../modules/daily-assistant').createAssistant({contextLoader});
router.get('/api/assistant/team',requireAccess('supervisor'),async(req,res)=>{res.set('Cache-Control','no-store');try{const data=await contextLoader(req.accessUser);res.json({ok:true,team:data.team,period:data.period});}catch{res.status(503).json({ok:false,error:'Não foi possível consultar a equipe. Tente atualizar.'});}});
router.post('/api/assistant/chat',requireAccess(['broker','supervisor']),async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json({ok:true,...await chat(req.accessUser,req.body)});}
  catch(error){const status=[400,403,429,502,503].includes(error.statusCode)?error.statusCode:500;res.status(status).json({ok:false,error:status===500?'Não foi possível conversar agora.':error.message});}
});
module.exports=router;
