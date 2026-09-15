'use strict';

const { createClient } = require('@supabase/supabase-js');

const AUTHORIZED_PROJECT_REF = 'fmktrtyahaudefcymrvm';
let client;

function projectRefFromUrl(value) {
  const url = new URL(String(value || '').trim());
  return url.hostname.split('.')[0].toLowerCase();
}

function getBusinessIntelligenceSupabase() {
  if (client) return client;

  const url = String(process.env.BUSINESS_INTELLIGENCE_SUPABASE_URL || '').trim();
  const key = String(process.env.BUSINESS_INTELLIGENCE_SUPABASE_KEY || '').trim();
  if (!url || !key) {
    throw new Error('Business Intelligence Supabase is not configured.');
  }

  let projectRef;
  try {
    projectRef = projectRefFromUrl(url);
  } catch {
    throw new Error('Business Intelligence Supabase URL is invalid.');
  }
  if (projectRef !== AUTHORIZED_PROJECT_REF) {
    throw new Error('Business Intelligence Supabase project is not authorized.');
  }

  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
  return client;
}

module.exports = { AUTHORIZED_PROJECT_REF, getBusinessIntelligenceSupabase, projectRefFromUrl };
