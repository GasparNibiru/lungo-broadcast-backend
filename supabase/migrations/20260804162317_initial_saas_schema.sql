create extension if not exists pgcrypto;

create type organization_status as enum ('active', 'inactive', 'suspended');
create type organization_type as enum ('individual', 'brokerage');
create type user_role as enum ('admin_master', 'supervisor', 'broker');
create type user_status as enum ('active', 'inactive', 'suspended');
create type subscription_status as enum ('active', 'past_due', 'suspended', 'cancelled');
create type subscription_due_mode as enum ('thirty_days', 'fixed_day');
create type access_token_status as enum ('active', 'revoked', 'expired');
create type whatsapp_instance_status as enum ('disconnected', 'connecting', 'connected', 'error');
create type lead_status as enum (
  'new',
  'in_service',
  'quote_sent',
  'documents_received',
  'sale_registered',
  'invoice_generated',
  'closed',
  'lost'
);
create type payment_status as enum ('pending', 'paid', 'overdue', 'cancelled', 'refunded');

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  logo_url text,
  status organization_status not null default 'active',
  organization_type organization_type not null,
  owner_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  role user_role not null,
  name text not null check (btrim(name) <> ''),
  email text,
  phone text,
  auth_provider_id text,
  status user_status not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_not_blank check (email is null or btrim(email) <> ''),
  constraint users_auth_provider_id_not_blank check (
    auth_provider_id is null or btrim(auth_provider_id) <> ''
  ),
  constraint users_id_organization_unique unique (id, organization_id)
);

alter table organizations
  add constraint organizations_owner_user_fk
  foreign key (owner_user_id, id)
  references users(id, organization_id)
  on delete set null (owner_user_id);

create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null check (btrim(name) <> ''),
  price numeric(12, 2) not null check (price >= 0),
  included_supervisors integer not null default 0 check (included_supervisors >= 0),
  included_brokers integer not null default 0 check (included_brokers >= 0),
  allows_master boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code_not_blank check (btrim(code) <> '')
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  plan_id uuid not null references plans(id) on delete restrict,
  status subscription_status not null default 'active',
  base_price numeric(12, 2) not null check (base_price >= 0),
  extra_accesses integer not null default 0 check (extra_accesses >= 0),
  extra_access_price numeric(12, 2) not null default 0 check (extra_access_price >= 0),
  total_price numeric(12, 2) not null check (total_price >= 0),
  started_at timestamptz not null default now(),
  next_due_date date not null,
  due_mode subscription_due_mode not null default 'thirty_days',
  fixed_due_day smallint,
  legacy boolean not null default false,
  suspended_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_fixed_due_day_valid check (
    (due_mode = 'thirty_days' and fixed_due_day is null)
    or
    (due_mode = 'fixed_day' and fixed_due_day in (1, 5, 10, 15, 20, 25))
  ),
  constraint subscriptions_status_dates_valid check (
    (status <> 'suspended' or suspended_at is not null)
    and (status <> 'cancelled' or cancelled_at is not null)
  )
);

create table access_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null check (btrim(token_hash) <> ''),
  status access_token_status not null default 'active',
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table whatsapp_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  user_id uuid,
  instance_name text not null check (btrim(instance_name) <> ''),
  external_instance_id text,
  status whatsapp_instance_status not null default 'disconnected',
  phone_number text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_instances_user_fk
    foreign key (user_id, organization_id)
    references users(id, organization_id)
    on delete set null (user_id)
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  owner_user_id uuid,
  name text not null check (btrim(name) <> ''),
  phone text,
  email text,
  person_type text,
  document_number text,
  lives_count integer check (lives_count >= 0),
  business_value numeric(12, 2) check (business_value >= 0),
  product_interest text,
  city text,
  status lead_status not null default 'new',
  source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_id_organization_unique unique (id, organization_id),
  constraint leads_person_type_valid check (
    person_type is null or person_type in ('individual', 'company')
  ),
  constraint leads_owner_user_fk
    foreign key (owner_user_id, organization_id)
    references users(id, organization_id)
    on delete set null (owner_user_id)
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  owner_user_id uuid,
  source_lead_id uuid,
  name text not null check (btrim(name) <> ''),
  phone text,
  email text,
  document_number text,
  city text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_id_organization_unique unique (id, organization_id),
  constraint clients_source_lead_fk
    foreign key (source_lead_id, organization_id)
    references leads(id, organization_id)
    on delete set null (source_lead_id),
  constraint clients_owner_user_fk
    foreign key (owner_user_id, organization_id)
    references users(id, organization_id)
    on delete set null (owner_user_id)
);

create table client_products (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  product_type text not null check (btrim(product_type) <> ''),
  lives_count integer check (lives_count >= 0),
  sale_value numeric(12, 2) check (sale_value >= 0),
  sale_date date,
  renewal_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_products_id_client_unique unique (id, client_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  client_product_id uuid not null references client_products(id) on delete restrict,
  file_name text not null check (btrim(file_name) <> ''),
  storage_path text not null check (btrim(storage_path) <> ''),
  mime_type text,
  file_size bigint check (file_size >= 0),
  created_at timestamptz not null default now()
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  seller_user_id uuid,
  client_id uuid not null,
  client_product_id uuid,
  amount numeric(12, 2) not null check (amount >= 0),
  sale_date date not null,
  sale_type text not null check (btrim(sale_type) <> ''),
  created_at timestamptz not null default now(),
  constraint sales_client_fk
    foreign key (client_id, organization_id)
    references clients(id, organization_id)
    on delete restrict,
  constraint sales_client_product_fk
    foreign key (client_product_id, client_id)
    references client_products(id, client_id)
    on delete restrict,
  constraint sales_seller_user_fk
    foreign key (seller_user_id, organization_id)
    references users(id, organization_id)
    on delete set null (seller_user_id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete restrict,
  competence date not null,
  due_date date not null,
  expected_amount numeric(12, 2) not null check (expected_amount >= 0),
  paid_amount numeric(12, 2) check (paid_amount >= 0),
  paid_at timestamptz,
  status payment_status not null default 'pending',
  payment_method text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_subscription_competence_unique unique (subscription_id, competence),
  constraint payments_paid_fields_valid check (
    status not in ('paid', 'refunded')
    or (paid_amount is not null and paid_at is not null)
  )
);

create table payment_history (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete restrict,
  action text not null check (btrim(action) <> ''),
  old_status payment_status,
  new_status payment_status,
  amount numeric(12, 2) check (amount >= 0),
  notes text,
  created_at timestamptz not null default now()
);

create table internal_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  sender_user_id uuid,
  recipient_user_id uuid,
  send_to_all boolean not null default false,
  message text not null check (btrim(message) <> ''),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint internal_messages_sender_user_fk
    foreign key (sender_user_id, organization_id)
    references users(id, organization_id)
    on delete set null (sender_user_id),
  constraint internal_messages_recipient_user_fk
    foreign key (recipient_user_id, organization_id)
    references users(id, organization_id)
    on delete restrict,
  constraint internal_messages_recipient_valid check (
    (send_to_all and recipient_user_id is null)
    or
    (not send_to_all and recipient_user_id is not null)
  )
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  user_id uuid,
  action text not null check (btrim(action) <> ''),
  entity_type text not null check (btrim(entity_type) <> ''),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_logs_user_fk
    foreign key (user_id, organization_id)
    references users(id, organization_id)
    on delete set null (user_id),
  constraint audit_logs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index plans_code_unique_idx on plans (code);
create unique index users_email_unique_idx on users (lower(email)) where email is not null;
create unique index access_tokens_token_hash_unique_idx on access_tokens (token_hash);
create unique index whatsapp_instances_instance_name_unique_idx
  on whatsapp_instances (instance_name);

create index organizations_owner_user_id_idx on organizations (owner_user_id);
create index users_organization_id_idx on users (organization_id);
create index subscriptions_organization_id_idx on subscriptions (organization_id);
create index subscriptions_plan_id_idx on subscriptions (plan_id);
create index subscriptions_organization_status_idx on subscriptions (organization_id, status);
create index access_tokens_user_id_idx on access_tokens (user_id);
create index whatsapp_instances_organization_id_idx on whatsapp_instances (organization_id);
create index whatsapp_instances_user_id_idx on whatsapp_instances (user_id);
create index leads_owner_user_id_idx on leads (owner_user_id);
create index leads_organization_status_idx on leads (organization_id, status);
create index clients_organization_id_idx on clients (organization_id);
create index clients_owner_user_id_idx on clients (owner_user_id);
create index clients_source_lead_id_idx on clients (source_lead_id);
create index client_products_client_id_idx on client_products (client_id);
create index documents_client_product_id_idx on documents (client_product_id);
create index sales_organization_id_idx on sales (organization_id);
create index sales_seller_user_id_idx on sales (seller_user_id);
create index sales_client_id_idx on sales (client_id);
create index sales_client_product_id_idx on sales (client_product_id);
create index payments_status_due_date_idx on payments (status, due_date);
create index payments_due_date_idx on payments (due_date);
create index payment_history_payment_id_idx on payment_history (payment_id);
create index internal_messages_organization_id_idx on internal_messages (organization_id);
create index internal_messages_sender_user_id_idx on internal_messages (sender_user_id);
create index internal_messages_recipient_user_id_idx on internal_messages (recipient_user_id);
create index audit_logs_organization_id_idx on audit_logs (organization_id);
create index audit_logs_user_id_idx on audit_logs (user_id);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

create trigger organizations_set_updated_at
before update on organizations
for each row execute function set_updated_at();

create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

create trigger plans_set_updated_at
before update on plans
for each row execute function set_updated_at();

create trigger subscriptions_set_updated_at
before update on subscriptions
for each row execute function set_updated_at();

create trigger whatsapp_instances_set_updated_at
before update on whatsapp_instances
for each row execute function set_updated_at();

create trigger leads_set_updated_at
before update on leads
for each row execute function set_updated_at();

create trigger clients_set_updated_at
before update on clients
for each row execute function set_updated_at();

create trigger client_products_set_updated_at
before update on client_products
for each row execute function set_updated_at();

create trigger payments_set_updated_at
before update on payments
for each row execute function set_updated_at();

insert into plans (
  code,
  name,
  price,
  included_supervisors,
  included_brokers,
  allows_master
)
values
  ('individual', 'Individual', 25.90, 0, 1, false),
  ('equipe', 'Equipe', 49.90, 1, 2, false),
  ('corretora10', 'Corretora 10', 149.90, 1, 10, true),
  ('corretora16', 'Corretora 16', 199.90, 1, 16, true),
  ('corretora20', 'Corretora 20', 239.90, 1, 20, true);
