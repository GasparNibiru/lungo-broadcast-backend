alter table subscriptions
  add column if not exists asaas_checkout_id text,
  add column if not exists asaas_checkout_status text,
  add column if not exists asaas_checkout_url text;

create unique index if not exists subscriptions_asaas_checkout_id_unique_idx
  on subscriptions (asaas_checkout_id)
  where asaas_checkout_id is not null;
