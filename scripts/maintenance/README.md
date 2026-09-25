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

