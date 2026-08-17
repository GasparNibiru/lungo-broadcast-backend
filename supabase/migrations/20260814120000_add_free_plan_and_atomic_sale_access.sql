insert into plans (code, name, price, included_supervisors, included_brokers, allows_master, active)
values ('free', 'Free', 0, 0, 0, false, true)
on conflict (code) do update set
  name = excluded.name,
  price = excluded.price,
  included_supervisors = excluded.included_supervisors,
  included_brokers = excluded.included_brokers,
  allows_master = excluded.allows_master,
  active = true;

create or replace function assert_admin_access_capacity(
  p_organization_id uuid,
  p_role text,
  p_excluded_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription subscriptions%rowtype;
  v_plan plans%rowtype;
  v_supervisors integer;
  v_brokers integer;
  v_required_extras integer;
begin
  if p_role not in ('supervisor', 'broker') then return; end if;

  select * into v_subscription
  from subscriptions
  where organization_id = p_organization_id and status = 'active'
  order by started_at desc, created_at desc
  limit 1
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'active_subscription_not_found';
  end if;

  select * into strict v_plan from plans where id = v_subscription.plan_id;

  select
    count(*) filter (where role = 'supervisor'),
    count(*) filter (where role = 'broker')
  into v_supervisors, v_brokers
  from users
  where organization_id = p_organization_id
    and status <> 'inactive'
    and (p_excluded_user_id is null or id <> p_excluded_user_id);

  if p_role = 'supervisor' then v_supervisors := v_supervisors + 1;
  else v_brokers := v_brokers + 1;
  end if;

  if v_plan.code = 'free' then
    if v_supervisors + v_brokers > 1 then
      raise exception using errcode = 'P0001', message = 'access_limit_reached';
    end if;
    return;
  end if;

  v_required_extras := greatest(v_supervisors - v_plan.included_supervisors, 0)
    + greatest(v_brokers - v_plan.included_brokers, 0);

  if v_required_extras > v_subscription.extra_accesses then
    raise exception using errcode = 'P0001', message = 'access_limit_reached';
  end if;
end;
$$;

revoke all on function assert_admin_access_capacity(uuid, text, uuid) from public;

create or replace function create_admin_subscription_with_access(
  p_organization_name text,
  p_responsible_name text,
  p_document_number text,
  p_email text,
  p_phone text,
  p_organization_type organization_type,
  p_plan_code text,
  p_extra_accesses integer,
  p_legacy boolean,
  p_sale_date date,
  p_first_payment_date date,
  p_first_payment_status payment_status,
  p_due_mode subscription_due_mode,
  p_fixed_due_day smallint,
  p_access_role text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_access jsonb;
  v_organization_id uuid;
begin
  if p_access_role not in ('supervisor', 'broker')
    or p_token_hash is null or btrim(p_token_hash) = ''
    or (btrim(p_plan_code) = 'free' and p_extra_accesses <> 0)
  then
    raise exception using errcode = '22023', message = 'invalid_access_input';
  end if;

  v_result := create_admin_subscription(
    p_organization_name, p_responsible_name, p_document_number, p_email, p_phone,
    p_organization_type, p_plan_code, p_extra_accesses, p_legacy, p_sale_date,
    p_first_payment_date,
    case when btrim(p_plan_code) = 'free' then 'paid'::payment_status else p_first_payment_status end,
    p_due_mode, p_fixed_due_day
  );

  v_organization_id := (v_result -> 'organization' ->> 'id')::uuid;
  v_access := create_admin_access(
    v_organization_id, p_responsible_name, p_email, p_phone,
    p_access_role, null, p_token_hash
  );

  return v_result || jsonb_build_object('access', v_access);
end;
$$;

revoke all on function create_admin_subscription_with_access(
  text, text, text, text, text, organization_type, text, integer, boolean,
  date, date, payment_status, subscription_due_mode, smallint, text, text
) from public, anon, authenticated;

grant execute on function create_admin_subscription_with_access(
  text, text, text, text, text, organization_type, text, integer, boolean,
  date, date, payment_status, subscription_due_mode, smallint, text, text
) to service_role;
