create or replace function marketplace_effective_price(
  p_original_price numeric,
  p_received_at timestamptz,
  p_min_price numeric
)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when now() >= coalesce(p_received_at, now()) + interval '48 hours'
      then 6.99::numeric
    else round(greatest(
      coalesce(p_min_price, 0),
      coalesce(p_original_price, 0) * greatest(
        0::numeric,
        1::numeric - floor(greatest(0, extract(epoch from (now() - coalesce(p_received_at, now()))) / 3600))::numeric * 0.10
      )
    ), 2)
  end;
$$;
