create extension if not exists pg_cron with schema extensions;

create or replace function finalize_all_due_subscription_cancellations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_finalized integer := 0;
begin
  for v_organization_id in
    select distinct organization_id
    from subscriptions
    where cancellation_status = 'scheduled'
      and cancellation_effective_at <= now()
  loop
    if finalize_due_subscription_cancellation(v_organization_id) then
      v_finalized := v_finalized + 1;
    end if;
  end loop;
  return v_finalized;
end;
$$;

revoke all on function finalize_all_due_subscription_cancellations()
  from public, anon, authenticated;
grant execute on function finalize_all_due_subscription_cancellations()
  to service_role;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job
    where jobname = 'finalize-due-subscription-cancellations'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'finalize-due-subscription-cancellations',
    '5 * * * *',
    'select public.finalize_all_due_subscription_cancellations();'
  );
end;
$$;
