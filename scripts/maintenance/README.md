# Production DB maintenance

일반 테스트와 computerUse는 이 디렉터리의 write 스크립트를 실행하지 않는다.

운영 write가 필요할 때만:

1. 전용 스크립트를 이 폴더에 둔다.
2. 시작 시 production host를 출력한다.
3. 대상/row count dry-run을 먼저 출력한다.
4. `PROD_MAINTENANCE_CONFIRM=<고유 task id>` 가 있을 때만 write. `ALLOW_PROD_DB=1` 금지.
5. 사용자 명시 승인 없이 실행하지 않는다.

로컬/테스트 write는 `assertLocalDatabaseUrl` / `assertLocalFixtureDatabase` 만 사용한다.

PushSubscription V1 production schema:

```
PROD_MAINTENANCE_CONFIRM=PUSH_SUBSCRIPTION_V1_20260917 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-push-subscription-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / subscription INSERT.

Notice V2 production schema:

```
PROD_MAINTENANCE_CONFIRM=NOTICE_V2_20260918 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-notice-v2-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / Notice INSERT/UPDATE/DELETE.

CourseReport Photo V1 production schema:

```
PROD_MAINTENANCE_CONFIRM=COURSE_REPORT_PHOTO_V1_20260919 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-course-report-photo-v1-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / Blob upload / CourseReport INSERT/UPDATE/DELETE.

Comment V1 production schema:

```
PROD_MAINTENANCE_CONFIRM=COMMENT_V1_20260919 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-comment-v1-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / Comment INSERT/UPDATE/DELETE.

Comment replies V1 (`parentId`, additive, no backfill). **App code that SELECTs parentId must ship AFTER this migrate.** Preview migrate first, separate approval:

```
PROD_MAINTENANCE_CONFIRM=COMMENT_REPLIES_V1_20261109 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-comment-replies-migration.ts
```

READ-ONLY inspect first (`_prisma_migrations` + `prisma migrate status`). `prisma migrate deploy` runs only when the sole pending migration is `20261109193000_comment_replies_v1`. Unexpected pending, failed, rolled-back, or unknown applied migrations abort before deploy. Already-applied + schema OK is a no-op. No db push / migrate reset / seed / Comment INSERT/UPDATE/DELETE.

Preview verify (`scripts/preview-db/verify-readonly.sql`) prints `comment_total` and `comment_id_fingerprint` (ids only, no body). Compare those keys from precheck vs verify after migrate. After additive apply, `comment_parent_set` must be 0.

Team affiliation settings (`TeamAffiliationVersion` / `TeamAffiliationItem`, additive, no seed). **Preview migrate first, separate approval.** App code already falls back when tables are missing. Production migrate does **not** write 2026-11-16 ops affiliation.

READ-ONLY inspect (no confirm, no migrate):

```
PRODUCTION_DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npm run inspect:team-affiliation-readonly
```

Production apply (explicit ops approval only). This script does not create or restore Neon backups:

```
PROD_MAINTENANCE_CONFIRM=TEAM_AFFILIATION_SETTINGS_20261117 \
NEON_PITR_WINDOW_CONFIRMED=YES \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-team-affiliation-migration.ts
```

`prisma migrate deploy` only when `gateSingleMigration` says the sole pending migration is `20261117233000_team_affiliation_settings`. Host must be `ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech` / `neondb` (Preview `lucky-mode-29989630` / `ep-odd-voice` rejected). Gate + local SQL checksum are re-read immediately before deploy. After apply: User/Caddy/DailyBoardPublished fingerprints unchanged, two new tables + indexes + FK present, affiliation rows empty, `_prisma_migrations` checksum matches local file. No db push / migrate reset / seed / Caddy UPDATE. Re-running after ops save affiliation rows HOLDs on the already-applied empty-table check; use inspect-readonly instead.

Neon backup / recovery (console, not this script):

1. Open Neon project `morning-tooth-60659454` (not Preview `lucky-mode-29989630`).
2. Confirm history retention / PITR window covers the migrate time. Set `NEON_PITR_WINDOW_CONFIRMED=YES` only after that console check.
3. If rollback is needed: Restore to a timestamp **before** migrate, onto a new branch, verify fingerprints, then cut over. Do not `prisma migrate resolve` to fake success.

Community free board V1 (`CommunityPost` / `CommunityPhoto` / `CommunityBoardType`, `CommentTargetType.COMMUNITY_POST`, additive, no seed). **main 병합 금지 · 사용자 별도 승인 전 실행 금지.** Preview는 이미 적용됨. 순서: precheck(읽기 전용) → Neon 콘솔 PITR 확인 + 백업 브랜치 `backup-pre-pr380-prod-YYYYMMDD` → migrate(1회, 재시도 없음) → 앱(PR #380) 배포.

```
PROD_DB_MODE=precheck \
PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_PRECHECK_20261121 \
PROD_DB_CONFIRM="PROD-DB-PRECHECK morning-tooth-60659454 20261120160000_community_free_board_v1" \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-community-free-board-migration.ts

PROD_DB_MODE=migrate \
PROD_MAINTENANCE_CONFIRM=COMMUNITY_FREE_BOARD_V1_MIGRATE_20261121 \
PROD_DB_CONFIRM="PROD-DB-MIGRATE morning-tooth-60659454 20261120160000_community_free_board_v1" \
NEON_PITR_WINDOW_CONFIRMED=YES NEON_BACKUP_BRANCH=backup-pre-pr380-prod-YYYYMMDD \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-community-free-board-migration.ts
```

GitHub: `.github/workflows/prod-db-community-free-board.yml` (workflow_dispatch 전용, environment `production-db` 필수 승인 jh9716, environment secret `PRODUCTION_DATABASE_URL`). guard job이 environment 존재·보호 규칙을 먼저 확인하고 없으면 중단한다 (environment 생성·secret 등록은 사용자 작업). 차단 조건: 대기 migration이 정확히 대상 1개가 아님, 실패·롤백·중복 기록, DB에만 있는 migration, 적용된 migration checksum 불일치, 대상 checksum ≠ 코드 고정값, 기록 없이 새 객체 존재, Preview/pooler/다른 endpoint, 모드·확인 문구 불일치. 사후: 새 테이블·인덱스·FK·enum 값, 새 테이블 0행, 기존 테이블(User, Caddy, DailyBoardPublished, FreeBoardPost, FreeBoardPhoto, CommentThread, Comment) 실행 전 행 지문 불변, `_prisma_migrations` checksum 일치. No db push / migrate reset / resolve / seed.

ChatAttachment Photo V1 production schema:

```
PROD_MAINTENANCE_CONFIRM=CHAT_ATTACHMENT_PHOTO_V1_20261006 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-chat-attachment-photo-v1-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / ChatAttachment INSERT / Blob write.

DevicePushToken V1 production schema (PREPARE only, no app deploy):

```
PROD_MAINTENANCE_CONFIRM=PREPARE_DEVICE_PUSH_TOKEN_175_20260922 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
npx tsx scripts/maintenance/deploy-device-push-token-migration.ts
```

`prisma migrate deploy` only. No db push / migrate reset / seed / DevicePushToken INSERT/UPDATE/DELETE / FCM send.

Google Play review accounts (default dry-run, no password output):

```
DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
  npx tsx scripts/maintenance/play-review-accounts.ts
```

Create apply (local). Set passwords in env; do not put them on the CLI.

```
PLAY_REVIEW_ADMIN_PASSWORD=... \
PLAY_REVIEW_CADDY_PASSWORD=... \
DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
  npx tsx scripts/maintenance/play-review-accounts.ts \
  --apply --confirm=CREATE_PLAY_REVIEW_ACCOUNTS
```

Create apply (production, explicit approval only):

```
PLAY_REVIEW_ADMIN_PASSWORD=... \
PLAY_REVIEW_CADDY_PASSWORD=... \
PROD_MAINTENANCE_CONFIRM=CREATE_PLAY_REVIEW_ACCOUNTS \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npx tsx scripts/maintenance/play-review-accounts.ts \
  --apply --confirm=CREATE_PLAY_REVIEW_ACCOUNTS
```

Disable apply (production, explicit approval only):

```
PROD_MAINTENANCE_CONFIRM=DISABLE_PLAY_REVIEW_ACCOUNTS \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npx tsx scripts/maintenance/play-review-accounts.ts \
  --disable --apply --confirm=DISABLE_PLAY_REVIEW_ACCOUNTS
```

No migrate / db push / hard delete. Does not modify username=admin or real staff User/Caddy.

Marshal P1–P3 schema (FULL_DAY coverage, occurrence carry, pin/autoHeld). Default is READ-ONLY inspect. Checksum sync, `prisma migrate deploy`, and Neon PITR are **separate** approval steps. This tool never runs `psql -f`, `prisma db execute`, or `prisma migrate resolve`.

Inspect (local throwaway or production, no confirm):

```
DATABASE_URL=postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway \
  npm run maint:marshal-p1p3
```

```
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npm run inspect:marshal-p1p3-readonly
```

Local apply (throwaway DB only; refuses `caddy_local`):

```
PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_MIGRATE_LOCAL \
MARSHAL_WRITE_FREEZE_CONFIRM=HELD \
DATABASE_URL=postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway \
  npm run maint:marshal-p1p3 -- --apply
```

Production apply (explicit ops approval only):

```
PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_MIGRATE_20261018 \
MARSHAL_WRITE_FREEZE_CONFIRM=HELD \
NEON_PITR_WINDOW_CONFIRMED=YES \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npm run maint:marshal-p1p3 -- --apply
```

Production checksum sync (does **not** migrate; reconstructed 20260809 files only):

```
PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_CHECKSUM_SYNC_20261018 \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
  npm run maint:marshal-p1p3 -- --sync-checksums
```

`prisma migrate deploy` only, Prisma CLI 5.22.x. Keep marshal write freeze until P1 files 1–3 finish. Neon PITR is confirmed in the Neon console — this script does not create or restore backups. MERGE HOLD.

