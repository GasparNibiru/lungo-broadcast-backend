alter table organizations
  add column responsible_name text,
  add column document_number text,
  add column email text,
  add column phone text;

alter table organizations
  add constraint organizations_responsible_name_not_blank
    check (responsible_name is null or btrim(responsible_name) <> ''),
  add constraint organizations_document_number_not_blank
    check (document_number is null or btrim(document_number) <> ''),
  add constraint organizations_email_not_blank
    check (email is null or btrim(email) <> ''),
  add constraint organizations_phone_not_blank
    check (phone is null or btrim(phone) <> '');

create unique index organizations_document_number_unique_idx
  on organizations (btrim(document_number))
  where document_number is not null;

create or replace function create_admin_subscription(
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
  p_fixed_due_day smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan plans%rowtype;
  v_organization organizations%rowtype;
  v_subscription subscriptions%rowtype;
  v_payment payments%rowtype;
  v_extra_access_price numeric(12, 2) := 15.90;
  v_total_price numeric(12, 2);
  v_next_due_date date;
begin
  if p_organization_name is null or btrim(p_organization_name) = ''
    or p_responsible_name is null or btrim(p_responsible_name) = ''
    or p_email is null or btrim(p_email) = ''
    or p_phone is null or btrim(p_phone) = ''
    or p_plan_code is null or btrim(p_plan_code) = ''
    or p_extra_accesses is null or p_extra_accesses < 0
    or p_legacy is null or p_sale_date is null or p_first_payment_date is null
    or p_first_payment_status not in ('pending', 'paid')
    or p_due_mode is null
  then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  if (p_due_mode = 'thirty_days' and p_fixed_due_day is not null)
    or (p_due_mode = 'fixed_day' and p_fixed_due_day not in (1, 5, 10, 15, 20, 25))
  then
    raise exception using errcode = '22023', message = 'invalid_due_day';
  end if;

  select * into v_plan
  from plans
  where code = btrim(p_plan_code) and active = true;

  if not found then
    raise exception using errcode = 'P0002', message = 'plan_not_found';
  end if;

  v_total_price := round(v_plan.price + (p_extra_accesses * v_extra_access_price), 2);

  if p_due_mode = 'thirty_days' then
    v_next_due_date := p_first_payment_date + 30;
  elsif extract(day from p_first_payment_date)::integer < p_fixed_due_day then
    v_next_due_date := make_date(
      extract(year from p_first_payment_date)::integer,
      extract(month from p_first_payment_date)::integer,
      p_fixed_due_day
    );
  else
    v_next_due_date := (
      date_trunc('month', p_first_payment_date) + interval '1 month'
      + make_interval(days => p_fixed_due_day - 1)
    )::date;
  end if;

  insert into organizations (
    name, responsible_name, document_number, email, phone, organization_type
  ) values (
    btrim(p_organization_name), btrim(p_responsible_name),
    nullif(btrim(p_document_number), ''), btrim(p_email), btrim(p_phone), p_organization_type
  ) returning * into v_organization;

  insert into subscriptions (
    organization_id, plan_id, status, base_price, extra_accesses,
    extra_access_price, total_price, started_at, next_due_date,
    due_mode, fixed_due_day, legacy
  ) values (
    v_organization.id, v_plan.id, 'active', v_plan.price, p_extra_accesses,
    v_extra_access_price, v_total_price, p_sale_date::timestamptz, v_next_due_date,
    p_due_mode, p_fixed_due_day, p_legacy
  ) returning * into v_subscription;

  insert into payments (
    subscription_id, competence, due_date, expected_amount,
    paid_amount, paid_at, status
  ) values (
    v_subscription.id, date_trunc('month', p_first_payment_date)::date,
    p_first_payment_date, v_total_price,
    case when p_first_payment_status = 'paid' then v_total_price else null end,
    case when p_first_payment_status = 'paid' then p_first_payment_date::timestamptz else null end,
    p_first_payment_status
  ) returning * into v_payment;

  return jsonb_build_object(
    'organization', to_jsonb(v_organization),
    'subscription', to_jsonb(v_subscription),
    'payment', to_jsonb(v_payment)
  );
end;
$$;

revoke all on function create_admin_subscription(
  text, text, text, text, text, organization_type, text, integer, boolean,
  date, date, payment_status, subscription_due_mode, smallint
) from public, anon, authenticated;

grant execute on function create_admin_subscription(
  text, text, text, text, text, organization_type, text, integer, boolean,
  date, date, payment_status, subscription_due_mode, smallint
) to service_role;
