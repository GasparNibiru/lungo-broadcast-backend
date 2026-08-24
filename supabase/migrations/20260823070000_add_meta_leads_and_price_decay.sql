alter table marketplace_leads
  add column if not exists original_price numeric(12,2),
  add column if not exists received_at timestamptz,
  add column if not exists meta_page_id text,
  add column if not exists meta_form_id text,
  add column if not exists meta_ad_id text;

update marketplace_leads
set original_price = coalesce(original_price, price),
    received_at = coalesce(received_at, created_at)
where original_price is null or received_at is null;

alter table marketplace_leads alter column original_price set not null;
alter table marketplace_leads alter column received_at set not null;
alter table marketplace_leads drop constraint if exists marketplace_leads_original_price_nonnegative;
alter table marketplace_leads add constraint marketplace_leads_original_price_nonnegative
  check (original_price >= 0) not valid;
alter table marketplace_leads validate constraint marketplace_leads_original_price_nonnegative;

create or replace function marketplace_effective_price(
  p_original_price numeric,
  p_received_at timestamptz,
  p_min_price numeric
)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select round(greatest(
    coalesce(p_min_price, 0),
    coalesce(p_original_price, 0) * greatest(
      0::numeric,
      1::numeric - floor(greatest(0, extract(epoch from (now() - coalesce(p_received_at, now()))) / 3600))::numeric * 0.10
    )
  ), 2);
$$;

create or replace function buy_marketplace_lead(p_user_id uuid, p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user users%rowtype;
  v_offer marketplace_leads%rowtype;
  v_wallet lead_credit_wallets%rowtype;
  v_settings lead_marketplace_settings%rowtype;
  v_crm_id uuid;
  v_purchase_id uuid;
  v_price numeric(12,2);
begin
  select * into v_user from users
    where id = p_user_id and status = 'active' and role in ('broker','supervisor')
    for update;
  if not found then raise exception 'Usuario invalido ou inativo.'; end if;

  select * into strict v_settings from lead_marketplace_settings where id = true;
  update marketplace_leads set status='available', reserved_by=null, reserved_until=null
    where id=p_lead_id and status='reserved' and reserved_until < now();
  select * into v_offer from marketplace_leads where id=p_lead_id for update;
  if not found or v_offer.status <> 'available' then raise exception 'Este lead nao esta mais disponivel.'; end if;

  v_price := marketplace_effective_price(v_offer.original_price, v_offer.received_at, v_settings.min_price);
  insert into lead_credit_wallets(user_id,balance) values(p_user_id,0) on conflict do nothing;
  select * into v_wallet from lead_credit_wallets where user_id=p_user_id for update;
  if v_wallet.balance < v_price then raise exception 'Saldo insuficiente.'; end if;

  update marketplace_leads set status='reserved', reserved_by=p_user_id,
    reserved_until=now() + make_interval(mins => v_settings.reservation_minutes), updated_at=now()
    where id=p_lead_id;
  insert into leads(organization_id,owner_user_id,name,phone,email,person_type,lives_count,product_interest,city,status,source,notes)
  values(v_user.organization_id,p_user_id,v_offer.name,v_offer.phone,v_offer.email,
    case when v_offer.profile='PJ' then 'company' else 'individual' end,
    v_offer.lives_count,v_offer.product_interest,v_offer.city,'new','marketplace',
    'Lead adquirido no marketplace interno.') returning id into v_crm_id;
  update lead_credit_wallets set balance=balance-v_price,updated_at=now()
    where user_id=p_user_id returning * into v_wallet;
  update marketplace_leads set price=v_price,status='sold',reserved_by=null,reserved_until=null,
    sold_to=p_user_id,sold_at=now(),updated_at=now() where id=p_lead_id;
  insert into marketplace_purchases(marketplace_lead_id,buyer_user_id,organization_id,crm_lead_id,price)
    values(p_lead_id,p_user_id,v_user.organization_id,v_crm_id,v_price) returning id into v_purchase_id;
  insert into lead_credit_transactions(user_id,amount,transaction_type,description,marketplace_lead_id,balance_after)
    values(p_user_id,-v_price,'debit','Compra de lead',p_lead_id,v_wallet.balance);
  v_offer.price := v_price;
  return jsonb_build_object('purchaseId',v_purchase_id,'crmLeadId',v_crm_id,
    'balance',v_wallet.balance,'lead',to_jsonb(v_offer));
end;
$$;
