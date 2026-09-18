'use strict';
const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const finance = require('../services/supervisor-finance');
const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auth = requireAccess('supervisor');
function endpoint(handler) { return async (req, res) => { try { await handler(req, res); } catch (error) { const status = [400,404,409].includes(error.statusCode) ? error.statusCode : 500; res.status(status).json({ ok:false, error:status===500?'Erro interno no módulo financeiro.':error.message }); } }; }
function id(req, res) { if (UUID.test(req.params.id)) return true; res.status(400).json({ ok:false,error:'Identificador inválido.' }); return false; }
router.use('/api/supervisor/finance', auth);
router.get('/api/supervisor/finance/health', (_req,res)=>res.json({ok:true,module:'supervisor-finance',version:'1.0.0'}));
router.get('/api/supervisor/finance/settings', endpoint(async(req,res)=>res.json({ok:true,settings:await finance.settings(req.accessUser)})));
router.post('/api/supervisor/finance/activate', endpoint(async(req,res)=>res.status(201).json({ok:true,settings:await finance.activate(req.accessUser)})));
router.get('/api/supervisor/finance/products', endpoint(async(req,res)=>res.json({ok:true,products:await finance.listProducts(req.accessUser)})));
router.post('/api/supervisor/finance/products', endpoint(async(req,res)=>res.status(201).json({ok:true,product:await finance.createProduct(req.accessUser,req.body||{})})));
router.patch('/api/supervisor/finance/products/:id', endpoint(async(req,res)=>{if(!id(req,res))return;res.json({ok:true,product:await finance.updateProduct(req.accessUser,req.params.id,req.body||{})});}));
router.get('/api/supervisor/finance/broker-rules', endpoint(async(req,res)=>res.json({ok:true,brokerRules:await finance.listBrokerRules(req.accessUser)})));
router.post('/api/supervisor/finance/broker-rules', endpoint(async(req,res)=>res.status(201).json({ok:true,brokerRule:await finance.createBrokerRule(req.accessUser,req.body||{})})));
router.patch('/api/supervisor/finance/broker-rules/:id', endpoint(async(req,res)=>{if(!id(req,res))return;res.json({ok:true,brokerRule:await finance.updateBrokerRule(req.accessUser,req.params.id,req.body||{})});}));
router.post('/api/supervisor/finance/sync', endpoint(async(req,res)=>res.json({ok:true,sync:await finance.syncClosings(req.accessUser)})));
router.get('/api/supervisor/finance/sales', endpoint(async(req,res)=>res.json({ok:true,sales:await finance.listSales(req.accessUser)})));
router.patch('/api/supervisor/finance/sales/:id/schedule', endpoint(async(req,res)=>{if(!id(req,res))return;res.json({ok:true,sale:await finance.scheduleSale(req.accessUser,req.params.id,req.body||{})});}));
router.get('/api/supervisor/finance/receivables', endpoint(async(req,res)=>res.json({ok:true,receivables:await finance.rows(req.accessUser,'finance_receivables')})));
router.patch('/api/supervisor/finance/receivables/:id/payment', endpoint(async(req,res)=>{if(!id(req,res))return;res.json({ok:true,receivable:await finance.confirmPayment(req.accessUser,'finance_receivables',req.params.id,req.body||{})});}));
router.get('/api/supervisor/finance/transfers', endpoint(async(req,res)=>res.json({ok:true,transfers:await finance.rows(req.accessUser,'finance_transfers')})));
router.patch('/api/supervisor/finance/transfers/:id/payment', endpoint(async(req,res)=>{if(!id(req,res))return;res.json({ok:true,transfer:await finance.confirmPayment(req.accessUser,'finance_transfers',req.params.id,req.body||{})});}));
module.exports=router;
