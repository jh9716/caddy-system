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
UNION ALL SELECT 'coverage_trigger=' || count(*)::text FROM pg_trigger WHERE tgname='marshal_penalty_fill_coverage'
UNION ALL SELECT 'comment_total=' || count(*)::text FROM "Comment"
UNION ALL SELECT 'comment_parent_null=' || count(*) FILTER (WHERE "parentId" IS NULL)::text FROM "Comment"
UNION ALL SELECT 'comment_parent_set=' || count(*) FILTER (WHERE "parentId" IS NOT NULL)::text FROM "Comment"
UNION ALL SELECT 'comment_id_fingerprint=' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') FROM "Comment"
UNION ALL SELECT 'comment_parentid_column=' || count(*)::text FROM information_schema.columns
  WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'
UNION ALL SELECT 'comment_parentid_nullable=' || coalesce(max(is_nullable), 'missing') FROM information_schema.columns
  WHERE table_schema='public' AND table_name='Comment' AND column_name='parentId'
UNION ALL SELECT 'comment_parentid_fk=' || count(*)::text FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='Comment' AND constraint_type='FOREIGN KEY'
    AND constraint_name='Comment_parentId_fkey'
UNION ALL SELECT 'comment_parentid_fk_delete=' || coalesce((
    SELECT rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.table_schema
    WHERE tc.table_schema='public'
      AND tc.table_name='Comment'
      AND tc.constraint_type='FOREIGN KEY'
      AND tc.constraint_name='Comment_parentId_fkey'
    LIMIT 1
  ), 'missing')
UNION ALL SELECT 'comment_replies_migration=' || count(*)::text FROM "_prisma_migrations"
  WHERE migration_name='20261109193000_comment_replies_v1'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
ROLLBACK;
