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

