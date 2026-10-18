/**
 * Marshal P1–P3 maintenance CLI.
 *
 * Inspect (default, read-only — no confirm):
 *   DATABASE_URL=postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway \
 *     npm run maint:marshal-p1p3
 *
 * Production inspect (read-only). Guard allows this argv without confirm:
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" npm run maint:marshal-p1p3
 *
 * Local apply (throwaway DB only):
 *   PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_MIGRATE_LOCAL \
 *   MARSHAL_WRITE_FREEZE_CONFIRM=HELD \
 *   DATABASE_URL=postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway \
 *     npm run maint:marshal-p1p3 -- --apply
 *
 * Production apply (explicit ops approval only — not run by this PR):
 *   PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_MIGRATE_20261018 \
 *   MARSHAL_WRITE_FREEZE_CONFIRM=HELD \
 *   NEON_PITR_WINDOW_CONFIRMED=YES \
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npm run maint:marshal-p1p3 -- --apply
 *
 * Checksum sync is a separate approval (not implied by --apply):
 *   PROD_MAINTENANCE_CONFIRM=MARSHAL_P1P3_CHECKSUM_SYNC_20261018
 *
 * Runs only: prisma --version, prisma migrate status, prisma migrate deploy.
 * Forbidden: psql -f, prisma db execute, migrate resolve, db push, reset, seed.
 */
import { main } from "./marshalPenaltyMaint";

void main();
