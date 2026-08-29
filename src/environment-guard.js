'use strict';

const path = require('path');

const PRODUCTION_SUPABASE_PROJECT_REF = 'bnceclhjhgjfirubudwi';
const STAGING_SUPABASE_PROJECT_REF = 'hgqtanlzajogxrfbchrl';

const STAGING_FILES = Object.freeze({
  CLIENTS_FILE_PATH: 'clientes.json',
  LEADS_FILE_PATH: 'leads.json',
  CUSTOMER_CLIENTS_FILE_PATH: 'customer_clients.json',
  ACCESS_TOKENS_FILE_PATH: 'access-tokens.json',
  INSTANCES_FILE_PATH: 'instances.json',
  CRM_AUTO_CONVERSATION_LOG_FILE: 'auto_conversation_events.json',
  CRM_EVOLUTION_CAPTURE_LOG_FILE: 'evolution_capture_events.json',
  CRM_LABEL_WEBHOOK_LOG_FILE: 'label_webhook_events.json',
  CRM_RECENT_SYNC_LOG_FILE: 'recent_conversation_sync.json',
  CALENDAR_EVENTS_FILE_PATH: 'calendar-events.json',
  CAMPAIGN_MEDIA_FILE_PATH: 'campaign-media.json',
  RECRUITMENT_FILE_PATH: 'recruitment.json',
  TEAM_GOALS_FILE_PATH: 'team-goals.json',
  TEAM_MESSAGES_FILE_PATH: 'team-messages.json',
  TERMS_ACCEPTANCE_FILE_PATH: 'terms-acceptance.json',
  TRAININGS_FILE_PATH: 'trainings.json',
  TRAINING_PROGRESS_FILE_PATH: 'training-progress.json'
});

function clean(value) {
  return String(value || '').trim();
}

function projectRefFromUrl(value) {
  const url = new URL(clean(value));
  return url.hostname.split('.')[0].toLowerCase();
}

function isInside(baseDir, targetPath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function applyStagingDefaults(env, dataDir) {
  for (const [name, fileName] of Object.entries(STAGING_FILES)) {
    if (!clean(env[name])) env[name] = path.join(dataDir, fileName);
  }
}

function assertEnvironmentIsolation(env = process.env) {
  const explicitAppEnv = clean(env.APP_ENV).toLowerCase();
  const nodeEnv = clean(env.NODE_ENV).toLowerCase();
  if (explicitAppEnv && nodeEnv && explicitAppEnv !== nodeEnv) {
    throw new Error(`[environment-guard] APP_ENV (${explicitAppEnv}) and NODE_ENV (${nodeEnv}) must match.`);
  }
  const appEnv = explicitAppEnv || nodeEnv;
  if (appEnv !== 'staging') return { environment: appEnv || 'development', protected: false };

  const supabaseUrl = clean(env.SUPABASE_URL);
  if (!supabaseUrl) throw new Error('[environment-guard] SUPABASE_URL is required in staging.');

  let projectRef;
  try {
    projectRef = projectRefFromUrl(supabaseUrl);
  } catch {
    throw new Error('[environment-guard] SUPABASE_URL is invalid.');
  }

  const expectedRef = clean(env.STAGING_SUPABASE_PROJECT_REF || STAGING_SUPABASE_PROJECT_REF).toLowerCase();
  const productionRef = clean(env.PRODUCTION_SUPABASE_PROJECT_REF || PRODUCTION_SUPABASE_PROJECT_REF).toLowerCase();
  if (projectRef === productionRef) {
    throw new Error('[environment-guard] Startup blocked: staging points to the production Supabase project.');
  }
  if (projectRef !== expectedRef) {
    throw new Error(`[environment-guard] Startup blocked: expected staging Supabase project ${expectedRef}, received ${projectRef}.`);
  }

  const dataDir = path.resolve(clean(env.DATA_DIR || '/data-staging'));
  env.DATA_DIR = dataDir;
  applyStagingDefaults(env, dataDir);

  for (const name of Object.keys(STAGING_FILES)) {
    if (!isInside(dataDir, env[name])) {
      throw new Error(`[environment-guard] Startup blocked: ${name} must be inside DATA_DIR (${dataDir}).`);
    }
  }

  return { environment: appEnv, protected: true, projectRef, dataDir };
}

const result = assertEnvironmentIsolation();
if (result.protected) {
  console.info(`[environment-guard] Staging isolation verified for ${result.projectRef}; data directory: ${result.dataDir}`);
}

module.exports = {
  PRODUCTION_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_FILES,
  assertEnvironmentIsolation,
  projectRefFromUrl
};
