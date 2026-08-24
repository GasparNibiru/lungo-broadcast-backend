const express = require('express');
const path = require('path');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');
const store = require('../services/training-store');

const router = express.Router();
const baseDataDir = process.env.NODE_ENV === 'staging' ? '/data-staging' : process.env.NODE_ENV === 'production' ? '/data' : path.resolve(__dirname, '../../data');
const TRAININGS_FILE = process.env.TRAININGS_FILE_PATH || path.join(baseDataDir, 'trainings.json');
const PROGRESS_FILE = process.env.TRAINING_PROGRESS_FILE_PATH || path.join(baseDataDir, 'training-progress.json');
const prepare = () => store.ensureLegacyImported(TRAININGS_FILE, PROGRESS_FILE);

function youtubeId(url) { try { const parsed = new URL(url); if (parsed.hostname.includes('youtu.be')) return parsed.pathname.slice(1).split('/')[0]; if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop(); } catch {} return ''; }
function payload(body, current = {}) {
  const title = String(body.title ?? current.title ?? '').trim(), url = String(body.url ?? current.url ?? '').trim();
  const track = String(body.track ?? current.track ?? 'Geral').trim() || 'Geral', description = String(body.description ?? current.description ?? '').trim();
  const stars = Math.max(0, Math.min(5, Number(body.stars ?? current.stars ?? 0) || 0)), order = Math.max(0, Number(body.order ?? current.order ?? 0) || 0);
  if (title.length < 2) throw Object.assign(new Error('Informe o nome do treinamento.'), { statusCode: 400 });
  if (!youtubeId(url)) throw Object.assign(new Error('Informe um link válido do YouTube.'), { statusCode: 400 });
  return { ...current, title, url, youtubeId: youtubeId(url), track, description, stars, order, active: body.active === undefined ? current.active !== false : Boolean(body.active) };
}

router.get('/api/trainings', requireAccess(['supervisor', 'broker']), async (_req, res, next) => { try { await prepare(); res.json({ ok: true, trainings: (await store.listTrainings()).filter((item) => item.active !== false) }); } catch (error) { next(error); } });
router.get('/api/admin/trainings', requireAdmin, async (_req, res, next) => { try { await prepare(); res.json({ ok: true, trainings: await store.listTrainings() }); } catch (error) { next(error); } });
router.post('/api/admin/trainings', requireAdmin, async (req, res, next) => { try { await prepare(); const training = await store.createTraining({ ...payload(req.body), ownerType: 'admin' }); res.status(201).json({ ok: true, training }); } catch (error) { next(error); } });
router.patch('/api/admin/trainings/:id', requireAdmin, async (req, res, next) => { try { await prepare(); const current = await store.getTraining(req.params.id); if (!current) return res.status(404).json({ ok: false, error: 'Treinamento não encontrado.' }); const training = await store.updateTraining(req.params.id, { ...payload(req.body, current), updatedAt: new Date().toISOString() }); res.json({ ok: true, training }); } catch (error) { next(error); } });
router.delete('/api/admin/trainings/:id', requireAdmin, async (req, res, next) => { try { await prepare(); if (!await store.deleteTraining(req.params.id)) return res.status(404).json({ ok: false, error: 'Treinamento não encontrado.' }); res.json({ ok: true }); } catch (error) { next(error); } });

module.exports = router;
