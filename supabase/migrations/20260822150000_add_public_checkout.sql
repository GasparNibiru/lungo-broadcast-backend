alter table subscriptions
  add column if not exists checkout_source text not null default 'admin',
  add column if not exists checkout_token_hash text,
  add column if not exists activation_status text not null default 'not_applicable',
  add column if not exists activation_error text,
  add column if not exists activated_at timestamptz;

create unique index if not exists subscriptions_checkout_token_hash_unique_idx
  on subscriptions (checkout_token_hash)
  where checkout_token_hash is not null;

create or replace function create_public_checkout(
  p_organization_name text,
  p_responsible_name text,
  p_document_number text,
  p_email text,
  p_phone text,
  p_organization_type organization_type,
  p_plan_code text,
  p_extra_accesses integer,
  p_checkout_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_subscription_id uuid;
  v_organization_id uuid;
begin
  if p_plan_code not in ('individual', 'equipe', 'corretora10')
    or p_checkout_token_hash is null or length(p_checkout_token_hash) < 32
  then
    raise exception using errcode = '22023', message = 'invalid_public_checkout';
  end if;

  v_result := create_admin_subscription(
    p_organization_name, p_responsible_name, p_document_number, p_email, p_phone,
    p_organization_type, p_plan_code, p_extra_accesses, false, current_date,
    current_date, 'pending', 'thirty_days', null
  );

  v_subscription_id := (v_result -> 'subscription' ->> 'id')::uuid;
  v_organization_id := (v_result -> 'organization' ->> 'id')::uuid;

  update subscriptions set
    checkout_source = 'public',
    checkout_token_hash = p_checkout_token_hash,
    activation_status = 'pending_payment'
  where id = v_subscription_id;

  update organizations set status = 'inactive' where id = v_organization_id;
  return v_result;
end;
$$;

revoke all on function create_public_checkout(text,text,text,text,text,organization_type,text,integer,text)
  from public, anon, authenticated;
grant execute on function create_public_checkout(text,text,text,text,text,organization_type,text,integer,text)
  to service_role;

create or replace function activate_public_checkout_access(
  p_subscription_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subscription subscriptions%rowtype;
  v_organization organizations%rowtype;
  v_plan plans%rowtype;
  v_access jsonb;
  v_user_id uuid;
  v_role text;
begin
  select * into v_subscription from subscriptions where id = p_subscription_id for update;
  if not found or v_subscription.checkout_source <> 'public' then return null; end if;

  if not exists (
    select 1 from payments where subscription_id = v_subscription.id and status = 'paid'
  ) then
    raise exception using errcode = 'P0001', message = 'payment_not_confirmed';
  end if;

  select * into strict v_organization from organizations where id = v_subscription.organization_id;
  select * into strict v_plan from plans where id = v_subscription.plan_id;

  if v_subscription.activation_status in ('access_created', 'email_sent', 'email_failed') then
    select id into v_user_id from users
      where organization_id = v_organization.id and email = lower(btrim(v_organization.email))
      order by created_at asc limit 1;
    return jsonb_build_object('created', false, 'user_id', v_user_id,
      'organization_id', v_organization.id, 'plan_name', v_plan.name);
  end if;

  v_role := case when v_plan.code = 'individual' then 'broker' else 'supervisor' end;
  v_access := create_admin_access(v_organization.id, v_organization.responsible_name,
    lower(btrim(v_organization.email)), v_organization.phone, v_role, null, p_token_hash);
  v_user_id := (v_access ->> 'user_id')::uuid;

  update organizations set status = 'active', owner_user_id = v_user_id where id = v_organization.id;
  update subscriptions set activation_status = 'access_created', activation_error = null,
    activated_at = now() where id = v_subscription.id;

  return jsonb_build_object('created', true, 'user_id', v_user_id,
    'organization_id', v_organization.id, 'plan_name', v_plan.name);
end;
$$;

revoke all on function activate_public_checkout_access(uuid,text) from public, anon, authenticated;
grant execute on function activate_public_checkout_access(uuid,text) to service_role;
