# Production DB maintenance

일반 테스트와 computerUse는 이 디렉터리의 write 스크립트를 실행하지 않는다.

운영 write가 필요할 때만:

1. 전용 스크립트를 이 폴더에 둔다.
2. 시작 시 production host를 출력한다.
3. 대상/row count dry-run을 먼저 출력한다.
4. `PROD_MAINTENANCE_CONFIRM=<고유 task id>` 가 있을 때만 write. `ALLOW_PROD_DB=1` 금지.
5. 사용자 명시 승인 없이 실행하지 않는다.

로컬/테스트 write는 `assertLocalDatabaseUrl` / `assertLocalFixtureDatabase` 만 사용한다.
