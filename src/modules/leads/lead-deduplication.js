'use strict';

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function inspectPotentialDuplicates(leads, candidate) {
  const organization = clean(candidate.organizationId);
  const document = digits(candidate.cnpjOuPf || candidate.documento);
  const phone = digits(candidate.telefone);
  const source = clean(candidate.origem || candidate.source);
  const externalId = clean(candidate.externalId);

  return (Array.isArray(leads) ? leads : []).filter((lead) => {
    const sameOrganization = organization && clean(lead.organizationId) === organization;
    if (sameOrganization && document && digits(lead.cnpjOuPf || lead.documento) === document) return true;
    if (sameOrganization && phone && digits(lead.telefone) === phone) return true;
    return source && externalId && clean(lead.origem || lead.source) === source && clean(lead.externalId) === externalId;
  });
}

module.exports = { inspectPotentialDuplicates };
