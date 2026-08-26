# caddy-system agent notes

## Database safety

- Default agent work uses **local Postgres** `caddy_local` only.
- Do not set `DATABASE_URL="$PRODUCTION_DATABASE_URL"` for tests, browser fixtures, or ad-hoc Prisma scripts.
- If a local UI fixture is missing (caddy ids, draft date), fix the **local** fixture. Never INSERT into production to unblock UI testing.
- Production writes require an explicit user request and `PROD_MAINTENANCE_CONFIRM=<task-id>` on a script under `scripts/maintenance/`.
- There is no `ALLOW_PROD_DB=1` bypass for tests.

See `.cursor/rules/db-safety.mdc` and `src/lib/dbSafety.ts`.
