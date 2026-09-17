create table finance_settings (
  organization_id uuid primary key references organizations(id) on delete restrict,
  activated_at timestamptz not null default now(),
  activated_by uuid references users(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table finance_product_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  carrier_name text not null check (btrim(carrier_name) <> ''),
  product_name text not null check (btrim(product_name) <> ''),
  total_commission_percent numeric(9,4) not null check (total_commission_percent >= 0),
  tax_mode text not null default 'none' check (tax_mode in ('none','deduct','withheld')),
  tax_percent numeric(7,4) not null default 0 check (tax_percent between 0 and 100),
  lifetime_enabled boolean not null default false,
  lifetime_percent numeric(7,4) not null default 0 check (lifetime_percent between 0 and 100),
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, product_name)
);

create table finance_product_installments (
  id uuid primary key default gen_random_uuid(),
  product_rule_id uuid not null references finance_product_rules(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  commission_percent numeric(9,4) not null check (commission_percent >= 0),
  month_offset integer not null default 0 check (month_offset >= 0),
  unique (product_rule_id, installment_number)
);

create table finance_broker_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  broker_user_id uuid not null,
  product_rule_id uuid not null references finance_product_rules(id) on delete cascade,
  lifetime_enabled boolean not null default false,
  lifetime_percent numeric(7,4) not null default 0 check (lifetime_percent between 0 and 100),
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (broker_user_id, organization_id) references users(id, organization_id) on delete restrict,
  unique (organization_id, broker_user_id, product_rule_id)
);

create table finance_broker_installments (
  id uuid primary key default gen_random_uuid(),
  broker_rule_id uuid not null references finance_broker_rules(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  commission_percent numeric(9,4) not null check (commission_percent >= 0),
  month_offset integer not null default 0 check (month_offset >= 0),
  unique (broker_rule_id, installment_number)
);

create table finance_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  source_kind text not null check (source_kind in ('lead_closing','client_primary','client_base_sale')),
  source_id text not null check (btrim(source_id) <> ''),
  source_client_id text,
  seller_user_id uuid,
  product_rule_id uuid references finance_product_rules(id) on delete restrict,
  client_name text not null check (btrim(client_name) <> ''),
  seller_name text,
  product_name text not null check (btrim(product_name) <> ''),
  sale_amount numeric(14,2) not null check (sale_amount >= 0),
  closed_at timestamptz not null,
  implantation_date date,
  first_receivable_date date,
  rule_snapshot jsonb,
  broker_rule_snapshot jsonb,
  status text not null default 'pending' check (status in ('pending','scheduled','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (seller_user_id, organization_id) references users(id, organization_id) on delete set null (seller_user_id),
  unique (organization_id, source_kind, source_id)
);

create table finance_receivables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  finance_sale_id uuid not null references finance_sales(id) on delete restrict,
  entry_type text not null check (entry_type in ('installment','lifetime')),
  installment_number integer,
  competence date not null,
  due_date date not null,
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  tax_percent numeric(7,4) not null default 0 check (tax_percent between 0 and 100),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  net_amount numeric(14,2) not null check (net_amount >= 0),
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  paid_amount numeric(14,2) check (paid_amount >= 0),
  paid_at timestamptz,
  notes text,
  confirmed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (finance_sale_id, entry_type, installment_number, competence)
);

create table finance_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  finance_sale_id uuid not null references finance_sales(id) on delete restrict,
  broker_user_id uuid,
  entry_type text not null check (entry_type in ('installment','lifetime')),
  installment_number integer,
  commission_percent numeric(9,4) not null check (commission_percent >= 0),
  competence date not null,
  due_date date not null,
  expected_amount numeric(14,2) not null check (expected_amount >= 0),
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  paid_amount numeric(14,2) check (paid_amount >= 0),
  paid_at timestamptz,
  advanced boolean not null default false,
  notes text,
  confirmed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (broker_user_id, organization_id) references users(id, organization_id) on delete set null (broker_user_id),
  unique (finance_sale_id, entry_type, installment_number, competence)
);

create table finance_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  actor_user_id uuid references users(id) on delete set null,
  entity_type text not null check (entity_type in ('settings','product_rule','broker_rule','sale','receivable','transfer')),
  entity_id uuid,
  action text not null check (btrim(action) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index finance_product_rules_org_idx on finance_product_rules (organization_id, active, product_name);
create index finance_broker_rules_org_idx on finance_broker_rules (organization_id, broker_user_id);
create index finance_sales_org_status_idx on finance_sales (organization_id, status, closed_at desc);
create index finance_receivables_org_due_idx on finance_receivables (organization_id, status, due_date);
create index finance_transfers_org_due_idx on finance_transfers (organization_id, status, due_date);
create index finance_events_org_created_idx on finance_events (organization_id, created_at desc);
create unique index finance_receivables_lifetime_competence_uidx on finance_receivables (finance_sale_id, competence) where entry_type = 'lifetime';
create unique index finance_transfers_lifetime_competence_uidx on finance_transfers (finance_sale_id, competence) where entry_type = 'lifetime';

create trigger finance_settings_set_updated_at before update on finance_settings for each row execute function set_updated_at();
create trigger finance_product_rules_set_updated_at before update on finance_product_rules for each row execute function set_updated_at();
create trigger finance_broker_rules_set_updated_at before update on finance_broker_rules for each row execute function set_updated_at();
create trigger finance_sales_set_updated_at before update on finance_sales for each row execute function set_updated_at();
create trigger finance_receivables_set_updated_at before update on finance_receivables for each row execute function set_updated_at();
create trigger finance_transfers_set_updated_at before update on finance_transfers for each row execute function set_updated_at();
