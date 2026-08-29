'use strict';

const fs = require('fs');
const path = require('path');
const LeadRepository = require('./lead-repository');

function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

class LeadJsonRepository extends LeadRepository {
  constructor({ filePath } = {}) {
    super();
    if (!filePath) throw new Error('LeadJsonRepository requires a filePath.');
    this.filePath = filePath;
  }

  create(lead) {
    const leads = loadArray(this.filePath);
    leads.push(lead);
    saveArray(this.filePath, leads);
    return { lead, leads };
  }

  listByInstance(instanceName) {
    const wanted = String(instanceName || '').trim();
    return loadArray(this.filePath).filter((lead) => String(lead.instanceName || '').trim() === wanted);
  }
}

module.exports = { LeadJsonRepository, loadArray, saveArray };
