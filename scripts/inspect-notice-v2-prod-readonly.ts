/**
 * Production READ ONLY: Notice V2 columns / defaults / indexes / identity.
 * WRITE 금지. migrate 금지. Notice INSERT/UPDATE/DELETE 금지. Push 금지.
 *
 *   npx tsx scripts/inspect-notice-v2-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl, parseDatabaseUrl } from "../src/lib/dbSafety";

const MIGRATION_NAME = "20260918120000_notice_v2";
const NEW_COLUMNS = [
  "important",
  "pinned",
  "targetType",
  "targetValue",
  "publishStartAt",
  "publishEndAt",
  "pushSentAt",
  "pushSentByUserId",
] as const;
const EXPECTED_INDEXES = [
  "Notice_pinned_important_createdAt_idx",
  "Notice_targetType_targetValue_idx",
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
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    await prisma.$queryRaw`SELECT 1`;
    const applied = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; finished_at: Date | null; checksum: string }>
    >(
      `SELECT migration_name, finished_at, checksum
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
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Notice'
       ORDER BY ordinal_position`
    );
    const indexes = await prisma.$queryRawUnsafe<
      Array<{ indexname: string }>
    >(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'Notice'
       ORDER BY indexname`
    );
    const counts = await prisma.$queryRawUnsafe<
      Array<{
        n: bigint | number;
        important_false: bigint | number;
        pinned_false: bigint | number;
        target_all: bigint | number;
        target_value_null: bigint | number;
        start_null: bigint | number;
        end_null: bigint | number;
        push_sent_null: bigint | number;
        push_by_null: bigint | number;
      }>
    >(
      `SELECT
         COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE important = false)::bigint AS important_false,
         COUNT(*) FILTER (WHERE pinned = false)::bigint AS pinned_false,
         COUNT(*) FILTER (WHERE "targetType" = 'ALL')::bigint AS target_all,
         COUNT(*) FILTER (WHERE "targetValue" IS NULL)::bigint AS target_value_null,
         COUNT(*) FILTER (WHERE "publishStartAt" IS NULL)::bigint AS start_null,
         COUNT(*) FILTER (WHERE "publishEndAt" IS NULL)::bigint AS end_null,
         COUNT(*) FILTER (WHERE "pushSentAt" IS NULL)::bigint AS push_sent_null,
         COUNT(*) FILTER (WHERE "pushSentByUserId" IS NULL)::bigint AS push_by_null
       FROM "Notice"`
    );
    const identity = await prisma.$queryRawUnsafe<
      Array<{
        id: number;
        title: string;
        content: string;
        author: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(
      `SELECT id, title, content, author, "createdAt", "updatedAt"
       FROM "Notice"
       ORDER BY id ASC`
    );
    const sample = await prisma.$queryRawUnsafe<
      Array<{
        id: number;
        title: string;
        targetType: string;
        targetValue: string | null;
        important: boolean;
        pinned: boolean;
        publishStartAt: Date | null;
        publishEndAt: Date | null;
        pushSentAt: Date | null;
        pushSentByUserId: number | null;
      }>
    >(
      `SELECT id, title, "targetType", "targetValue", important, pinned,
              "publishStartAt", "publishEndAt", "pushSentAt", "pushSentByUserId"
       FROM "Notice"
       ORDER BY id ASC
       LIMIT 8`
    );
    const pushCount = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "PushSubscription"`
    );
    const noticePushAudits = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS n FROM "Audit" WHERE action = 'NOTICE_PUSH_SEND'`
    );
    const appliedAll = await prisma.$queryRawUnsafe<
      Array<{ n: bigint | number }>
    >(
      `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
    );

    const identityFingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          identity.map((r) => ({
            id: r.id,
            title: r.title,
            content: r.content,
            author: r.author,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          }))
        )
      )
      .digest("hex");
    const expectedFingerprint =
      "346557b614d1a52c41f0c77e976a93ef27017b017c8e74119cd191016d4aad4d";

    const colNames = columns.map((c) => c.column_name);
    const idxNames = indexes.map((i) => i.indexname);
    const n = Number(counts[0]?.n ?? -1);
    const missingCols = NEW_COLUMNS.filter((c) => !colNames.includes(c));
    const missingIdx = EXPECTED_INDEXES.filter((c) => !idxNames.includes(c));
    const d = counts[0];
    const defaultsOk =
      n >= 0 &&
      Number(d.important_false) === n &&
      Number(d.pinned_false) === n &&
      Number(d.target_all) === n &&
      Number(d.target_value_null) === n &&
      Number(d.start_null) === n &&
      Number(d.end_null) === n &&
      Number(d.push_sent_null) === n &&
      Number(d.push_by_null) === n;
    const identityUnchanged = identityFingerprint === expectedFingerprint;
    const pushSubscriptionRows = Number(pushCount[0]?.n ?? -1);
    const noticePushSendAudits = Number(noticePushAudits[0]?.n ?? -1);
    const finishedMigrations = Number(appliedAll[0]?.n ?? -1);

    console.log(
      JSON.stringify(
        {
          ok:
            applied.length === 1 &&
            Boolean(applied[0]?.finished_at) &&
            pending.length === 0 &&
            missingCols.length === 0 &&
            missingIdx.length === 0 &&
            defaultsOk &&
            identityUnchanged &&
            noticePushSendAudits === 0,
          host,
          migration: MIGRATION_NAME,
          applied: applied[0] ?? null,
          pendingMigrations: pending.map((p) => p.migration_name),
          finishedMigrations,
          schemaUpToDate: pending.length === 0 && Boolean(applied[0]?.finished_at),
          noticeCount: n,
          noticeCountBeforeDeploy: 1,
          identityFingerprint,
          expectedFingerprint,
          identityUnchanged,
          columns: colNames,
          missingColumns: missingCols,
          indexes: idxNames,
          missingIndexes: missingIdx,
          defaultsOk,
          sample,
          pushSubscriptionRows,
          noticePushSendAudits,
        },
        null,
        2
      )
    );
    if (
      missingCols.length ||
      missingIdx.length ||
      !applied.length ||
      !defaultsOk ||
      !identityUnchanged ||
      noticePushSendAudits !== 0
    ) {
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
