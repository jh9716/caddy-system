/**
 * Production READ ONLY: CourseReportPhoto V1 table / indexes / FK / counts.
 * WRITE 금지. migrate 금지. Blob 금지. Push 금지.
 *
 * Before apply:
 *   npx tsx scripts/inspect-course-report-photo-v1-prod-readonly.ts
 *
 * After apply:
 *   EXPECT_PHOTO_APPLIED=1 npx tsx scripts/inspect-course-report-photo-v1-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const PHOTO_MIGRATION = "20260918233000_course_report_photo_v1";
const TEXT_MIGRATION = "20260918140000_course_report_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const EXPECTED_COLUMNS = [
  "id",
  "reportId",
  "storageKey",
  "mimeType",
  "size",
  "sortOrder",
  "createdAt",
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
    const photoMig = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE migration_name = '${PHOTO_MIGRATION}'`
    );
    const textMig = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE migration_name = '${TEXT_MIGRATION}'`
    );
    const pending = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE finished_at IS NULL
       ORDER BY migration_name`
    );
    const photoTable = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'CourseReportPhoto'
       ) AS exists`
    );
    const photoTableExists = Boolean(photoTable[0]?.exists);
    const columns = photoTableExists
      ? await prisma.$queryRawUnsafe<
          Array<{
            column_name: string;
            udt_name: string;
            is_nullable: string;
            column_default: string | null;
          }>
        >(
          `SELECT column_name, udt_name, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'CourseReportPhoto'
           ORDER BY ordinal_position`
        )
      : [];
    const indexes = photoTableExists
      ? await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'CourseReportPhoto'
           ORDER BY indexname`
        )
      : [];
    const fks = photoTableExists
      ? await prisma.$queryRawUnsafe<
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
             AND tc.table_name = 'CourseReportPhoto'
             AND tc.constraint_type = 'FOREIGN KEY'`
        )
      : [];
    const counts = await prisma.$queryRawUnsafe<
      Array<{
        course_report: bigint | number;
        course_report_photo: bigint | number | null;
        users: bigint | number;
        caddy: bigint | number;
        notice: bigint | number;
        published: bigint | number;
        push: bigint | number;
      }>
    >(
      `SELECT
         (SELECT COUNT(*)::bigint FROM "CourseReport") AS course_report,
         ${
           photoTableExists
             ? `(SELECT COUNT(*)::bigint FROM "CourseReportPhoto")`
             : `NULL`
         } AS course_report_photo,
         (SELECT COUNT(*)::bigint FROM "User") AS users,
         (SELECT COUNT(*)::bigint FROM "Caddy") AS caddy,
         (SELECT COUNT(*)::bigint FROM "Notice") AS notice,
         (SELECT COUNT(*)::bigint FROM "DailyBoardPublished") AS published,
         (SELECT COUNT(*)::bigint FROM "PushSubscription") AS push`
    );
    const photoMigrationApplied = photoMig.length > 0 && Boolean(photoMig[0]?.finished_at);
    const photoRows = photoTableExists ? Number(counts[0]?.course_report_photo ?? -1) : 0;
    const courseReportRows = Number(counts[0]?.course_report ?? -1);
    const colNames = columns.map((c) => c.column_name);
    const missingCols = EXPECTED_COLUMNS.filter((c) => !colNames.includes(c));
    const reportFk = fks.find((f) => f.column_name === "reportId");
    const okNotApplied = !photoMigrationApplied && !photoTableExists && courseReportRows === 0;
    const okApplied =
      photoMigrationApplied &&
      photoTableExists &&
      pending.length === 0 &&
      missingCols.length === 0 &&
      photoRows === 0 &&
      courseReportRows === 0 &&
      reportFk?.foreign_table === "CourseReport" &&
      reportFk?.delete_rule === "CASCADE";
    const expectApplied = process.env.EXPECT_PHOTO_APPLIED === "1";
    const ok = expectApplied ? okApplied : okNotApplied;

    console.log(
      JSON.stringify(
        {
          ok,
          expectApplied,
          okNotApplied,
          okApplied,
          host,
          textMigrationApplied: Boolean(textMig[0]?.finished_at),
          photoMigrationApplied,
          photoMigration: photoMig[0] ?? null,
          pendingMigrations: pending.map((p) => p.migration_name),
          photoTableExists,
          columns: colNames,
          missingColumns: missingCols,
          indexes: indexes.map((i) => i.indexname),
          fks,
          courseReportRows,
          courseReportPhotoRows: photoTableExists ? photoRows : null,
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
