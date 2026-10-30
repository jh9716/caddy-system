-- VERTHILL Preview DB 읽기 전용 검증. key=value 집계만 출력. BEGIN READ ONLY 로 보호.
BEGIN TRANSACTION READ ONLY;
SELECT 'migrations_applied=' || count(*)::text FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'migrations_failed=' || count(*)::text FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
UNION ALL SELECT 'latest_migration=' || max(migration_name) FROM "_prisma_migrations"
UNION ALL SELECT 'public_tables=' || count(*)::text FROM pg_tables WHERE schemaname='public'
UNION ALL SELECT 'users_total=' || count(*)::text FROM "User"
UNION ALL SELECT 'users_non_test=' || count(*)::text FROM "User" WHERE username NOT LIKE '테스트%'
UNION ALL SELECT 'caddies_total=' || count(*)::text FROM "Caddy"
UNION ALL SELECT 'caddies_non_test=' || count(*)::text FROM "Caddy" WHERE name NOT LIKE '테스트%'
UNION ALL SELECT 'marshal_profiles=' || count(*)::text FROM "MarshalProfile"
UNION ALL SELECT 'plans_draft=' || count(*)::text FROM "MarshalMonthPlan" WHERE status='DRAFT'
UNION ALL SELECT 'plans_finalized=' || count(*)::text FROM "MarshalMonthPlan" WHERE status='FINALIZED'
UNION ALL SELECT 'plan_2026_12_exists=' || count(*)::text FROM "MarshalMonthPlan" WHERE year=2026 AND month=12
UNION ALL SELECT 'slots=' || count(*)::text FROM "MarshalMonthSlot"
UNION ALL SELECT 'penalty_occurrences=' || count(*)::text FROM "MarshalPenaltyOccurrence"
UNION ALL SELECT 'rotation_credits=' || count(*)::text FROM "MarshalRotationCredit"
UNION ALL SELECT 'notices=' || count(*)::text FROM "Notice"
UNION ALL SELECT 'push_tokens=' || ((SELECT count(*) FROM "DevicePushToken")+(SELECT count(*) FROM "PushSubscription"))::text
UNION ALL SELECT 'coverage_trigger=' || count(*)::text FROM pg_trigger WHERE tgname='marshal_penalty_fill_coverage';
ROLLBACK;
