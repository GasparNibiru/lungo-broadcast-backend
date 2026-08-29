'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LeadJsonRepository } = require('../src/modules/leads/lead-json-repository');
const { createLeadService } = require('../src/modules/leads/lead-service');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lungo-leads-'));
  const filePath = path.join(directory, 'leads.json');
  fs.writeFileSync(filePath, `${JSON.stringify([{ id: 'existing', instanceName: 'tenant-a', nome: 'Existente' }], null, 2)}\n`, 'utf8');
  return {
    directory,
    filePath,
    service: createLeadService({ repository: new LeadJsonRepository({ filePath }) })
  };
}

test('creates a legacy record without changing its fields', (t) => {
  const { directory, filePath, service } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyLead = {
    id: 'lead_controlled',
    instanceName: 'tenant-a',
    nome: 'Empresa Teste',
    telefone: '5584999999999',
    email: '',
    status: 'novo',
    origem: 'Manual',
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z'
  };

  const result = service.createLead({
    source: 'Manual',
    data: legacyLead,
    context: { instanceName: 'tenant-a', preserveLegacyRecord: true }
  });
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  assert.deepEqual(result.lead, legacyLead);
  assert.deepEqual(stored, [{ id: 'existing', instanceName: 'tenant-a', nome: 'Existente' }, legacyLead]);
});

test('maps the future company prospecting contract to legacy fields', (t) => {
  const { directory, filePath, service } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = service.createLead({
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    source: 'company_prospecting',
    externalId: '12345678000190',
    data: { nome: 'Empresa Brasil', telefone: '(84) 99999-9999', email: 'contato@example.com', documento: '12.345.678/0001-90', cidade: 'Natal' },
    context: { instanceName: 'tenant-a' }
  });

  assert.equal(result.lead.telefone, '5584999999999');
  assert.equal(result.lead.cnpjOuPf, '12.345.678/0001-90');
  assert.equal(result.lead.origem, 'company_prospecting');
  assert.equal(result.lead.instanceName, 'tenant-a');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).length, 2);
});

test('observes duplicate candidates without blocking creation', (t) => {
  const { directory, service } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { organizationId: 'org-1', source: 'company_prospecting', externalId: 'cnpj-1', data: { nome: 'Primeiro', telefone: '84999999999' }, context: { instanceName: 'tenant-a' } };
  service.createLead(input);
  const second = service.createLead({ ...input, data: { nome: 'Segundo', telefone: '84999999999' } });

  assert.equal(second.duplicateCandidates.length, 1);
  assert.equal(second.leads.length, 3);
});
