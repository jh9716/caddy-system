/**
 * Production READ ONLY: confirm CourseReport Photo V1 is NOT applied yet.
 * WRITE 금지. migrate 금지. Blob 금지. Push 금지.
 *
 *   npx tsx scripts/inspect-course-report-photo-v1-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const PHOTO_MIGRATION = "20260918233000_course_report_photo_v1";
const TEXT_MIGRATION = "20260918140000_course_report_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";

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
    const photoTable = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'CourseReportPhoto'
       ) AS exists`
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
    const photoTableExists = Boolean(photoTable[0]?.exists);
    const photoMigrationApplied = photoMig.length > 0 && Boolean(photoMig[0]?.finished_at);
    const ok =
      Boolean(textMig[0]?.finished_at) &&
      !photoTableExists &&
      !photoMigrationApplied &&
      Number(counts[0]?.course_report ?? -1) === 0;

    console.log(
      JSON.stringify(
        {
          ok,
          host,
          textMigrationApplied: Boolean(textMig[0]?.finished_at),
          photoMigrationApplied,
          photoTableExists,
          courseReportRows: Number(counts[0]?.course_report ?? -1),
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
