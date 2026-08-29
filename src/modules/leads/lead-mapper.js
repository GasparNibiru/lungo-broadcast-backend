'use strict';

const crypto = require('crypto');

function clean(value) {
  return String(value ?? '').trim();
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}

function generateId() {
  return `lead_${crypto.randomBytes(8).toString('hex')}`;
}

function mapLeadInput({ organizationId, ownerUserId, source, externalId, data = {}, context = {} }) {
  if (context.preserveLegacyRecord) return { ...data };

  const now = new Date().toISOString();
  const pessoaTipo = clean(data.pessoaTipo || data.tipoPessoa).toUpperCase();
  const documento = clean(data.documento || data.cnpjOuPf || data.cnpj || data.cpf);
  const produto = clean(data.produto || data.planoInteresse || data.planoAtual);
  const origem = clean(data.origem || source) || 'Manual';

  return {
    ...data,
    id: data.id || generateId(),
    instanceName: clean(context.instanceName || data.instanceName),
    nome: clean(data.nome || data.razaoSocial),
    telefone: normalizePhone(data.telefone || data.whatsapp || data.celular),
    email: clean(data.email),
    pessoaTipo,
    tipoPessoa: pessoaTipo,
    cnpjOuPf: documento,
    planoInteresse: produto,
    origem,
    observacao: clean(data.observacao || data.observacoes),
    cidade: clean(data.cidade),
    externalId: clean(externalId || data.externalId),
    organizationId: clean(organizationId || data.organizationId),
    ownerUserId: clean(ownerUserId || data.ownerUserId),
    status: clean(data.status) || 'novo',
    tags: Array.isArray(data.tags) ? data.tags.map(clean).filter(Boolean).slice(0, 8) : [],
    createdAt: data.createdAt || now,
    updatedAt: now
  };
}

module.exports = { clean, normalizePhone, mapLeadInput };
