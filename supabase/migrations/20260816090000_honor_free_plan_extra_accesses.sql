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
    if v_supervisors + v_brokers > 1 + v_subscription.extra_accesses then
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

