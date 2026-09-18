/**
 * Production READ ONLY: 2026-09-07 Published vs Draft freshness for board push.
 * WRITE 금지. Audit INSERT 금지. Push 금지. PushSubscription 변경 금지.
 *
 *   npx tsx scripts/inspect-board-push-freshness-prod-readonly.ts
 *
 * Uses PRODUCTION_DATABASE_URL directly. Does not replace local DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { isProductionDatabaseUrl } from "../src/lib/dbSafety";
import { resolvePublishedFreshness } from "../src/lib/alimtalkPublishedFreshness";

const DATE = "2026-09-07";

function assertReadOnly() {
  if (process.env.MIGRATE === "1" || process.env.DB_PUSH === "1" || process.env.ALLOW_DB_WRITE === "1") {
    throw new Error("write flags are not allowed for this inspect script");
  }
}

async function main() {
  assertReadOnly();
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("PRODUCTION_DATABASE_URL required (read-only)");
  if (!isProductionDatabaseUrl(url)) {
    throw new Error("PRODUCTION_DATABASE_URL does not look like production");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    await prisma.$queryRaw`SELECT 1`;
    const published = await prisma.$queryRaw<
      Array<{ date: Date; sourceDraftVersion: number }>
    >`
      SELECT date, "sourceDraftVersion"
      FROM "DailyBoardPublished"
      WHERE date::date = ${DATE}::date
         OR to_char(date AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = ${DATE}
      LIMIT 5
    `;
    const draft = await prisma.$queryRaw<Array<{ date: Date; version: number }>>`
      SELECT date, version
      FROM "DailyBoardDraft"
      WHERE date::date = ${DATE}::date
         OR to_char(date AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = ${DATE}
      LIMIT 5
    `;
    const pub = published[0] ?? null;
    const dr = draft[0] ?? null;
    const freshness = resolvePublishedFreshness({
      hasPublished: Boolean(pub),
      publishedSourceDraftVersion: pub?.sourceDraftVersion ?? null,
      currentDraftVersion: dr?.version ?? null,
    });
    const auditCount = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM "Audit"
      WHERE action = 'BOARD_PUSH_SEND'
        AND entity = 'DailyBoardPublished'
        AND payload->>'date' = ${DATE}
    `;
    const n = Number(auditCount[0]?.n ?? 0);

    console.log("date", DATE);
    console.log("publishedRows", published.length);
    console.log("publishedSourceDraftVersion", pub?.sourceDraftVersion ?? null);
    console.log("draftRows", draft.length);
    console.log("currentDraftVersion", dr?.version ?? null);
    console.log("freshness.status", freshness.status);
    console.log("freshness.canSend", freshness.canSend);
    console.log("boardPushSendAuditCount", n);
    console.log("wouldBlockSend", freshness.canSend !== true);
    console.log("wrote", 0);
    console.log("pushed", 0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
