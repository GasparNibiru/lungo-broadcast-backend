'use strict';
const supabase = require('../database/supabase');
const legacy = require('./legacy-broker-access');
const calculator = require('./finance-calculator');

function fail(error, fallback = 'Erro no módulo financeiro.') {
  if (!error) return;
  const output = new Error(error.message || fallback);
  output.statusCode = error.code === '23505' ? 409 : 500;
  throw output;
}
function clean(value, max = 180) { return String(value || '').trim().slice(0, max); }
function money(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = clean(value).replace(/[^0-9,.-]/g, '');
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (comma >= 0) text = text.replace(',', '.');
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}
function dateOnly(value) {
  const text = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T12:00:00Z`))) throw Object.assign(new Error('Informe uma data válida.'), { statusCode: 400 });
  return text;
}
function eventRow(user, entityType, entityId, action, metadata = {}) { return { organization_id: user.organizationId, actor_user_id: user.id, entity_type: entityType, entity_id: entityId, action, metadata }; }
async function audit(user, entityType, entityId, action, metadata) { const { error } = await supabase.from('finance_events').insert(eventRow(user, entityType, entityId, action, metadata)); fail(error); }

async function settings(user) {
  const { data, error } = await supabase.from('finance_settings').select('*').eq('organization_id', user.organizationId).maybeSingle();
  fail(error); return data;
}
async function activate(user) {
  const current = await settings(user);
  if (current) return current;
  const { data, error } = await supabase.from('finance_settings').insert({ organization_id: user.organizationId, activated_by: user.id }).select('*').single();
  fail(error); await audit(user, 'settings', null, 'activated', { activatedAt: data.activated_at }); return data;
}
async function listProducts(user) {
  const { data, error } = await supabase.from('finance_product_rules').select('*,finance_product_installments(*)').eq('organization_id', user.organizationId).order('product_name');
  fail(error); return data || [];
}
function productPayload(body) {
  const carrierName = clean(body.carrierName), productName = clean(body.productName);
  const installments = Array.isArray(body.installments) ? body.installments.map((item, index) => ({ installment_number: index + 1, commission_percent: Number(item.commissionPercent), month_offset: Number(item.monthOffset ?? index) })) : [];
  if (!carrierName || !productName || !installments.length || installments.some(item => !Number.isFinite(item.commission_percent) || item.commission_percent < 0 || !Number.isInteger(item.month_offset) || item.month_offset < 0)) throw Object.assign(new Error('Informe produto e parcelas válidas.'), { statusCode: 400 });
  const total = installments.reduce((sum, item) => sum + item.commission_percent, 0), declared = Number(body.totalCommissionPercent ?? total);
  if (Math.abs(total - declared) > 0.0001) throw Object.assign(new Error('A soma das parcelas deve corresponder à comissão total.'), { statusCode: 400 });
  const taxMode = ['none', 'deduct', 'withheld'].includes(body.taxMode) ? body.taxMode : 'none';
  return { rule: { carrier_name: carrierName, product_name: productName, total_commission_percent: declared, tax_mode: taxMode, tax_percent: taxMode === 'none' ? 0 : Number(body.taxPercent || 0), lifetime_enabled: Boolean(body.lifetimeEnabled), lifetime_percent: body.lifetimeEnabled ? Number(body.lifetimePercent || 0) : 0, active: body.active !== false }, installments };
}
async function createProduct(user, body) {
  const payload = productPayload(body); payload.rule.organization_id = user.organizationId; payload.rule.created_by = user.id;
  const created = await supabase.from('finance_product_rules').insert(payload.rule).select('*').single(); fail(created.error);
  const rows = payload.installments.map(item => ({ ...item, product_rule_id: created.data.id }));
  const inserted = await supabase.from('finance_product_installments').insert(rows).select('*');
  if (inserted.error) { await supabase.from('finance_product_rules').delete().eq('id', created.data.id).eq('organization_id', user.organizationId); fail(inserted.error); }
  await audit(user, 'product_rule', created.data.id, 'created', { productName: payload.rule.product_name });
  return { ...created.data, finance_product_installments: inserted.data };
}
async function createBrokerRule(user, body) {
  const brokerUserId = clean(body.brokerUserId, 36), productRuleId = clean(body.productRuleId, 36);
  const installments = Array.isArray(body.installments) ? body.installments.map((item, index) => ({ installment_number: index + 1, commission_percent: Number(item.commissionPercent), month_offset: Number(item.monthOffset ?? index) })) : [];
  if (!brokerUserId || !productRuleId || !installments.length) throw Object.assign(new Error('Informe corretor, produto e parcelas de repasse.'), { statusCode: 400 });
  const rule = await supabase.from('finance_broker_rules').insert({ organization_id: user.organizationId, broker_user_id: brokerUserId, product_rule_id: productRuleId, lifetime_enabled: Boolean(body.lifetimeEnabled), lifetime_percent: body.lifetimeEnabled ? Number(body.lifetimePercent || 0) : 0, created_by: user.id }).select('*').single(); fail(rule.error);
  const inserted = await supabase.from('finance_broker_installments').insert(installments.map(item => ({ ...item, broker_rule_id: rule.data.id }))).select('*');
  if (inserted.error) { await supabase.from('finance_broker_rules').delete().eq('id', rule.data.id).eq('organization_id', user.organizationId); fail(inserted.error); }
  await audit(user, 'broker_rule', rule.data.id, 'created', { brokerUserId, productRuleId });
  return { ...rule.data, finance_broker_installments: inserted.data };
}
async function syncClosings(user) {
  const config = await settings(user); if (!config?.active) return { imported: 0, active: false };
  const activated = Date.parse(config.activated_at), leads = await legacy.organizationLeads(user.organizationId);
  const candidates = leads.filter(item => ['fechamento', 'fechado', 'venda', 'vendido', 'cliente', 'ganho'].includes(clean(item.status).toLowerCase()))
    .filter(item => Date.parse(item.closedAt || item.updatedAt || item.createdAt || 0) >= activated)
    .map(item => ({ organization_id: user.organizationId, source_kind: 'lead_closing', source_id: clean(item.id), source_client_id: clean(item.sourceClientId || '' ) || null, seller_user_id: item.assignedBrokerUserId || item.brokerUserId || null, client_name: clean(item.nome || item.pushName || item.telefone) || 'Cliente', seller_name: clean(item.assignedBrokerName || item.brokerName), product_name: clean(item.planoInteresse || item.planoAtual) || 'Produto não informado', sale_amount: money(item.valorNegocio || item.valor || 0), closed_at: item.closedAt || item.updatedAt || item.createdAt }));
  if (!candidates.length) return { imported: 0, active: true };
  const { data, error } = await supabase.from('finance_sales').upsert(candidates, { onConflict: 'organization_id,source_kind,source_id', ignoreDuplicates: true }).select('id'); fail(error);
  return { imported: data?.length || 0, active: true };
}
async function listSales(user) { await syncClosings(user); const { data, error } = await supabase.from('finance_sales').select('*').eq('organization_id', user.organizationId).order('closed_at', { ascending: false }); fail(error); return data || []; }
async function rows(user, table) { const { data, error } = await supabase.from(table).select('*,finance_sales(client_name,product_name,seller_name,sale_amount)').eq('organization_id', user.organizationId).order('due_date'); fail(error); return data || []; }

async function scheduleSale(user, saleId, body) {
  const saleResult = await supabase.from('finance_sales').select('*').eq('id', saleId).eq('organization_id', user.organizationId).single(); fail(saleResult.error); const sale = saleResult.data;
  if (sale.status !== 'pending') throw Object.assign(new Error('Esta venda já possui programação financeira.'), { statusCode: 409 });
  const ruleResult = await supabase.from('finance_product_rules').select('*,finance_product_installments(*)').eq('id', body.productRuleId).eq('organization_id', user.organizationId).eq('active', true).single(); fail(ruleResult.error); const rule = ruleResult.data;
  const installments = (rule.finance_product_installments || []).sort((a,b) => a.installment_number - b.installment_number).map(item => ({ installmentNumber: item.installment_number, commissionPercent: item.commission_percent, monthOffset: item.month_offset }));
  const firstDate = dateOnly(body.firstReceivableDate), implantationDate = dateOnly(body.implantationDate);
  const receivables = calculator.buildReceivables({ saleAmount: sale.sale_amount, firstDate, installments, taxMode: rule.tax_mode, taxPercent: rule.tax_percent }).map(item => ({ organization_id: user.organizationId, finance_sale_id: sale.id, entry_type: item.entryType, installment_number: item.installmentNumber, competence: item.competence, due_date: item.dueDate, gross_amount: item.grossAmount, tax_percent: item.taxPercent, tax_amount: item.taxAmount, net_amount: item.netAmount }));
  if (rule.lifetime_enabled && Number(rule.lifetime_percent) > 0) {
    const dueDate = calculator.firstLifetimeDate(firstDate, installments), gross = calculator.percentageOf(calculator.cents(sale.sale_amount), rule.lifetime_percent) / 100;
    const taxRate = rule.tax_mode === 'deduct' ? Number(rule.tax_percent || 0) : 0, tax = calculator.percentageOf(calculator.cents(gross), taxRate) / 100;
    receivables.push({ organization_id:user.organizationId, finance_sale_id:sale.id, entry_type:'lifetime', installment_number:null, competence:`${dueDate.slice(0,7)}-01`, due_date:dueDate, gross_amount:gross, tax_percent:taxRate, tax_amount:tax, net_amount:gross-tax });
  }
  let brokerRule = null, transfers = [];
  if (sale.seller_user_id) { const result = await supabase.from('finance_broker_rules').select('*,finance_broker_installments(*)').eq('organization_id', user.organizationId).eq('broker_user_id', sale.seller_user_id).eq('product_rule_id', rule.id).eq('active', true).maybeSingle(); fail(result.error); brokerRule = result.data; }
  if (brokerRule) transfers = calculator.buildTransfers({ saleAmount: sale.sale_amount, firstDate, installments: brokerRule.finance_broker_installments.sort((a,b)=>a.installment_number-b.installment_number).map(item => ({ installmentNumber:item.installment_number, commissionPercent:item.commission_percent, monthOffset:item.month_offset })) }).map(item => ({ organization_id:user.organizationId, finance_sale_id:sale.id, broker_user_id:sale.seller_user_id, entry_type:item.entryType, installment_number:item.installmentNumber, commission_percent:item.commissionPercent, competence:item.competence, due_date:item.dueDate, expected_amount:item.expectedAmount }));
  if (brokerRule?.lifetime_enabled && Number(brokerRule.lifetime_percent) > 0) {
    const dueDate = calculator.firstLifetimeDate(firstDate, brokerRule.finance_broker_installments.map((item,index)=>({monthOffset:item.month_offset ?? index})));
    transfers.push({ organization_id:user.organizationId, finance_sale_id:sale.id, broker_user_id:sale.seller_user_id, entry_type:'lifetime', installment_number:null, commission_percent:Number(brokerRule.lifetime_percent), competence:`${dueDate.slice(0,7)}-01`, due_date:dueDate, expected_amount:calculator.percentageOf(calculator.cents(sale.sale_amount), brokerRule.lifetime_percent)/100 });
  }
  const recInsert = await supabase.from('finance_receivables').insert(receivables).select('*'); fail(recInsert.error);
  if (transfers.length) { const transferInsert = await supabase.from('finance_transfers').insert(transfers); if (transferInsert.error) { await supabase.from('finance_receivables').delete().eq('finance_sale_id', sale.id).eq('organization_id', user.organizationId); fail(transferInsert.error); } }
  const updated = await supabase.from('finance_sales').update({ product_rule_id: rule.id, implantation_date: implantationDate, first_receivable_date: firstDate, rule_snapshot: rule, broker_rule_snapshot: brokerRule, status: 'scheduled' }).eq('id', sale.id).eq('organization_id', user.organizationId).select('*').single(); fail(updated.error);
  await audit(user, 'sale', sale.id, 'scheduled', { receivables: receivables.length, transfers: transfers.length }); return updated.data;
}
async function confirmPayment(user, table, id, body) {
  const current = await supabase.from(table).select('*').eq('id', id).eq('organization_id', user.organizationId).single(); fail(current.error);
  const paidAt = body.paidAt ? new Date(body.paidAt).toISOString() : new Date().toISOString();
  const expected = table === 'finance_receivables' ? current.data.net_amount : current.data.expected_amount;
  const update = { status: 'paid', paid_amount: calculator.amount(body.paidAmount ?? expected), paid_at: paidAt, notes: clean(body.notes, 1000) || null, confirmed_by: user.id };
  if (table === 'finance_transfers') update.advanced = new Date(paidAt) < new Date(`${current.data.due_date}T00:00:00Z`);
  const result = await supabase.from(table).update(update).eq('id', id).eq('organization_id', user.organizationId).select('*').single(); fail(result.error);
  await audit(user, table === 'finance_receivables' ? 'receivable' : 'transfer', id, 'paid', update); return result.data;
}

module.exports = { activate, confirmPayment, createBrokerRule, createProduct, listProducts, listSales, rows, scheduleSale, settings, syncClosings };
