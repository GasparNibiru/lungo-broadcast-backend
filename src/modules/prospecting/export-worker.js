'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FIELDS, pick } = require('./privacy');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const workerId = crypto.randomUUID();
let running = false;

function readArray(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(value)) throw new Error('invalid_json_array'); return value; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function writeExportLead(file, job, right, instanceName) {
  if (!uuid.test(job.id) || !uuid.test(job.operation_key) || !instanceName) throw new Error('invalid_export_identity');
  const snapshot = pick(right.snapshot);
  if (!/^\d{14}$/.test(snapshot.cnpj) || !snapshot.legal_name || !/^\d{10,15}$/.test(snapshot.mobile_1)) throw new Error('invalid_export_snapshot');
  const id = `prospecting_${job.id}`;
  const leads = readArray(file);
  const existing = leads.find(lead => lead.prospectingExportId === job.id || lead.id === id);
  if (existing) {
    if (existing.id !== id || existing.prospectingExportId !== job.id || existing.prospectingRightId !== right.id || existing.ownerUserId !== job.owner_user_id) throw new Error('export_identity_conflict');
    return id;
  }
  const now = new Date().toISOString();
  leads.push({ id, instanceName, nome: snapshot.legal_name, telefone: snapshot.mobile_1,
    email: snapshot.email || '', pessoaTipo: 'PJ', tipoPessoa: 'PJ', cnpjOuPf: snapshot.cnpj,
    cidade: snapshot.city || '', estado: snapshot.state || '', origem: 'Prospecção de Empresas',
    status: 'novo', organizationId: job.organization_id, ownerUserId: job.owner_user_id,
    prospectingRightId: right.id, prospectingExportId: job.id, prospectingOperationKey: job.operation_key,
    observacao: 'Empresa adquirida na Prospecção de Empresas.', createdAt: now, updatedAt: now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${job.id}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(leads, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return id;
}

async function processJob(db, job, files = {}) {
  const { data: right, error: rightError } = await db.from('prospecting_user_companies')
    .select(`id,user_id,snapshot:prospecting_company_snapshots(${FIELDS.join(',')})`)
    .eq('id', job.user_company_id).eq('user_id', job.owner_user_id).single();
  if (rightError || !right || right.user_id !== job.owner_user_id || !right.snapshot) throw new Error('export_right_unavailable');
  const client = readArray(files.clients || process.env.CLIENTS_FILE_PATH || path.join(process.cwd(), 'data', 'clientes.json'))
    .find(item => item.accessUserId === job.owner_user_id && item.ativo !== false && item.organizationId === job.organization_id);
  if (!client?.instanceName) throw new Error('export_client_unavailable');
  return writeExportLead(files.leads || process.env.LEADS_FILE_PATH || path.join(process.cwd(), 'data', 'leads.json'), job, right, client.instanceName);
}

async function runOnce(db, files = {}) {
  if (running) return;
  running = true;
  try {
    const { data: jobs, error } = await db.rpc('prospecting_claim_jobs', { p_kind: 'export', p_worker: workerId, p_limit: 10 });
    if (error) throw error;
    for (const job of jobs || []) {
      let result = 'unknown', leadId = null, code = 'export_result_ambiguous';
      try { leadId = await processJob(db, job, files); result = 'success'; code = null; }
      catch (error) { code = String(error.message || 'export_failed').slice(0, 100); }
      const finished = await db.rpc('prospecting_finish_job', { p_kind: 'export', p_job: job.id, p_worker: workerId,
        p_lease: job.lease_token, p_outcome: result, p_external_id: leadId, p_error: code });
      if (finished.error || finished.data !== true) console.error('[PROSPECTING EXPORT] Job needs reconciliation', job.id);
    }
  } finally { running = false; }
}

function start(db, files = {}) {
  const environment = process.env.APP_ENV || process.env.NODE_ENV;
  if (!['staging','production'].includes(environment)) return;
  const tick = () => runOnce(db, files).catch(error => console.error('[PROSPECTING EXPORT]', error.message));
  setTimeout(tick, 3000);
  const timer = setInterval(tick, 15000);
  timer.unref();
}

module.exports = { writeExportLead, processJob, runOnce, start };
