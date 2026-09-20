const fs = require('fs');
const path = require('path');
function file() { return process.env.RECRUITMENT_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/recruitment.json' : path.resolve(__dirname, '../../data/recruitment.json')); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch(error) { if(error.code === 'ENOENT') return {vacancies:[],candidates:[]}; throw error; } }
function save(data) { fs.mkdirSync(path.dirname(file()), {recursive:true}); fs.writeFileSync(file(), JSON.stringify(data,null,2)+'\n','utf8'); }
const norm = value => String(value || '').trim().toLowerCase();
function legacyMatch(candidate, broker) {
  return !candidate.dismissedAt && !candidate.hiredUserId && (candidate.hirePending || candidate.stage === 'aprovado') && norm(candidate.email) && norm(candidate.email) === norm(broker.email) && (norm(candidate.name) === norm(broker.name) || (String(candidate.phone || '').replace(/\D/g,'').length >= 10 && String(candidate.phone).replace(/\D/g,'') === String(broker.phone || '').replace(/\D/g,'')));
}
function reconcile(organizationId, brokers) {
  const data=load(); let changed=false;
  for (const c of data.candidates.filter(c=>c.organizationId===organizationId && c.hiredUserId && !c.dismissedAt)) {
    const broker=brokers.find(b=>b.id===c.hiredUserId);if(!broker)continue;
    for(const field of ['name','email','phone'])if(broker[field]!==undefined && c[field]!==broker[field]){c[field]=broker[field];changed=true;}
  }
  for(const broker of brokers.filter(b=>b.tokenActive)) {
    const scoped=data.candidates.filter(c=>c.organizationId===organizationId);
    if(scoped.some(c=>c.hiredUserId===broker.id)) continue;
    const matches=scoped.filter(c=>legacyMatch(c,broker));
    if(matches.length!==1) continue;
    const c=matches[0]; c.hiredUserId=broker.id;c.hirePending=false;c.stage='aprovado';
    if(broker.createdAt)c.accessGrantedAt ||= broker.createdAt;
    c.updatedAt=new Date().toISOString(); changed=true;
  }
  for (const broker of brokers.filter(b=>b.status==='active')) {
    if(data.candidates.some(c=>c.organizationId===organizationId && c.hiredUserId===broker.id))continue;
    const now=new Date().toISOString();
    data.candidates.push({id:require('crypto').randomUUID(),organizationId,source:'broker_registry',name:broker.name,email:broker.email||'',phone:broker.phone||'',hiredUserId:broker.id,hirePending:false,stage:'aprovado',createdAt:broker.createdAt||now,accessGrantedAt:broker.createdAt||null,approvedAt:null,seenAt:now,updatedAt:now});
    changed=true;
  }
  if(changed)save(data);
}
function removeBroker(organizationId, broker) {
  const data=load();const matches=data.candidates.filter(c=>c.organizationId===organizationId && legacyMatch(c,broker));
  for (const c of data.candidates.filter(c=>c.organizationId===organizationId && (c.hiredUserId===broker.id || (matches.length===1 && c.id===matches[0].id)))) {
    c.hiredUserId=broker.id;c.hirePending=false;c.stage='aprovado';c.accessRemovedAt ||= new Date().toISOString();c.updatedAt=new Date().toISOString();
  }
  save(data);
}
function blocked(data, organizationId, email, phone) {
 const digits=value=>String(value||'').replace(/\D/g,'');
 return data.candidates.some(c=>c.organizationId===organizationId && c.dismissedAt && ((norm(email) && norm(email)===norm(c.email)) || (digits(phone).length>=10 && digits(phone)===digits(c.phone))));
}
module.exports={load,save,reconcile,removeBroker,legacyMatch,blocked};
