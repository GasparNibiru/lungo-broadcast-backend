-- READ ONLY. Execute only in the Supabase SQL Editor of operational production
-- project bnceclhjhgjfirubudwi. Returns one result table and changes nothing.

SELECT section, item, details
FROM (
  SELECT 1 AS sort_order, 'environment'::text AS section, 'database'::text AS item,
         jsonb_build_object(
           'database_name', current_database(),
           'role_name', current_user,
           'postgres_version', current_setting('server_version'),
           'can_create_public', has_schema_privilege(current_user, 'public', 'CREATE'),
           'users_table', to_regclass('public.users'),
           'organizations_table', to_regclass('public.organizations'),
           'access_tokens_table', to_regclass('public.access_tokens'),
           'uuid_generator', to_regprocedure('pg_catalog.gen_random_uuid()'),
           'migration_history_table', to_regclass('supabase_migrations.schema_migrations')
         ) AS details

  UNION ALL

  SELECT 2, 'column', c.relname || '.' || a.attname,
         jsonb_build_object('table', c.relname, 'column', a.attname,
           'data_type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
           'default_expression', pg_get_expr(d.adbin, d.adrelid))
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relname IN ('users','organizations','access_tokens')
    AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped

  UNION ALL

  SELECT 3, 'constraint', c.relname || '.' || x.conname,
         jsonb_build_object('table', c.relname, 'name', x.conname, 'type', x.contype,
           'definition', pg_get_constraintdef(x.oid))
  FROM pg_catalog.pg_constraint x
  JOIN pg_catalog.pg_class c ON c.oid = x.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('users','organizations','access_tokens')

  UNION ALL

  SELECT 4, 'prospecting_object', c.relname,
         jsonb_build_object('kind', CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE c.relkind::text END)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname LIKE 'prospecting_%' AND c.relkind IN ('r','p','v','m')

  UNION ALL

  SELECT 5, 'prospecting_function', p.proname,
         jsonb_build_object('arguments', pg_get_function_identity_arguments(p.oid),
           'result', pg_get_function_result(p.oid))
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'prospecting_%'

  UNION ALL

  SELECT 6, 'database_size', 'current_database',
         jsonb_build_object('size', pg_size_pretty(pg_database_size(current_database())))
) audit
ORDER BY sort_order, section, item;
