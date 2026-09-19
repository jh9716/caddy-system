/**
 * Production READ ONLY: Comment V1 enum / tables / indexes / FK / counts.
 * WRITE 금지. migrate 금지. Blob 금지. Push 금지. Comment POST 금지.
 *
 * Before apply:
 *   npx tsx scripts/inspect-comment-v1-prod-readonly.ts
 *
 * After apply:
 *   EXPECT_COMMENT_APPLIED=1 npx tsx scripts/inspect-comment-v1-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const COMMENT_MIGRATION = "20260919070000_comment_v1";
const PHOTO_MIGRATION = "20260918233000_course_report_photo_v1";
const EXPECTED_HOST = "ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech";
const EXPECTED_ENUM = ["COURSE_REPORT", "BOARD_DATE", "NOTICE"] as const;
const EXPECTED_THREAD_COLUMNS = [
  "id",
  "targetType",
  "targetKey",
  "createdAt",
  "updatedAt",
] as const;
const EXPECTED_COMMENT_COLUMNS = [
  "id",
  "threadId",
  "authorUserId",
  "body",
  "deletedAt",
  "createdAt",
  "updatedAt",
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

async function tableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '${table}'
     ) AS exists`
  );
  return Boolean(rows[0]?.exists);
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
    const commentMig = await prisma.$queryRawUnsafe<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        checksum: string;
      }>
    >(
      `SELECT migration_name, finished_at, checksum
       FROM "_prisma_migrations"
       WHERE migration_name = '${COMMENT_MIGRATION}'`
    );
    const photoMig = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE migration_name = '${PHOTO_MIGRATION}'`
    );
    const pending = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null }>
    >(
      `SELECT migration_name, finished_at
       FROM "_prisma_migrations"
       WHERE finished_at IS NULL
       ORDER BY migration_name`
    );
    const threadExists = await tableExists(prisma, "CommentThread");
    const commentExists = await tableExists(prisma, "Comment");
    const enumValues = (
      await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON t.oid = e.enumtypid
         WHERE t.typname = 'CommentTargetType'
         ORDER BY e.enumsortorder`
      )
    ).map((e) => e.enumlabel);

    const threadColumns = threadExists
      ? await prisma.$queryRawUnsafe<
          Array<{ column_name: string; udt_name: string; is_nullable: string }>
        >(
          `SELECT column_name, udt_name, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'CommentThread'
           ORDER BY ordinal_position`
        )
      : [];
    const commentColumns = commentExists
      ? await prisma.$queryRawUnsafe<
          Array<{ column_name: string; udt_name: string; is_nullable: string }>
        >(
          `SELECT column_name, udt_name, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'Comment'
           ORDER BY ordinal_position`
        )
      : [];
    const threadIndexes = threadExists
      ? await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'CommentThread'
           ORDER BY indexname`
        )
      : [];
    const commentIndexes = commentExists
      ? await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'Comment'
           ORDER BY indexname`
        )
      : [];
    const fks = commentExists
      ? await prisma.$queryRawUnsafe<
          Array<{
            constraint_name: string;
            column_name: string;
            foreign_table: string;
            foreign_column: string;
            delete_rule: string;
            update_rule: string;
          }>
        >(
          `SELECT
             tc.constraint_name,
             kcu.column_name,
             ccu.table_name AS foreign_table,
             ccu.column_name AS foreign_column,
             rc.delete_rule,
             rc.update_rule
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
             AND tc.table_name = 'Comment'
             AND tc.constraint_type = 'FOREIGN KEY'`
        )
      : [];

    const photoExists = await tableExists(prisma, "CourseReportPhoto");
    const counts = await prisma.$queryRawUnsafe<
      Array<{
        users: bigint | number;
        caddy: bigint | number;
        notice: bigint | number;
        course_report: bigint | number;
        course_report_photo: bigint | number | null;
        published: bigint | number;
        push: bigint | number;
        comment_thread: bigint | number | null;
        comment: bigint | number | null;
      }>
    >(
      `SELECT
         (SELECT COUNT(*)::bigint FROM "User") AS users,
         (SELECT COUNT(*)::bigint FROM "Caddy") AS caddy,
         (SELECT COUNT(*)::bigint FROM "Notice") AS notice,
         (SELECT COUNT(*)::bigint FROM "CourseReport") AS course_report,
         ${
           photoExists
             ? `(SELECT COUNT(*)::bigint FROM "CourseReportPhoto")`
             : `NULL`
         } AS course_report_photo,
         (SELECT COUNT(*)::bigint FROM "DailyBoardPublished") AS published,
         (SELECT COUNT(*)::bigint FROM "PushSubscription") AS push,
         ${
           threadExists ? `(SELECT COUNT(*)::bigint FROM "CommentThread")` : `NULL`
         } AS comment_thread,
         ${commentExists ? `(SELECT COUNT(*)::bigint FROM "Comment")` : `NULL`} AS comment`
    );

    const commentMigrationApplied =
      commentMig.length > 0 && Boolean(commentMig[0]?.finished_at);
    const threadCols = threadColumns.map((c) => c.column_name);
    const commentCols = commentColumns.map((c) => c.column_name);
    const missingThreadCols = EXPECTED_THREAD_COLUMNS.filter((c) => !threadCols.includes(c));
    const missingCommentCols = EXPECTED_COMMENT_COLUMNS.filter((c) => !commentCols.includes(c));
    const threadFk = fks.find((f) => f.column_name === "threadId");
    const authorFk = fks.find((f) => f.column_name === "authorUserId");
    const uniquePresent = threadIndexes.some(
      (i) => i.indexname === "CommentThread_targetType_targetKey_key"
    );
    const commentThreadRows = threadExists ? Number(counts[0]?.comment_thread ?? -1) : null;
    const commentRows = commentExists ? Number(counts[0]?.comment ?? -1) : null;

    const okNotApplied =
      !commentMigrationApplied && !threadExists && !commentExists && enumValues.length === 0;
    const okApplied =
      commentMigrationApplied &&
      threadExists &&
      commentExists &&
      pending.length === 0 &&
      enumValues.join(",") === EXPECTED_ENUM.join(",") &&
      missingThreadCols.length === 0 &&
      missingCommentCols.length === 0 &&
      uniquePresent &&
      commentThreadRows === 0 &&
      commentRows === 0 &&
      threadFk?.foreign_table === "CommentThread" &&
      threadFk?.delete_rule === "CASCADE" &&
      authorFk?.foreign_table === "User" &&
      authorFk?.delete_rule === "RESTRICT";
    const expectApplied = process.env.EXPECT_COMMENT_APPLIED === "1";
    const ok = expectApplied ? okApplied : okNotApplied;

    console.log(
      JSON.stringify(
        {
          ok,
          expectApplied,
          okNotApplied,
          okApplied,
          host,
          photoMigrationApplied: Boolean(photoMig[0]?.finished_at),
          commentMigrationApplied,
          commentMigration: commentMig[0] ?? null,
          pendingMigrations: pending.map((p) => p.migration_name),
          commentThreadTableExists: threadExists,
          commentTableExists: commentExists,
          commentTargetType: enumValues.length ? enumValues : "missing",
          commentThreadColumns: threadCols,
          commentColumns: commentCols,
          missingThreadColumns: missingThreadCols,
          missingCommentColumns: missingCommentCols,
          commentThreadIndexes: threadIndexes.map((i) => i.indexname),
          commentIndexes: commentIndexes.map((i) => i.indexname),
          fks,
          commentThreadRows,
          commentRows,
          counts: {
            User: Number(counts[0]?.users ?? -1),
            Caddy: Number(counts[0]?.caddy ?? -1),
            Notice: Number(counts[0]?.notice ?? -1),
            CourseReport: Number(counts[0]?.course_report ?? -1),
            CourseReportPhoto: photoExists ? Number(counts[0]?.course_report_photo ?? -1) : null,
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
