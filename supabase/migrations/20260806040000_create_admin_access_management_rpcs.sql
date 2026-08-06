alter type user_status add value if not exists 'blocked';

alter table access_tokens alter column expires_at drop not null;

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
  if p_role not in ('supervisor', 'broker') then
    return;
  end if;

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
    and (p_excluded_user_id is null or id <> p_excluded_user_id);

  if p_role = 'supervisor' then v_supervisors := v_supervisors + 1;
  else v_brokers := v_brokers + 1;
  end if;

  v_required_extras := greatest(v_supervisors - v_plan.included_supervisors, 0)
    + greatest(v_brokers - v_plan.included_brokers, 0);

  if v_required_extras > v_subscription.extra_accesses then
    raise exception using errcode = 'P0001', message = 'access_limit_reached';
  end if;
end;
$$;

create or replace function create_admin_access(
  p_organization_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_role text,
  p_expires_at timestamptz,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_user users%rowtype;
begin
  if not exists (select 1 from organizations where id = p_organization_id) then
    raise exception using errcode = 'P0002', message = 'organization_not_found';
  end if;
  if p_role not in ('admin_master', 'supervisor', 'broker') then
    raise exception using errcode = '22023', message = 'invalid_role';
  end if;
  if exists (select 1 from users where lower(email) = lower(p_email)) then
    raise exception using errcode = 'P0001', message = 'email_already_exists';
  end if;

  perform assert_admin_access_capacity(p_organization_id, p_role, null);

  insert into users (organization_id, name, email, phone, role, status)
  values (p_organization_id, btrim(p_name), lower(btrim(p_email)), nullif(btrim(p_phone), ''), p_role::user_role, 'active')
  returning * into v_user;

  insert into access_tokens (user_id, token_hash, status, expires_at)
  values (v_user.id, p_token_hash, 'active', p_expires_at);

  return jsonb_build_object('user_id', v_user.id);
end;
$$;

create or replace function update_admin_access(
  p_user_id uuid,
  p_name text, p_has_name boolean,
  p_email text, p_has_email boolean,
  p_phone text, p_has_phone boolean,
  p_role text, p_has_role boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user users%rowtype;
begin
  select * into v_user from users where id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'user_not_found'; end if;
  if p_has_role and p_role not in ('admin_master', 'supervisor', 'broker') then
    raise exception using errcode = '22023', message = 'invalid_role';
  end if;
  if p_has_email and exists (
    select 1 from users where lower(email) = lower(p_email) and id <> p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'email_already_exists';
  end if;
  if p_has_role and p_role <> v_user.role::text then
    perform assert_admin_access_capacity(v_user.organization_id, p_role, p_user_id);
  end if;

  update users set
    name = case when p_has_name then btrim(p_name) else name end,
    email = case when p_has_email then lower(btrim(p_email)) else email end,
    phone = case when p_has_phone then nullif(btrim(p_phone), '') else phone end,
    role = case when p_has_role then p_role::user_role else role end
  where id = p_user_id;
end;
$$;

create or replace function change_admin_access(p_user_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from users where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'user_not_found';
  end if;
  if p_action = 'block' then
    update users set status = 'blocked' where id = p_user_id;
    update access_tokens set status = 'revoked', revoked_at = now()
      where user_id = p_user_id and status = 'active';
  elsif p_action = 'reactivate' then
    update users set status = 'active' where id = p_user_id;
  elsif p_action = 'invalidate_token' then
    update access_tokens set status = 'revoked', revoked_at = now()
      where user_id = p_user_id and status = 'active';
  else
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;
end;
$$;

create or replace function renew_admin_access_token(
  p_user_id uuid,
  p_expires_at timestamptz,
  p_token_hash text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid;
begin
  select id into v_user_id from users where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'user_not_found';
  end if;
  update access_tokens set status = 'revoked', revoked_at = now()
    where user_id = p_user_id and status = 'active';
  insert into access_tokens (user_id, token_hash, status, expires_at)
  values (p_user_id, p_token_hash, 'active', p_expires_at);
end;
$$;

revoke all on function assert_admin_access_capacity(uuid, text, uuid) from public;
revoke all on function create_admin_access(uuid, text, text, text, text, timestamptz, text) from public;
revoke all on function update_admin_access(uuid, text, boolean, text, boolean, text, boolean, text, boolean) from public;
revoke all on function change_admin_access(uuid, text) from public;
revoke all on function renew_admin_access_token(uuid, timestamptz, text) from public;
grant execute on function create_admin_access(uuid, text, text, text, text, timestamptz, text) to service_role;
grant execute on function update_admin_access(uuid, text, boolean, text, boolean, text, boolean, text, boolean) to service_role;
grant execute on function change_admin_access(uuid, text) to service_role;
grant execute on function renew_admin_access_token(uuid, timestamptz, text) to service_role;
