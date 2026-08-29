'use strict';

const path = require('path');
const { LeadJsonRepository } = require('./lead-json-repository');
const { mapLeadInput } = require('./lead-mapper');
const { inspectPotentialDuplicates } = require('./lead-deduplication');

function createLeadService({ repository } = {}) {
  if (!repository || typeof repository.create !== 'function') {
    throw new Error('Lead service requires a repository with create().');
  }

  return {
    createLead(input = {}) {
      const lead = mapLeadInput(input);
      const instanceName = String(lead.instanceName || '').trim();
      if (!instanceName) throw new Error('Lead creation requires an authenticated client instance.');

      const existing = typeof repository.listByInstance === 'function'
        ? repository.listByInstance(instanceName)
        : [];
      const duplicateCandidates = inspectPotentialDuplicates(existing, lead);
      const result = repository.create(lead);

      return { ...result, duplicateCandidates };
    }
  };
}

const defaultFilePath = process.env.LEADS_FILE_PATH || path.join(__dirname, '..', '..', '..', 'data', 'leads.json');
const defaultLeadService = createLeadService({ repository: new LeadJsonRepository({ filePath: defaultFilePath }) });

module.exports = { createLeadService, defaultLeadService };
