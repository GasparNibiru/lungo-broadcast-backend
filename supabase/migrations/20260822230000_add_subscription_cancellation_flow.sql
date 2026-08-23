alter table subscriptions
  add column if not exists cancellation_status text not null default 'none',
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_effective_at timestamptz,
  add column if not exists cancellation_requested_by text,
  add column if not exists cancellation_reason text;

alter table subscriptions drop constraint if exists subscriptions_cancellation_status_valid;
alter table subscriptions add constraint subscriptions_cancellation_status_valid
  check (cancellation_status in ('none', 'scheduled', 'completed'));

create or replace function request_subscription_cancellation(
  p_organization_id uuid,
  p_mode text,
  p_requested_by text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subscription subscriptions%rowtype;
  v_effective_at timestamptz;
begin
  if p_mode not in ('period_end', 'immediate') then
    raise exception using errcode = '22023', message = 'invalid_cancellation_mode';
  end if;

  select * into v_subscription from subscriptions
    where organization_id = p_organization_id
      and status in ('active', 'suspended')
    order by started_at desc, created_at desc limit 1 for update;
  if not found then raise exception using errcode = 'P0002', message = 'subscription_not_found'; end if;

  if v_subscription.cancellation_status = 'scheduled' and p_mode = 'period_end' then
    return to_jsonb(v_subscription);
  end if;

  v_effective_at := case when p_mode = 'immediate' then now() else v_subscription.next_due_date::timestamptz end;

  update subscriptions set
    cancellation_status = case when p_mode = 'immediate' then 'completed' else 'scheduled' end,
    cancellation_requested_at = coalesce(cancellation_requested_at, now()),
    cancellation_effective_at = v_effective_at,
    cancellation_requested_by = left(coalesce(p_requested_by, 'system'), 120),
    cancellation_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), ''),
    status = case when p_mode = 'immediate' then 'cancelled'::subscription_status else status end,
    cancelled_at = case when p_mode = 'immediate' then now() else cancelled_at end
  where id = v_subscription.id returning * into v_subscription;

  if p_mode = 'immediate' then
    update organizations set status = 'inactive' where id = p_organization_id;
    update users set status = 'inactive' where organization_id = p_organization_id and status <> 'inactive';
    update access_tokens set status = 'revoked', revoked_at = now()
      where user_id in (select id from users where organization_id = p_organization_id) and status = 'active';
  end if;

  insert into audit_logs (organization_id, action, entity_type, entity_id, metadata)
  values (p_organization_id, 'subscription.cancellation_requested', 'subscription', v_subscription.id,
    jsonb_build_object('mode', p_mode, 'requested_by', p_requested_by, 'effective_at', v_effective_at, 'reason', p_reason));
  return to_jsonb(v_subscription);
end;
$$;

create or replace function finalize_due_subscription_cancellation(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_subscription subscriptions%rowtype;
begin
  select * into v_subscription from subscriptions
    where organization_id = p_organization_id and cancellation_status = 'scheduled'
      and cancellation_effective_at <= now()
    order by cancellation_effective_at asc limit 1 for update;
  if not found then return false; end if;

  update subscriptions set status = 'cancelled', cancellation_status = 'completed', cancelled_at = now()
    where id = v_subscription.id;
  update organizations set status = 'inactive' where id = p_organization_id;
  update users set status = 'inactive' where organization_id = p_organization_id and status <> 'inactive';
  update access_tokens set status = 'revoked', revoked_at = now()
    where user_id in (select id from users where organization_id = p_organization_id) and status = 'active';
  insert into audit_logs (organization_id, action, entity_type, entity_id, metadata)
    values (p_organization_id, 'subscription.cancellation_completed', 'subscription', v_subscription.id,
      jsonb_build_object('effective_at', v_subscription.cancellation_effective_at));
  return true;
end;
$$;

revoke all on function request_subscription_cancellation(uuid,text,text,text) from public, anon, authenticated;
revoke all on function finalize_due_subscription_cancellation(uuid) from public, anon, authenticated;
grant execute on function request_subscription_cancellation(uuid,text,text,text) to service_role;
grant execute on function finalize_due_subscription_cancellation(uuid) to service_role;
