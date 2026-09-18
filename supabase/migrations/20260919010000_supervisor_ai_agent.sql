-- New module only. Never reapply older Finance/Prospecting migrations.
create table public.ai_agents (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  instance_name text not null unique,
  settings jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.ai_wallets (
  organization_id uuid primary key references public.ai_agents(organization_id) on delete restrict,
  activated_at timestamptz,
  cycle_start timestamptz,
  cycle_end timestamptz,
  free_units integer not null default 0 check (free_units between 0 and 1000),
  paid_units integer not null default 0 check (paid_units >= 0)
);
create table public.ai_credit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.ai_agents(organization_id),
  request_id uuid not null unique,
  kind text not null check (kind in ('topup','renewal','debit','refund')),
  units integer not null,
  note text not null default '',
  actor text not null default 'system',
  created_at timestamptz not null default now()
);
create table public.ai_conversations (
  organization_id uuid not null references public.ai_agents(organization_id),
  phone text not null,
  history jsonb not null default '[]'::jsonb,
  profile jsonb not null default '{}'::jsonb,
  last_summary_hash text,
  updated_at timestamptz not null default now(),
  primary key (organization_id,phone)
);
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.ai_agents(organization_id),
  message_id text not null,
  phone text not null,
  kind text not null default 'reply' check (kind in ('reply','summary')),
  input_text text not null,
  output_text text,
  result jsonb,
  state text not null default 'queued' check (state in ('queued','processing','sending','sent','failed','uncertain','ignored')),
  reserved_from text check (reserved_from in ('free','paid')),
  reserved_cycle timestamptz,
  provider_message_id text,
  error_code text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,message_id)
);
create index ai_jobs_queue on public.ai_jobs(state,created_at);
create index ai_credit_events_org on public.ai_credit_events(organization_id,created_at desc);
create index ai_jobs_org on public.ai_jobs(organization_id,created_at desc);

-- Called only by the authenticated backend. Amounts use tenths of credits.
create function public.ai_wallet_refresh(p_org uuid, p_activate boolean default false)
returns public.ai_wallets language plpgsql security definer set search_path=public as $$
declare w public.ai_wallets; n integer; next_cycle timestamptz; start_cycle timestamptz;
begin
  insert into ai_wallets(organization_id) values(p_org) on conflict do nothing;
  select * into w from ai_wallets where organization_id=p_org for update;
  if w.activated_at is null and p_activate then
    update ai_wallets set activated_at=now(),cycle_start=now(),cycle_end=now()+interval '1 month',free_units=1000 where organization_id=p_org returning * into w;
    insert into ai_credit_events(organization_id,request_id,kind,units,note) values(p_org,gen_random_uuid(),'renewal',1000,'Franquia inicial');
  elsif w.cycle_end<=now() then
    -- Always calculate against original activation date, preserving month-end anchors.
    n:= greatest(1,(extract(year from age(now(),w.activated_at))*12+extract(month from age(now(),w.activated_at)))::integer);
    start_cycle:=w.activated_at+make_interval(months=>n);
    if start_cycle>now() then n:=n-1; start_cycle:=w.activated_at+make_interval(months=>n); end if;
    next_cycle:=w.activated_at+make_interval(months=>n+1);
    if next_cycle<=now() then start_cycle:=next_cycle; next_cycle:=w.activated_at+make_interval(months=>n+2); end if;
    update ai_wallets set cycle_start=start_cycle,cycle_end=next_cycle,free_units=1000 where organization_id=p_org returning * into w;
    insert into ai_credit_events(organization_id,request_id,kind,units,note) values(p_org,gen_random_uuid(),'renewal',1000,'Renovação mensal sem acúmulo');
  end if;
  return w;
end $$;

create function public.ai_add_credits(p_org uuid,p_request uuid,p_credits integer,p_note text)
returns public.ai_wallets language plpgsql security definer set search_path=public as $$
declare w public.ai_wallets; e public.ai_credit_events;
begin
  if p_credits not between 1 and 100000 or length(btrim(p_note)) not between 3 and 240 then raise exception 'invalid_topup'; end if;
  w:=ai_wallet_refresh(p_org,false);
  select * into e from ai_credit_events where request_id=p_request;
  if found then
    if e.organization_id<>p_org or e.units<>p_credits*10 or e.kind<>'topup' or e.note<>p_note then raise exception 'idempotency_conflict'; end if;
    return w;
  end if;
  insert into ai_credit_events(organization_id,request_id,kind,units,note,actor) values(p_org,p_request,'topup',p_credits*10,p_note,'admin');
  update ai_wallets set paid_units=paid_units+p_credits*10 where organization_id=p_org returning * into w;
  return w;
end $$;

create function public.ai_claim_job() returns public.ai_jobs
language plpgsql security definer set search_path=public as $$
declare a public.ai_agents; j public.ai_jobs; w public.ai_wallets;
begin
  -- A crashed worker never automatically resends messages with ambiguous delivery.
  update ai_jobs set state='ignored',error_code='expired_inbound',updated_at=now()
    where state='queued' and kind='reply' and created_at<now()-interval '24 hours';
  update ai_jobs set state='uncertain',error_code='worker_interrupted',updated_at=now()
    where state in ('processing','sending') and lease_until<now();
  for a in select ag.* from ai_agents ag join organizations o on o.id=ag.organization_id
    where ag.enabled and o.status='active'
      and not exists(select 1 from ai_jobs x where x.organization_id=ag.organization_id and x.state in ('processing','sending','uncertain'))
      and exists(select 1 from ai_jobs x where x.organization_id=ag.organization_id and x.state='queued')
    order by ag.updated_at for update of ag skip locked
  loop
    select * into j from ai_jobs where organization_id=a.organization_id and state='queued' order by created_at,id limit 1 for update skip locked;
    if j.id is null then continue; end if;
    w:=ai_wallet_refresh(a.organization_id,false);
    if j.kind='reply' then
      if w.free_units+w.paid_units<1 then continue; end if;
      if w.free_units>0 then
        update ai_wallets set free_units=free_units-1 where organization_id=a.organization_id;
        j.reserved_from:='free';
      else
        update ai_wallets set paid_units=paid_units-1 where organization_id=a.organization_id;
        j.reserved_from:='paid';
      end if;
    end if;
    update ai_jobs set state='processing',reserved_from=j.reserved_from,reserved_cycle=w.cycle_start,
      lease_until=now()+interval '5 minutes',updated_at=now() where id=j.id returning * into j;
    return j;
  end loop;
  return null;
end $$;

-- Commit debit, conversation and summary outbox together after confirmed delivery.
create function public.ai_finish_job(p_id uuid,p_outcome text,p_provider_id text default null)
returns public.ai_jobs language plpgsql security definer set search_path=public as $$
declare j public.ai_jobs; w public.ai_wallets; r jsonb;
begin
  select organization_id into j.organization_id from ai_jobs where id=p_id;
  if not found then raise exception 'job_not_found'; end if;
  perform 1 from ai_agents where organization_id=j.organization_id for update;
  select * into j from ai_jobs where id=p_id for update;
  if j.state in ('sent','failed','ignored') then return j; end if;
  if j.state not in ('processing','sending','uncertain') or p_outcome not in ('sent','failed','uncertain') then raise exception 'invalid_transition'; end if;
  if p_outcome='sent' and (j.output_text is null or (j.kind='reply' and j.result is null)) then raise exception 'missing_result'; end if;
  if p_outcome='failed' and j.reserved_from is not null then
    w:=ai_wallet_refresh(j.organization_id,false);
    if j.reserved_from='paid' then
      update ai_wallets set paid_units=paid_units+1 where organization_id=j.organization_id;
    elsif w.cycle_start=j.reserved_cycle then
      update ai_wallets set free_units=least(1000,free_units+1) where organization_id=j.organization_id;
    end if;
    insert into ai_credit_events(organization_id,request_id,kind,units,note) values(j.organization_id,j.id,'refund',1,'Reserva liberada: resposta não enviada');
  elsif p_outcome='sent' and j.kind='reply' then
    insert into ai_credit_events(organization_id,request_id,kind,units,note) values(j.organization_id,j.id,'debit',-1,'Resposta enviada ao lead');
    r:=j.result;
    insert into ai_conversations(organization_id,phone,history,profile,last_summary_hash)
      values(j.organization_id,j.phone,r->'history',r->'profile',r->>'summaryHash')
      on conflict(organization_id,phone) do update set history=excluded.history,profile=excluded.profile,last_summary_hash=excluded.last_summary_hash,updated_at=now();
    if coalesce(r->>'summary','')<>'' then
      insert into ai_jobs(organization_id,message_id,phone,kind,input_text)
        values(j.organization_id,'summary:'||j.id,r->>'summaryPhone','summary',r->>'summary') on conflict do nothing;
    end if;
  end if;
  update ai_jobs set state=p_outcome,provider_message_id=coalesce(p_provider_id,provider_message_id),updated_at=now() where id=p_id returning * into j;
  return j;
end $$;

alter table public.ai_agents enable row level security;
alter table public.ai_wallets enable row level security;
alter table public.ai_credit_events enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_jobs enable row level security;
revoke all on public.ai_agents,public.ai_wallets,public.ai_credit_events,public.ai_conversations,public.ai_jobs from public,anon,authenticated;
grant all on public.ai_agents,public.ai_wallets,public.ai_credit_events,public.ai_conversations,public.ai_jobs to service_role;
revoke all on function public.ai_wallet_refresh(uuid,boolean),public.ai_add_credits(uuid,uuid,integer,text),public.ai_claim_job(),public.ai_finish_job(uuid,text,text) from public,anon,authenticated;
grant execute on function public.ai_wallet_refresh(uuid,boolean),public.ai_add_credits(uuid,uuid,integer,text),public.ai_claim_job(),public.ai_finish_job(uuid,text,text) to service_role;
