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
