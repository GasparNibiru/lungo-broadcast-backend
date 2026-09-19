const router=require('express').Router();
const {requireAccess}=require('../middleware/require-access');
const load=require('../services/notifications').createNotifications({db:require('../database/supabase'),trainings:require('./trainings-v2').notificationTrainings,isOwner:require('../services/subscription-cancellation').isOrganizationOwner});
router.get('/api/notifications',requireAccess(['supervisor','broker']),async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({ok:true,...await load(req.accessUser)});}catch{res.status(503).json({ok:false,error:'Não foi possível consultar as notificações.'});}});
module.exports=router;
