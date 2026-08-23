create or replace function enforce_subscription_plan_access_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_plan_code text;
begin
  select code into v_plan_code from plans where id = new.plan_id;

  if v_plan_code = 'individual' and coalesce(new.extra_accesses, 0) <> 0 then
    raise exception using
      errcode = '22023',
      message = 'individual_plan_does_not_allow_extra_accesses';
  end if;

  return new;
end;
$$;

drop trigger if exists subscriptions_enforce_plan_access_rules on subscriptions;
create trigger subscriptions_enforce_plan_access_rules
before insert or update of plan_id, extra_accesses on subscriptions
for each row execute function enforce_subscription_plan_access_rules();
