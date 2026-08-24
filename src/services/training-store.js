const fs = require('fs');
const crypto = require('crypto');
const supabase = require('../database/supabase');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trainingFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    youtubeId: row.youtube_id,
    track: row.track,
    description: row.description || '',
    stars: Number(row.stars || 0),
    order: Number(row.sort_order || 0),
    active: row.active !== false,
    ownerType: row.owner_type || 'admin',
    ownerUserId: row.owner_user_id || null,
    ownerName: row.owner_name || null,
    organizationId: row.organization_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function progressFromRow(row) {
  return {
    id: row.id,
    trainingId: row.training_id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    userRole: row.user_role,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    watchedSeconds: Number(row.watched_seconds || 0),
    currentTime: Number(row.current_time || 0),
    duration: Number(row.duration || 0),
    percent: Number(row.percent || 0),
    status: row.status || 'in_progress',
    startedAt: row.started_at,
    lastViewedAt: row.last_viewed_at,
    completedAt: row.completed_at
  };
}

function trainingToRow(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    youtube_id: item.youtubeId,
    track: item.track || 'Geral',
    description: item.description || '',
    stars: Number(item.stars || 0),
    sort_order: Number(item.order || 0),
    active: item.active !== false,
    owner_type: item.ownerType || 'admin',
    owner_user_id: item.ownerUserId || null,
    owner_name: item.ownerName || null,
    organization_id: item.organizationId || null,
    created_at: item.createdAt || new Date().toISOString(),
    updated_at: item.updatedAt || new Date().toISOString()
  };
}

function progressToRow(item) {
  return {
    id: item.id,
    training_id: item.trainingId,
    user_id: item.userId,
    user_name: item.userName || null,
    user_email: item.userEmail || null,
    user_role: item.userRole || null,
    organization_id: item.organizationId || null,
    organization_name: item.organizationName || null,
    watched_seconds: Number(item.watchedSeconds || 0),
    current_time: Number(item.currentTime || 0),
    duration: Number(item.duration || 0),
    percent: Number(item.percent || 0),
    status: item.status || 'in_progress',
    started_at: item.startedAt || new Date().toISOString(),
    last_viewed_at: item.lastViewedAt || new Date().toISOString(),
    completed_at: item.completedAt || null
  };
}

function readArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function ensureLegacyImported(trainingFile, progressFile) {
  const environment = process.env.NODE_ENV || 'development';
  const importKey = `training-json-v1:${environment}`;
  const existing = await supabase.from('training_data_imports').select('import_key').eq('import_key', importKey).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;

  // Do not seal an empty import before a persistent volume or a recovered
  // legacy file is mounted. New records can still be created in Supabase.
  if (!fs.existsSync(trainingFile) && !fs.existsSync(progressFile)) return;

  const legacyTrainings = readArray(trainingFile);
  const idMap = new Map();
  const trainingRows = legacyTrainings.map((item) => {
    const oldId = String(item.id || '');
    const id = UUID.test(oldId) ? oldId : crypto.randomUUID();
    if (oldId) idMap.set(oldId, id);
    return trainingToRow({ ...item, id, ownerType: item.ownerType || 'admin', organizationId: item.ownerType === 'supervisor' ? item.organizationId : null });
  });
  if (trainingRows.length) {
    const saved = await supabase.from('training_contents').upsert(trainingRows, { onConflict: 'id', ignoreDuplicates: true });
    if (saved.error) throw saved.error;
  }

  const validTrainingIds = new Set(trainingRows.map((item) => item.id));
  const progressRows = readArray(progressFile).map((item) => ({ ...item, trainingId: idMap.get(String(item.trainingId || '')) || item.trainingId }))
    .filter((item) => UUID.test(String(item.userId || '')) && UUID.test(String(item.trainingId || '')) && (validTrainingIds.has(item.trainingId) || !legacyTrainings.length))
    .map((item) => progressToRow({ ...item, id: UUID.test(String(item.id || '')) ? item.id : crypto.randomUUID() }));
  if (progressRows.length) {
    const saved = await supabase.from('training_progress').upsert(progressRows, { onConflict: 'training_id,user_id', ignoreDuplicates: true });
    if (saved.error) throw saved.error;
  }
  const marked = await supabase.from('training_data_imports').insert({ import_key: importKey, trainings_count: trainingRows.length, progress_count: progressRows.length });
  if (marked.error && marked.error.code !== '23505') throw marked.error;
}

async function listTrainings() {
  const { data, error } = await supabase.from('training_contents').select('*').order('track').order('sort_order').order('title');
  if (error) throw error;
  return (data || []).map(trainingFromRow);
}

async function getTraining(id) {
  const { data, error } = await supabase.from('training_contents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? trainingFromRow(data) : null;
}

async function createTraining(item) {
  const row = trainingToRow({ ...item, id: item.id || crypto.randomUUID() });
  const { data, error } = await supabase.from('training_contents').insert(row).select().single();
  if (error) throw error;
  return trainingFromRow(data);
}

async function updateTraining(id, item) {
  const row = trainingToRow({ ...item, id });
  delete row.id; delete row.created_at;
  const { data, error } = await supabase.from('training_contents').update(row).eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data ? trainingFromRow(data) : null;
}

async function deleteTraining(id) {
  const { data, error } = await supabase.from('training_contents').delete().eq('id', id).select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function listProgress(filters = {}) {
  let query = supabase.from('training_progress').select('*');
  if (filters.trainingId) query = query.eq('training_id', filters.trainingId);
  if (filters.userId) query = query.eq('user_id', filters.userId);
  if (filters.organizationId) query = query.eq('organization_id', filters.organizationId);
  if (filters.userRole) query = query.eq('user_role', filters.userRole);
  const { data, error } = await query.order('last_viewed_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(progressFromRow);
}

async function saveProgress(item) {
  const row = progressToRow({ ...item, id: item.id || crypto.randomUUID() });
  const { data, error } = await supabase.from('training_progress').upsert(row, { onConflict: 'training_id,user_id' }).select().single();
  if (error) throw error;
  return progressFromRow(data);
}

module.exports = { ensureLegacyImported, listTrainings, getTraining, createTraining, updateTraining, deleteTraining, listProgress, saveProgress };
