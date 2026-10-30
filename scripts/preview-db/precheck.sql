-- 읽기 전용 사전검증. 아무것도 쓰지 않는다.
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;
SELECT 'server_version=' || current_setting('server_version');
SELECT 'database=' || current_database();
SELECT 'read_only=' || current_setting('transaction_read_only');
SELECT 'neon_endpoint=' || coalesce(current_setting('neon.endpoint_id', true), 'n/a');
SELECT 'public_tables=' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'public_other_objects=' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v','m','S','f','p') ;
SELECT 'has_prisma_migrations=' || (to_regclass('public._prisma_migrations') IS NOT NULL);
ROLLBACK;
