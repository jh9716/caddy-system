/**
 * Production READ ONLY: CourseReport V1 table / enums / indexes / FKs.
 * WRITE 금지. migrate 금지. CourseReport INSERT/UPDATE/DELETE 금지. Push 금지.
 *
 *   npx tsx scripts/inspect-course-report-v1-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const MIGRATION_NAME = "20260918140000_course_report_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const EXPECTED_COLUMNS = [
  "id",
  "authorUserId",
  "authorCaddyId",
  "authorDisplayName",
  "title",
  "body",
  "course",
  "hole",
  "category",
  "status",
  "handlerUserId",
  "resolvedAt",
  "deletedAt",
  "createdAt",
  "updatedAt",
] as const;
const EXPECTED_INDEXES = [
  "CourseReport_deletedAt_status_createdAt_idx",
  "CourseReport_authorUserId_idx",
  "CourseReport_course_hole_idx",
  "CourseReport_category_idx",
] as const;

function assertReadOnly() {
  if (
    process.env.MIGRATE === "1" ||
    process.env.DB_PUSH === "1" ||
    process.env.ALLOW_DB_WRITE === "1" ||
    process.env.PROD_MAINTENANCE_CONFIRM
  ) {
    throw new Error("write/migrate flags are not allowed for this inspect script");
  }
}

async function main() {
  assertReadOnly();
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("PRODUCTION_DATABASE_URL required (read-only)");
  if (!isProductionDatabaseUrl(url)) {
    throw new Error("PRODUCTION_DATABASE_URL does not look like production");
  }
  const host = parseDatabaseUrl(url).hostname;
  if (host !== EXPECTED_HOST) {
    throw new Error(`unexpected host ${host}`);
  }
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    await prisma.$queryRaw`SELECT 1`;
    const applied = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE migration_name = '${MIGRATION_NAME}'`
    );
    const pending = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE finished_at IS NULL
       ORDER BY migration_name`
    );
    const columns = await prisma.$queryRawUnsafe<
      Array<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'CourseReport'
       ORDER BY ordinal_position`
    );
    const indexes = await prisma.$queryRawUnsafe<
      Array<{ indexname: string }>
    >(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'CourseReport'
       ORDER BY indexname`
    );
    const fks = await prisma.$queryRawUnsafe<
      Array<{
        constraint_name: string;
        column_name: string;
        foreign_table: string;
        delete_rule: string;
      }>
    >(
      `SELECT
         tc.constraint_name,
         kcu.column_name,
         ccu.table_name AS foreign_table,
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
         AND tc.table_name = 'CourseReport'
         AND tc.constraint_type = 'FOREIGN KEY'`
    );
    const enums = await prisma.$queryRawUnsafe<
      Array<{ typname: string; enumlabel: string }>
    >(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname IN ('CourseReportCategory', 'CourseReportStatus')
       ORDER BY t.typname, e.enumsortorder`
    );
    const counts = await prisma.$queryRawUnsafe<
      Array<{
        course_report: bigint | number;
        users: bigint | number;
        caddy: bigint | number;
        notice: bigint | number;
        published: bigint | number;
        push: bigint | number;
      }>
    >(
      `SELECT
         (SELECT COUNT(*)::bigint FROM "CourseReport") AS course_report,
         (SELECT COUNT(*)::bigint FROM "User") AS users,
         (SELECT COUNT(*)::bigint FROM "Caddy") AS caddy,
         (SELECT COUNT(*)::bigint FROM "Notice") AS notice,
         (SELECT COUNT(*)::bigint FROM "DailyBoardPublished") AS published,
         (SELECT COUNT(*)::bigint FROM "PushSubscription") AS push`
    );
    const colNames = columns.map((c) => c.column_name);
    const idxNames = indexes.map((i) => i.indexname);
    const missingCols = EXPECTED_COLUMNS.filter((c) => !colNames.includes(c));
    const missingIdx = EXPECTED_INDEXES.filter((c) => !idxNames.includes(c));
    const userFk = fks.find((f) => f.column_name === "authorUserId");
    const caddyFk = fks.find((f) => f.column_name === "authorCaddyId");
    const n = Number(counts[0]?.course_report ?? -1);
    const ok =
      applied.length === 1 &&
      Boolean(applied[0]?.finished_at) &&
      pending.length === 0 &&
      missingCols.length === 0 &&
      missingIdx.length === 0 &&
      n === 0 &&
      userFk?.delete_rule === "RESTRICT" &&
      caddyFk?.delete_rule === "SET NULL";

    console.log(
      JSON.stringify(
        {
          ok,
          host,
          migration: MIGRATION_NAME,
          applied: applied[0] ?? null,
          pendingMigrations: pending.map((p) => p.migration_name),
          schemaUpToDate: pending.length === 0 && Boolean(applied[0]?.finished_at),
          columns: colNames,
          missingColumns: missingCols,
          indexes: idxNames,
          missingIndexes: missingIdx,
          fks,
          enums,
          courseReportRows: n,
          counts: {
            User: Number(counts[0]?.users ?? -1),
            Caddy: Number(counts[0]?.caddy ?? -1),
            Notice: Number(counts[0]?.notice ?? -1),
            DailyBoardPublished: Number(counts[0]?.published ?? -1),
            PushSubscription: Number(counts[0]?.push ?? -1),
          },
        },
        null,
        2
      )
    );
    if (!ok) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
