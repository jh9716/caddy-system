/**
 * Production READ ONLY: PushSubscription table/index/FK/counts.
 * WRITE 금지. migrate 금지. INSERT 금지.
 *
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *   npx tsx scripts/inspect-push-subscription-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";

const MIGRATION_NAME = "20260917200000_push_subscription";
const NEXT_MIGRATION_NAME = "20260920013000_push_subscription_user_endpoint_unique";
const FINALIZE_MIGRATION_NAME = "20260920043000_push_subscription_drop_endpoint_unique";

const MAJOR_TABLES = [
  "User",
  "Caddy",
  "Assignment",
  "Audit",
  "DailySchedule",
  "Schedule",
  "Notice",
  "ShiftDuty",
  "DailyBoardDraft",
  "DailyBoardPublished",
  "DailySpecialSupport",
  "DailyOpsDuty",
  "DailyCaddyUnavailable",
  "CaddyLinkRequest",
  "DailyAssignmentChange",
  "DailyOffOverride",
  "DailyOpsDutyOverride",
  "DailyOpsSnapshot",
  "DailyPlacement",
  "DailyReservation",
  "DailySpecialDuty",
  "DailySpecialDutyAnchor",
  "DailySpecialPlacementSetting",
  "OffRequest",
  "ScheduleExtraTag",
  "ThirdWeeklyStartOverride",
] as const;

function assertReadOnly() {
  if (process.env.MIGRATE === "1" || process.env.DB_PUSH === "1" || process.env.ALLOW_DB_WRITE === "1") {
    throw new Error("write flags are not allowed for this inspect script");
  }
}

async function countIfExists(prisma: PrismaClient, table: string): Promise<number | null> {
  const exists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '${table}'
     ) AS exists`
  );
  if (!exists[0]?.exists) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS n FROM "${table}"`
  );
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  assertReadOnly();
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL required (read-only)");
  }
  const prisma = new PrismaClient();
  try {
    const tableExists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'PushSubscription'
       ) AS exists`
    );
    const exists = tableExists[0]?.exists === true;
    const columns = exists
      ? await prisma.$queryRawUnsafe<
          Array<{ column_name: string; data_type: string; is_nullable: string }>
        >(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'PushSubscription'
           ORDER BY ordinal_position`
        )
      : [];
    const indexes = exists
      ? await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'PushSubscription'
           ORDER BY indexname`
        )
      : [];
    const fks = exists
      ? await prisma.$queryRawUnsafe<
          Array<{
            constraint_name: string;
            column_name: string;
            foreign_table: string;
            foreign_column: string;
            delete_rule: string;
          }>
        >(
          `SELECT
             tc.constraint_name,
             kcu.column_name,
             ccu.table_name AS foreign_table,
             ccu.column_name AS foreign_column,
             rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name
            AND tc.constraint_schema = rc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON rc.unique_constraint_name = ccu.constraint_name
            AND rc.unique_constraint_schema = ccu.table_schema
           WHERE tc.table_schema = 'public'
             AND tc.table_name = 'PushSubscription'
             AND tc.constraint_type = 'FOREIGN KEY'`
        )
      : [];
    const applied = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; checksum: string }>
    >(
      `SELECT migration_name, finished_at, checksum
       FROM "_prisma_migrations"
       WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const nextApplied = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; checksum: string }>
    >(
      `SELECT migration_name, finished_at, checksum
       FROM "_prisma_migrations"
       WHERE migration_name = '${NEXT_MIGRATION_NAME}'`
    );
    const finalizeApplied = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; checksum: string }>
    >(
      `SELECT migration_name, finished_at, checksum
       FROM "_prisma_migrations"
       WHERE migration_name = '${FINALIZE_MIGRATION_NAME}'`
    );

    const major: Record<string, number | null> = {};
    for (const t of MAJOR_TABLES) {
      major[t] = await countIfExists(prisma, t);
    }
    const pushRows = exists ? await countIfExists(prisma, "PushSubscription") : null;
    const endpointDistinct = exists
      ? await prisma.$queryRawUnsafe<
          Array<{ rows: bigint | number; distinct_endpoints: bigint | number }>
        >(
          `SELECT COUNT(*)::bigint AS rows,
                  COUNT(DISTINCT endpoint)::bigint AS distinct_endpoints
           FROM "PushSubscription"`
        )
      : [];
    const rowSummaries = exists
      ? await prisma.$queryRawUnsafe<
          Array<{ id: number; userId: number; enabled: boolean }>
        >(
          `SELECT id, "userId", enabled
           FROM "PushSubscription"
           ORDER BY id`
        )
      : [];
    const duplicateEndpointGroups = exists
      ? await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
          `SELECT COUNT(*)::bigint AS n FROM (
             SELECT 1 FROM "PushSubscription"
             GROUP BY endpoint
             HAVING COUNT(*) > 1
           ) d`
        )
      : [];
    const duplicateUserEndpointGroups = exists
      ? await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
          `SELECT COUNT(*)::bigint AS n FROM (
             SELECT 1 FROM "PushSubscription"
             GROUP BY "userId", endpoint
             HAVING COUNT(*) > 1
           ) d`
        )
      : [];

    console.log(
      JSON.stringify(
        {
          mode: "read-only",
          writes: false,
          tableExists: exists,
          columns: columns.map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable,
          })),
          indexes: indexes.map((i) => ({
            name: i.indexname,
            unique: /UNIQUE/i.test(i.indexdef),
            defHasEndpoint: i.indexdef.includes("endpoint"),
            defHasUserId: i.indexdef.includes("userId"),
          })),
          foreignKeys: fks,
          migrationApplied: applied.map((r) => ({
            name: r.migration_name,
            finished: Boolean(r.finished_at),
            checksumPresent: Boolean(r.checksum),
          })),
          nextMigrationApplied: nextApplied.map((r) => ({
            name: r.migration_name,
            finished: Boolean(r.finished_at),
            checksumPresent: Boolean(r.checksum),
          })),
          finalizeMigrationApplied: finalizeApplied.map((r) => ({
            name: r.migration_name,
            finished: Boolean(r.finished_at),
            checksumPresent: Boolean(r.checksum),
          })),
          pushSubscriptionRows: pushRows,
          endpointDistinctCount: endpointDistinct[0]
            ? Number(endpointDistinct[0].distinct_endpoints ?? 0)
            : null,
          duplicateEndpointGroups: duplicateEndpointGroups[0]
            ? Number(duplicateEndpointGroups[0].n ?? 0)
            : null,
          duplicateUserEndpointGroups: duplicateUserEndpointGroups[0]
            ? Number(duplicateUserEndpointGroups[0].n ?? 0)
            : null,
          rowSummaries: rowSummaries.map((r) => ({
            id: r.id,
            userId: r.userId,
            enabled: r.enabled,
          })),
          majorTableCounts: major,
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
