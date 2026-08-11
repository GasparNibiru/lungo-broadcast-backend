create table lead_marketplace_settings (
  id boolean primary key default true check (id),
  min_price numeric(12,2) not null default 10 check (min_price >= 0),
  max_price numeric(12,2) not null default 20 check (max_price >= min_price),
  support_whatsapp text not null default '5555992102864',
  reservation_minutes integer not null default 2 check (reservation_minutes between 1 and 30),
  updated_at timestamptz not null default now()
);
insert into lead_marketplace_settings(id) values (true) on conflict do nothing;

create table lead_credit_wallets (
  user_id uuid primary key references users(id) on delete restrict,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table lead_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  amount numeric(12,2) not null check (amount <> 0),
  transaction_type text not null check (transaction_type in ('credit','debit','refund','adjustment')),
  description text,
  marketplace_lead_id uuid,
  balance_after numeric(12,2) not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);

create table marketplace_leads (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  name text not null check (btrim(name) <> ''),
  phone text not null check (btrim(phone) <> ''),
  email text,
  profile text not null check (profile in ('PF','PJ','Adesao')),
  product_interest text,
  city text,
  state text,
  campaign_name text,
  ad_name text,
  price numeric(12,2) not null check (price >= 0),
  status text not null default 'available' check (status in ('available','reserved','sold','invalid','duplicate')),
  reserved_by uuid references users(id) on delete set null,
  reserved_until timestamptz,
  sold_to uuid references users(id) on delete set null,
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table lead_credit_transactions add constraint lead_credit_transactions_marketplace_fk foreign key (marketplace_lead_id) references marketplace_leads(id) on delete set null;

create table marketplace_purchases (
  id uuid primary key default gen_random_uuid(),
  marketplace_lead_id uuid not null unique references marketplace_leads(id) on delete restrict,
  buyer_user_id uuid not null references users(id) on delete restrict,
  organization_id uuid not null references organizations(id) on delete restrict,
  crm_lead_id uuid not null,
  price numeric(12,2) not null,
  purchased_at timestamptz not null default now(),
  constraint marketplace_purchases_crm_lead_fk foreign key (crm_lead_id, organization_id) references leads(id, organization_id) on delete restrict
);

create or replace function buy_marketplace_lead(p_user_id uuid, p_lead_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user users%rowtype; v_offer marketplace_leads%rowtype; v_wallet lead_credit_wallets%rowtype; v_crm_id uuid; v_purchase_id uuid;
begin
  select * into v_user from users where id = p_user_id and status = 'active' and role in ('broker','supervisor') for update;
  if not found then raise exception 'Usuario invalido ou inativo.'; end if;
  update marketplace_leads set status='available', reserved_by=null, reserved_until=null where id=p_lead_id and status='reserved' and reserved_until < now();
  select * into v_offer from marketplace_leads where id=p_lead_id for update;
  if not found or v_offer.status <> 'available' then raise exception 'Este lead nao esta mais disponivel.'; end if;
  insert into lead_credit_wallets(user_id,balance) values(p_user_id,0) on conflict do nothing;
  select * into v_wallet from lead_credit_wallets where user_id=p_user_id for update;
  if v_wallet.balance < v_offer.price then raise exception 'Saldo insuficiente.'; end if;
  update marketplace_leads set status='reserved', reserved_by=p_user_id, reserved_until=now()+interval '2 minutes', updated_at=now() where id=p_lead_id;
  insert into leads(organization_id,owner_user_id,name,phone,email,person_type,product_interest,city,status,source,notes)
  values(v_user.organization_id,p_user_id,v_offer.name,v_offer.phone,v_offer.email,case when v_offer.profile='PJ' then 'company' else 'individual' end,v_offer.product_interest,v_offer.city,'new','marketplace','Lead adquirido no marketplace interno.') returning id into v_crm_id;
  update lead_credit_wallets set balance=balance-v_offer.price,updated_at=now() where user_id=p_user_id returning * into v_wallet;
  update marketplace_leads set status='sold',reserved_by=null,reserved_until=null,sold_to=p_user_id,sold_at=now(),updated_at=now() where id=p_lead_id;
  insert into marketplace_purchases(marketplace_lead_id,buyer_user_id,organization_id,crm_lead_id,price) values(p_lead_id,p_user_id,v_user.organization_id,v_crm_id,v_offer.price) returning id into v_purchase_id;
  insert into lead_credit_transactions(user_id,amount,transaction_type,description,marketplace_lead_id,balance_after) values(p_user_id,-v_offer.price,'debit','Compra de lead',p_lead_id,v_wallet.balance);
  return jsonb_build_object('purchaseId',v_purchase_id,'crmLeadId',v_crm_id,'balance',v_wallet.balance,'lead',to_jsonb(v_offer));
end; $$;

create or replace function adjust_lead_credits(p_user_id uuid, p_amount numeric, p_description text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_balance numeric(12,2);
begin
  if p_amount = 0 then raise exception 'Informe um valor diferente de zero.'; end if;
  if not exists(select 1 from users where id=p_user_id and role in ('broker','supervisor')) then raise exception 'Usuario invalido.'; end if;
  insert into lead_credit_wallets(user_id,balance) values(p_user_id,0) on conflict do nothing;
  select balance into v_balance from lead_credit_wallets where user_id=p_user_id for update;
  v_balance := v_balance + p_amount;
  if v_balance < 0 then raise exception 'O ajuste deixaria o saldo negativo.'; end if;
  update lead_credit_wallets set balance=v_balance,updated_at=now() where user_id=p_user_id;
  insert into lead_credit_transactions(user_id,amount,transaction_type,description,balance_after) values(p_user_id,p_amount,case when p_amount > 0 then 'credit' else 'adjustment' end,left(coalesce(p_description,'Ajuste manual pelo Admin'),500),v_balance);
  return v_balance;
end; $$;
