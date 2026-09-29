'use strict';
const { operationalClient } = require('./service');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const userId = id => { if (!UUID.test(String(id || ''))) throw fail('Usuário inválido.'); return id; };
const pageNumber = value => { if (value === undefined) return 1; if (!/^\d+$/.test(String(value)) || +value < 1 || +value > 100000) throw fail('Página inválida.'); return +value; };
function createAdminService({ getDb = operationalClient } = {}) {
  async function result(query) { const r = await query; if (r.error) throw fail('Créditos de Prospecção indisponíveis. Verifique a implantação do backend.', 503); return r; }
  async function user(id) {
    const r = await result(getDb().from('users').select('id,name,email,role,status,organization_id,organizations!users_organization_id_fkey(name,status)').eq('id', userId(id)).in('role', ['broker','supervisor']).maybeSingle());
    if (!r.data) throw fail('Usuário não encontrado.', 404);
    return r.data;
  }
  async function wallets(ids) {
    if (!ids.length) return new Map();
    const r = await result(getDb().from('prospecting_wallets').select('user_id,free_balance,extra_balance,cycle_start,cycle_allowance,updated_at').in('user_id', ids));
    return new Map(r.data.map(w => [w.user_id, w]));
  }
  return {
    async list(q = {}) {
      const page = pageNumber(q.page), search = String(q.search || '').trim();
      if (search.length > 100 || /[^\p{L}\p{N}\s@.+_-]/u.test(search)) throw fail('Use nome ou e-mail na busca.');
      let query = getDb().from('users').select('id,name,email,role,status,organization_id,organizations!users_organization_id_fkey(name,status)', { count: 'exact' }).in('role', ['broker','supervisor']);
      if (search) { const term = search.replace(/_/g, '\\_'); query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%`); }
      const r = await result(query.order('name').order('id').range((page - 1) * 25, page * 25 - 1));
      const balances = await wallets(r.data.map(u => u.id));
      return { users: r.data.map(u => ({ ...u, wallet: balances.get(u.id) || null })), page, pages: Math.ceil(r.count / 25), total: r.count };
    },
    async detail(id, q = {}) {
      const u = await user(id), page = pageNumber(q.page);
      const balances = await wallets([id]);
      const r = await result(getDb().from('prospecting_token_movements').select('id,operation_id,movement_type,bucket,delta,balance_after,reason,created_at', { count: 'exact' }).eq('user_id', id).eq('movement_type', 'extra_credit').order('created_at', { ascending: false }).order('id').range((page - 1) * 25, page * 25 - 1));
      return { user: u, wallet: balances.get(id) || null, movements: r.data, page, pages: Math.ceil(r.count / 25) };
    },
    async credit(id, body = {}) {
      userId(id);
      if (!Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 1000000 || !UUID.test(String(body.requestId || '')) || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 500) throw fail('Informe de 1 a 1.000.000 créditos inteiros e um motivo de 3 a 500 caracteres.');
      const u = await user(id);
      if (u.status !== 'active' || u.organizations?.status !== 'active') throw fail('Usuário e corretora precisam estar ativos.', 409);
      const r = await getDb().rpc('prospecting_credit_extra', { p_user: id, p_key: body.requestId, p_amount: body.amount, p_admin_reference: 'admin-master', p_reason: body.reason.trim() });
      if (r.error) {
        if (r.error.message === 'idempotency_key_reused') throw fail('Esta operação já foi usada com outros dados. Confira o histórico.', 409);
        if (r.error.message === 'prospecting_access_denied') throw fail('Usuário ou corretora sem acesso ativo.', 409);
        throw fail('Não foi possível confirmar a recarga. Tente novamente com os mesmos dados.', 503);
      }
      // No additional read after a committed credit: retries keep the same operation ID.
      return { result: r.data };
    }
  };
}
module.exports = { createAdminService };
