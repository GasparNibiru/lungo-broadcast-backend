begin;

-- Manual declarations are intentionally separate from legacy playback history.
create table if not exists public.training_confirmations (
  training_id uuid not null references public.training_contents(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  organization_name text,
  user_name text not null,
  user_role text not null check (user_role in ('broker', 'supervisor')),
  confirmed_at timestamptz not null default now(),
  primary key (training_id, user_id, organization_id)
);
create index if not exists training_confirmations_user_idx
  on public.training_confirmations(user_id, organization_id);
create index if not exists training_confirmations_team_idx
  on public.training_confirmations(training_id, organization_id, confirmed_at desc);
alter table public.training_confirmations enable row level security;
revoke all on public.training_confirmations from public, anon, authenticated;
grant select, insert on public.training_confirmations to service_role;
notify pgrst, 'reload schema';

commit;
