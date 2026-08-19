const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAccess } = require('../middleware/require-access');
const { sendRecruitmentEmail, sendRecruitmentRejectionEmail } = require('../services/access-email');

const router = express.Router();
const FILE = process.env.RECRUITMENT_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/recruitment.json' : path.resolve(__dirname, '../../data/recruitment.json'));
const STAGES = new Set(['novo', 'teste_enviado', 'teste_realizado', 'triagem', 'contato', 'entrevista', 'aprovado', 'recusado']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISC_TARGET = { D: 35, I: 25, S: 15, C: 25 };
const TRAITS = ['D', 'I', 'S', 'C'];
function load() { try { const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); return data && typeof data === 'object' ? data : { vacancies: [], candidates: [] }; } catch { return { vacancies: [], candidates: [] }; } }
function save(data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }
function slug(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48); }
function tokenHash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function publicFrontendUrl() { return String(process.env.LUNGO_RECRUITMENT_URL || (process.env.NODE_ENV === 'staging' ? 'https://staging-crm.lungocorretores.com.br/disc-demo.html' : 'https://crm.lungocorretores.com.br/disc-demo.html')).trim(); }
function candidateByToken(data, token) { const hash = tokenHash(token); return data.candidates.find((candidate) => candidate.disc?.tokenHash === hash); }
function scoreDisc(answers) {
  const most = { D: 0, I: 0, S: 0, C: 0 }, least = { D: 0, I: 0, S: 0, C: 0 };
  answers.forEach((answer) => { most[TRAITS[answer.most]] += 1; least[TRAITS[answer.least]] += 1; });
  const raw = Object.fromEntries(TRAITS.map((trait) => [trait, answers.length + most[trait] - least[trait]]));
  const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0);
  const scores = Object.fromEntries(TRAITS.map((trait) => [trait, Math.round((raw[trait] / rawTotal) * 100)]));
  const lead = TRAITS.reduce((current, trait) => scores[current] >= scores[trait] ? current : trait);
  scores[lead] += 100 - Object.values(scores).reduce((sum, value) => sum + value, 0);
  const distance = TRAITS.reduce((sum, trait) => sum + Math.abs(scores[trait] - DISC_TARGET[trait]), 0), normalized = (value) => Math.min(100, Math.round(value * 2.25));
  return { scores, most, least, predominant: lead, match: Math.max(40, Math.min(98, Math.round(100 - distance * .62))), indicators: { commercialDrive: normalized(scores.D * .7 + scores.I * .3), autonomy: normalized(scores.D * .75 + scores.C * .25), discipline: normalized(scores.C * .6 + scores.S * .4), processAdherence: normalized(scores.C * .7 + scores.S * .3) } };
}
function vacancyFor(data, user) { let item = data.vacancies.find((v) => v.organizationId === user.organizationId); if (!item) { item = { organizationId: user.organizationId, slug: `${slug(user.organization?.name || 'corretora')}-${user.organizationId.slice(0, 6)}`, companyName: user.organization?.name || 'Corretora', logo: '', title: 'Consultor de Planos de Saúde', headline: 'Venha construir sua carreira conosco', description: '', requirements: '', benefits: '', workModel: 'Presencial', location: '', active: false, updatedAt: new Date().toISOString() }; data.vacancies.push(item); } return item; }

router.get('/api/supervisor/recruitment', requireAccess('supervisor'), (req, res) => { const data = load(); const vacancy = vacancyFor(data, req.accessUser); save(data); const candidates = data.candidates.filter((c) => c.organizationId === req.accessUser.organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ disc, ...candidate }) => ({ ...candidate, disc: disc ? { sentAt: disc.sentAt || null, completedAt: disc.completedAt || null, emailSent: Boolean(disc.emailSent), result: disc.result || null } : null })); res.json({ ok: true, vacancy, candidates }); });
router.patch('/api/supervisor/recruitment/vacancy', requireAccess('supervisor'), (req, res) => { const data = load(); const item = vacancyFor(data, req.accessUser); const body = req.body || {}; ['title','headline','description','requirements','benefits','workModel','location','companyName'].forEach((key) => { if (key in body) item[key] = String(body[key] || '').trim().slice(0, key === 'title' ? 120 : 5000); }); if ('logo' in body) item.logo = String(body.logo || '').startsWith('data:image/') ? String(body.logo).slice(0, 1800000) : ''; if ('active' in body) item.active = Boolean(body.active); if (body.slug) item.slug = `${slug(body.slug)}-${req.accessUser.organizationId.slice(0, 6)}`; item.updatedAt = new Date().toISOString(); save(data); res.json({ ok: true, vacancy: item }); });
router.patch('/api/supervisor/recruitment/candidates/:id', requireAccess('supervisor'), (req, res) => { const data = load(); const item = data.candidates.find((c) => c.id === req.params.id && c.organizationId === req.accessUser.organizationId); if (!item) return res.status(404).json({ ok: false, error: 'Candidato não encontrado.' }); if (req.body.stage) { if (!STAGES.has(req.body.stage)) return res.status(400).json({ ok: false, error: 'Etapa inválida.' }); item.stage = req.body.stage; } if ('notes' in req.body) item.notes = String(req.body.notes || '').trim().slice(0, 3000); if ('hirePending' in req.body) item.hirePending = Boolean(req.body.hirePending); if ('hiredUserId' in req.body) item.hiredUserId = String(req.body.hiredUserId || ''); if (req.body.seen) item.seenAt ||= new Date().toISOString(); item.updatedAt = new Date().toISOString(); save(data); res.json({ ok: true, candidate: item }); });
router.delete('/api/supervisor/recruitment/candidates/:id', requireAccess('supervisor'), (req, res) => { const data = load(); const index = data.candidates.findIndex((c) => c.id === req.params.id && c.organizationId === req.accessUser.organizationId); if (index < 0) return res.status(404).json({ ok: false, error: 'Candidato não encontrado.' }); data.candidates.splice(index, 1); save(data); res.json({ ok: true }); });
router.post('/api/supervisor/recruitment/candidates/seen', requireAccess('supervisor'), (req, res) => { const data = load(); const now = new Date().toISOString(); data.candidates.filter((c) => c.organizationId === req.accessUser.organizationId && !c.seenAt).forEach((c) => { c.seenAt = now; }); save(data); res.json({ ok: true }); });

router.post('/api/supervisor/recruitment/candidates/:id/disc/send', requireAccess('supervisor'), async (req, res) => {
  const data = load(), item = data.candidates.find((c) => c.id === req.params.id && c.organizationId === req.accessUser.organizationId);
  if (!item) return res.status(404).json({ ok: false, error: 'Candidato não encontrado.' });
  if (!EMAIL.test(String(item.email || '').trim())) return res.status(400).json({ ok: false, error: 'O candidato precisa ter um e-mail válido.' });
  if (item.disc?.completedAt) return res.status(409).json({ ok: false, error: 'Este candidato já concluiu a avaliação.' });
  const vacancy = data.vacancies.find((value) => value.slug === item.vacancySlug) || vacancyFor(data, req.accessUser);
  const token = crypto.randomBytes(32).toString('base64url'), testUrl = `${publicFrontendUrl()}?token=${encodeURIComponent(token)}`, now = new Date().toISOString();
  try {
    const delivery = await sendRecruitmentEmail({ email: item.email, name: item.name, organizationName: vacancy.companyName || req.accessUser.organization?.name, vacancyTitle: vacancy.title, testUrl });
    item.disc = { tokenHash: tokenHash(token), sentAt: now, completedAt: null, emailSent: true, messageId: delivery.messageId || null, result: null };
    item.stage = 'teste_enviado'; item.updatedAt = now; save(data);
    return res.json({ ok: true, sent: true, recipient: item.email, previewUrl: testUrl });
  } catch (error) { console.error('Recruitment DISC email failed:', error.message); return res.status(502).json({ ok: false, error: 'Não foi possível enviar o e-mail do teste. Verifique a configuração do e-mail.' }); }
});

router.post('/api/supervisor/recruitment/candidates/:id/decline', requireAccess('supervisor'), async (req, res) => {
  const data = load(), item = data.candidates.find((c) => c.id === req.params.id && c.organizationId === req.accessUser.organizationId);
  if (!item) return res.status(404).json({ ok: false, error: 'Candidato não encontrado.' });
  if (!EMAIL.test(String(item.email || '').trim())) return res.status(400).json({ ok: false, error: 'O candidato precisa ter um e-mail válido.' });
  const vacancy = data.vacancies.find((value) => value.slug === item.vacancySlug) || vacancyFor(data, req.accessUser), message = String(req.body?.message || '').trim().slice(0, 2000);
  try { const delivery = await sendRecruitmentRejectionEmail({ email: item.email, name: item.name, organizationName: vacancy.companyName || req.accessUser.organization?.name, vacancyTitle: vacancy.title, message }); item.stage = 'recusado'; item.declinedAt = new Date().toISOString(); item.declineMessage = message; item.updatedAt = item.declinedAt; save(data); return res.json({ ok: true, sent: true, recipient: item.email, messageId: delivery.messageId || null }); }
  catch (error) { console.error('Recruitment rejection email failed:', error.message); return res.status(502).json({ ok: false, error: 'Não foi possível enviar o e-mail de retorno.' }); }
});

router.get('/api/public/recruitment/disc/:token', (req, res) => {
  const data = load(), item = candidateByToken(data, req.params.token);
  if (!item) return res.status(404).json({ ok: false, error: 'Este link é inválido ou foi descontinuado.' });
  if (item.disc?.completedAt) return res.status(410).json({ ok: false, completed: true, error: 'Esta avaliação já foi finalizada. Você pode fechar esta página.' });
  const vacancy = data.vacancies.find((value) => value.slug === item.vacancySlug);
  return res.json({ ok: true, candidate: { name: item.name }, vacancy: { title: vacancy?.title || 'Consultor comercial', companyName: vacancy?.companyName || 'Lungo Corretores', logo: vacancy?.logo || '' } });
});

router.post('/api/public/recruitment/disc/:token/complete', (req, res) => {
  const data = load(), item = candidateByToken(data, req.params.token);
  if (!item) return res.status(404).json({ ok: false, error: 'Este link é inválido ou foi descontinuado.' });
  if (item.disc?.completedAt) return res.status(410).json({ ok: false, completed: true, error: 'Esta avaliação já foi finalizada.' });
  const answers = req.body?.answers;
  if (!Array.isArray(answers) || answers.length !== 12 || answers.some((answer) => !answer || !Number.isInteger(answer.most) || !Number.isInteger(answer.least) || answer.most < 0 || answer.most > 3 || answer.least < 0 || answer.least > 3 || answer.most === answer.least)) return res.status(400).json({ ok: false, error: 'Selecione uma opção diferente em Sou mais e Sou menos em todas as situações.' });
  const now = new Date().toISOString(); item.disc.result = scoreDisc(answers); item.disc.completedAt = now; item.stage = 'teste_realizado'; item.seenAt = null; item.updatedAt = now; save(data);
  return res.json({ ok: true, completed: true });
});

router.get('/api/public/vacancies/:slug', (req, res) => { const item = load().vacancies.find((v) => v.slug === req.params.slug && v.active); if (!item) return res.status(404).json({ ok: false, error: 'Vaga indisponível.' }); const { organizationId, ...vacancy } = item; res.json({ ok: true, vacancy }); });
router.post('/api/public/vacancies/:slug/apply', (req, res) => { const data = load(); const vacancy = data.vacancies.find((v) => v.slug === req.params.slug && v.active); if (!vacancy) return res.status(404).json({ ok: false, error: 'Vaga indisponível.' }); if (req.body?.website) return res.status(201).json({ ok: true }); const name = String(req.body?.name || '').trim(), phone = String(req.body?.phone || '').replace(/\D/g, ''), email = String(req.body?.email || '').trim(); if (name.length < 2 || phone.length < 10) return res.status(400).json({ ok: false, error: 'Informe nome e WhatsApp válidos.' }); const recent = data.candidates.find((c) => c.vacancySlug === vacancy.slug && c.phone === phone && Date.now() - Date.parse(c.createdAt) < 10 * 60 * 1000); if (recent) return res.status(200).json({ ok: true, candidateId: recent.id, duplicate: true }); const now = new Date().toISOString(); const item = { id: crypto.randomUUID(), organizationId: vacancy.organizationId, vacancySlug: vacancy.slug, name, phone, email, city: String(req.body?.city || '').trim(), experience: String(req.body?.experience || '').trim(), resumeUrl: String(req.body?.resumeUrl || '').trim(), message: String(req.body?.message || '').trim(), stage: 'novo', notes: '', seenAt: null, hirePending: false, hiredUserId: '', createdAt: now, updatedAt: now }; data.candidates.push(item); save(data); res.status(201).json({ ok: true, candidateId: item.id }); });

module.exports = router;
