alter type organization_status add value if not exists 'attention';

create or replace function update_admin_organization(
  p_organization_id uuid,
  p_name text, p_has_name boolean,
  p_organization_type text, p_has_organization_type boolean,
  p_status text, p_has_status boolean,
  p_plan_code text, p_has_plan_code boolean,
  p_extra_accesses integer, p_has_extra_accesses boolean,
  p_legacy boolean, p_has_legacy boolean,
  p_next_due_date date, p_has_next_due_date boolean,
  p_due_mode text, p_has_due_mode boolean,
  p_fixed_due_day smallint, p_has_fixed_due_day boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization organizations%rowtype;
  v_subscription subscriptions%rowtype;
  v_plan plans%rowtype;
  v_plan_id uuid;
  v_base_price numeric(12, 2);
  v_extra_accesses integer;
  v_due_mode subscription_due_mode;
  v_fixed_due_day smallint;
  v_extra_access_price constant numeric(12, 2) := 15.90;
begin
  select * into v_organization from organizations where id = p_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'organization_not_found';
  end if;

  select * into v_subscription
  from subscriptions
  where organization_id = p_organization_id and status = 'active'
  order by started_at desc, created_at desc, id desc
  limit 1 for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'active_subscription_not_found';
  end if;

  if p_has_name and (p_name is null or btrim(p_name) = '') then raise exception using errcode = '22023', message = 'invalid_name'; end if;
  if p_has_organization_type and p_organization_type not in ('individual', 'brokerage') then raise exception using errcode = '22023', message = 'invalid_organization_type'; end if;
  if p_has_status and p_status not in ('active', 'attention', 'suspended', 'inactive') then raise exception using errcode = '22023', message = 'invalid_status'; end if;
  if p_has_extra_accesses and (p_extra_accesses is null or p_extra_accesses < 0) then raise exception using errcode = '22023', message = 'invalid_extra_accesses'; end if;
  if p_has_legacy and p_legacy is null then raise exception using errcode = '22023', message = 'invalid_legacy'; end if;
  if p_has_next_due_date and p_next_due_date is null then raise exception using errcode = '22023', message = 'invalid_next_due_date'; end if;
  if p_has_due_mode and p_due_mode not in ('thirty_days', 'fixed_day') then raise exception using errcode = '22023', message = 'invalid_due_mode'; end if;

  v_plan_id := v_subscription.plan_id;
  v_base_price := v_subscription.base_price;
  if p_has_plan_code then
    select * into v_plan from plans where code = btrim(p_plan_code);
    if not found then raise exception using errcode = 'P0002', message = 'plan_not_found'; end if;
    v_plan_id := v_plan.id;
    v_base_price := v_plan.price;
  end if;

  v_extra_accesses := case when p_has_extra_accesses then p_extra_accesses else v_subscription.extra_accesses end;
  v_due_mode := case when p_has_due_mode then p_due_mode::subscription_due_mode else v_subscription.due_mode end;
  v_fixed_due_day := case
    when p_has_due_mode and p_due_mode = 'thirty_days' then null
    when p_has_fixed_due_day then p_fixed_due_day
    else v_subscription.fixed_due_day
  end;

  if (v_due_mode = 'thirty_days' and v_fixed_due_day is not null)
    or (v_due_mode = 'fixed_day' and v_fixed_due_day not in (1, 5, 10, 15, 20, 25))
  then
    raise exception using errcode = '22023', message = 'invalid_due_day';
  end if;

  update organizations set
    name = case when p_has_name then btrim(p_name) else name end,
    organization_type = case when p_has_organization_type then p_organization_type::organization_type else organization_type end,
    status = case when p_has_status then p_status::organization_status else status end
  where id = p_organization_id returning * into v_organization;

  update subscriptions set
    plan_id = v_plan_id,
    base_price = v_base_price,
    extra_accesses = v_extra_accesses,
    extra_access_price = v_extra_access_price,
    total_price = round(v_base_price + (v_extra_accesses * v_extra_access_price), 2),
    legacy = case when p_has_legacy then p_legacy else legacy end,
    next_due_date = case when p_has_next_due_date then p_next_due_date else next_due_date end,
    due_mode = v_due_mode,
    fixed_due_day = v_fixed_due_day
  where id = v_subscription.id returning * into v_subscription;

  return jsonb_build_object('organization', to_jsonb(v_organization), 'subscription', to_jsonb(v_subscription));
end;
$$;

revoke all on function update_admin_organization(
  uuid, text, boolean, text, boolean, text, boolean, text, boolean,
  integer, boolean, boolean, boolean, date, boolean, text, boolean, smallint, boolean
) from public, anon, authenticated;

grant execute on function update_admin_organization(
  uuid, text, boolean, text, boolean, text, boolean, text, boolean,
  integer, boolean, boolean, boolean, date, boolean, text, boolean, smallint, boolean
) to service_role;
