-- READ ONLY. Execute only in the Supabase SQL Editor of operational production
-- project bnceclhjhgjfirubudwi, after confirming the project in the dashboard.
-- Returns metadata only: no customer rows, contacts, keys, or tokens.

SELECT current_database() AS database_name, current_user AS role_name,
       current_setting('server_version') AS postgres_version,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
       to_regclass('public.users') AS users_table,
       to_regclass('public.organizations') AS organizations_table,
       to_regclass('public.access_tokens') AS access_tokens_table,
       to_regprocedure('pg_catalog.gen_random_uuid()') AS uuid_generator,
       to_regclass('supabase_migrations.schema_migrations') AS migration_history_table;

SELECT c.relname AS table_name, a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default_expression
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relname IN ('users','organizations','access_tokens')
  AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;

SELECT c.relname AS table_name, x.conname AS constraint_name,
       x.contype AS constraint_type, pg_get_constraintdef(x.oid) AS definition
FROM pg_catalog.pg_constraint x
JOIN pg_catalog.pg_class c ON c.oid = x.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('users','organizations','access_tokens')
ORDER BY c.relname, x.conname;

SELECT 'table' AS object_kind, c.relname AS object_name
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname LIKE 'prospecting_%' AND c.relkind IN ('r','p','v','m')
UNION ALL
SELECT 'function', p.proname
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'prospecting_%'
ORDER BY object_kind, object_name;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
