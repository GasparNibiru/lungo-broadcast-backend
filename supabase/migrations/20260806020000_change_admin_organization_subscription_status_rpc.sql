create or replace function change_admin_organization_subscription_status(
  p_organization_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization organizations%rowtype;
  v_subscription subscriptions%rowtype;
  v_previous_organization_status organization_status;
  v_previous_subscription_status subscription_status;
begin
  if p_action not in ('suspend', 'reactivate', 'cancel') then
    raise exception using errcode = '22023', message = 'invalid_action';
  end if;

  select * into v_organization from organizations
  where id = p_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'organization_not_found';
  end if;

  select * into v_subscription from subscriptions
  where organization_id = p_organization_id
  order by case when status = 'active' then 0 else 1 end,
    started_at desc, created_at desc, id desc
  limit 1 for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'subscription_not_found';
  end if;

  if (p_action = 'suspend' and (
      v_organization.status not in ('active', 'attention')
      or v_subscription.status not in ('active', 'past_due')
    ))
    or (p_action = 'reactivate' and (
      v_organization.status not in ('suspended', 'inactive')
      or v_subscription.status not in ('suspended', 'cancelled')
    ))
    or (p_action = 'cancel' and (
      v_organization.status = 'inactive' or v_subscription.status = 'cancelled'
    ))
  then
    raise exception using errcode = '22023', message = 'invalid_state';
  end if;

  v_previous_organization_status := v_organization.status;
  v_previous_subscription_status := v_subscription.status;

  update organizations set status = case p_action
    when 'suspend' then 'suspended'::organization_status
    when 'reactivate' then 'active'::organization_status
    when 'cancel' then 'inactive'::organization_status
  end
  where id = v_organization.id returning * into v_organization;

  update subscriptions set
    status = case p_action
      when 'suspend' then 'suspended'::subscription_status
      when 'reactivate' then 'active'::subscription_status
      when 'cancel' then 'cancelled'::subscription_status
    end,
    suspended_at = case p_action
      when 'suspend' then now()
      when 'reactivate' then null
      else suspended_at
    end,
    cancelled_at = case p_action
      when 'reactivate' then null
      when 'cancel' then now()
      else cancelled_at
    end
  where id = v_subscription.id returning * into v_subscription;

  insert into audit_logs (organization_id, action, entity_type, entity_id, metadata)
  values (
    v_organization.id,
    'admin.organization_subscription.' || p_action,
    'subscription',
    v_subscription.id,
    jsonb_build_object(
      'organization_status', jsonb_build_object('from', v_previous_organization_status, 'to', v_organization.status),
      'subscription_status', jsonb_build_object('from', v_previous_subscription_status, 'to', v_subscription.status)
    )
  );

  return jsonb_build_object(
    'organization', to_jsonb(v_organization),
    'subscription', to_jsonb(v_subscription)
  );
end;
$$;

revoke all on function change_admin_organization_subscription_status(uuid, text)
from public, anon, authenticated;

grant execute on function change_admin_organization_subscription_status(uuid, text)
to service_role;
