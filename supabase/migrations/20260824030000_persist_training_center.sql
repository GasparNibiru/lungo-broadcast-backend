create table if not exists training_contents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  youtube_id text not null,
  track text not null default 'Geral',
  description text not null default '',
  stars smallint not null default 0 check (stars between 0 and 5),
  sort_order integer not null default 0 check (sort_order >= 0),
  active boolean not null default true,
  owner_type text not null default 'admin' check (owner_type in ('admin','supervisor')),
  owner_user_id uuid references users(id) on delete set null,
  owner_name text,
  organization_id uuid references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint training_contents_owner_scope check (
    (owner_type = 'admin' and organization_id is null)
    or (owner_type = 'supervisor' and organization_id is not null)
  )
);

create index if not exists training_contents_visibility_idx
  on training_contents(active, owner_type, organization_id, track, sort_order);

create table if not exists training_progress (
  id uuid primary key default gen_random_uuid(),
  training_id uuid not null references training_contents(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  user_name text,
  user_email text,
  user_role text,
  organization_id uuid references organizations(id) on delete cascade,
  organization_name text,
  watched_seconds integer not null default 0 check (watched_seconds >= 0),
  "current_time" integer not null default 0 check ("current_time" >= 0),
  duration integer not null default 0 check (duration >= 0),
  percent smallint not null default 0 check (percent between 0 and 100),
  status text not null default 'in_progress' check (status in ('not_started','in_progress','completed')),
  started_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(training_id, user_id)
);

create index if not exists training_progress_metrics_idx
  on training_progress(training_id, organization_id, last_viewed_at desc);

create table if not exists training_data_imports (
  import_key text primary key,
  imported_at timestamptz not null default now(),
  trainings_count integer not null default 0,
  progress_count integer not null default 0
);

alter table training_contents enable row level security;
alter table training_progress enable row level security;
alter table training_data_imports enable row level security;

revoke all on training_contents, training_progress, training_data_imports
  from public, anon, authenticated;
grant all on training_contents, training_progress, training_data_imports
  to service_role;
