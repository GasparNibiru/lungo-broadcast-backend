alter table organizations
  add column if not exists asaas_customer_id text;

create unique index if not exists organizations_asaas_customer_id_unique_idx
  on organizations (asaas_customer_id)
  where asaas_customer_id is not null;

alter table subscriptions
  add column if not exists asaas_subscription_id text,
  add column if not exists asaas_status text,
  add column if not exists asaas_sync_status text not null default 'not_configured',
  add column if not exists asaas_last_error text,
  add column if not exists asaas_synced_at timestamptz;

create unique index if not exists subscriptions_asaas_subscription_id_unique_idx
  on subscriptions (asaas_subscription_id)
  where asaas_subscription_id is not null;

alter table payments
  add column if not exists asaas_payment_id text,
  add column if not exists invoice_url text;

create unique index if not exists payments_asaas_payment_id_unique_idx
  on payments (asaas_payment_id)
  where asaas_payment_id is not null;

create table if not exists asaas_webhook_events (
  id text primary key,
  event_type text not null,
  resource_id text,
  payload jsonb not null,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create index if not exists asaas_webhook_events_resource_idx
  on asaas_webhook_events (resource_id, created_at desc);
