-- PR #380 Preview migrate 후 구조 검증 (읽기 전용). migrate 후(verify)에만 실행된다.
BEGIN TRANSACTION READ ONLY;
SELECT 'community_post_table=' || count(*)::text FROM information_schema.tables
  WHERE table_schema='public' AND table_name='CommunityPost';
SELECT 'community_photo_table=' || count(*)::text FROM information_schema.tables
  WHERE table_schema='public' AND table_name='CommunityPhoto';
SELECT 'community_post_author_fk_delete=' || coalesce((
    SELECT rc.delete_rule FROM information_schema.referential_constraints rc
    WHERE rc.constraint_schema='public' AND rc.constraint_name='CommunityPost_authorUserId_fkey' LIMIT 1
  ), 'missing');
SELECT 'community_photo_post_fk_delete=' || coalesce((
    SELECT rc.delete_rule FROM information_schema.referential_constraints rc
    WHERE rc.constraint_schema='public' AND rc.constraint_name='CommunityPhoto_postId_fkey' LIMIT 1
  ), 'missing');
SELECT 'community_board_type_enum=' || coalesce((
    SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e
    JOIN pg_type ty ON ty.oid = e.enumtypid WHERE ty.typname='CommunityBoardType'
  ), 'missing');
SELECT 'comment_target_community_post=' || count(*)::text FROM pg_enum e
  JOIN pg_type ty ON ty.oid = e.enumtypid WHERE ty.typname='CommentTargetType' AND e.enumlabel='COMMUNITY_POST';
SELECT 'community_posts=' || (SELECT count(*) FROM "CommunityPost")::text;
SELECT 'community_photos=' || (SELECT count(*) FROM "CommunityPhoto")::text;
SELECT 'community_comment_threads=' || count(*)::text FROM "CommentThread" WHERE "targetType"::text='COMMUNITY_POST';
SELECT 'community_migration_finished=' || count(*)::text FROM "_prisma_migrations"
  WHERE migration_name='20261120160000_community_free_board_v1' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'community_migration_checksum=' || coalesce(max(checksum), 'missing') FROM "_prisma_migrations"
  WHERE migration_name='20261120160000_community_free_board_v1';
SELECT 'migrations_not_ok=' || count(*)::text FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
ROLLBACK;
