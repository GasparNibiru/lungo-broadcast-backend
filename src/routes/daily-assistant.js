 'use strict';
const router=require('express').Router();
const {requireAccess}=require('../middleware/require-access');
const chat=require('../modules/daily-assistant').createAssistant();
router.post('/api/assistant/chat',requireAccess(['broker','supervisor']),async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json({ok:true,...await chat(req.accessUser,req.body)});}
  catch(error){const status=[400,403,429,502,503].includes(error.statusCode)?error.statusCode:500;res.status(status).json({ok:false,error:status===500?'Não foi possível conversar agora.':error.message});}
});
module.exports=router;
