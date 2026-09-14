/**
 * Production READ ONLY: DailySpecialSupport kind/workPattern 분포.
 * WRITE 금지. migrate 금지. DATABASE_URL 을 production 으로 덮지 않음.
 *
 *   npx tsx scripts/inspect-daily-special-support-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";

function assertReadOnly() {
  if (process.env.PROD_MAINTENANCE_CONFIRM) {
    throw new Error("이 스크립트는 maintenance confirm 없이 SELECT만 합니다.");
  }
}

async function main() {
  assertReadOnly();
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) {
    console.log("SKIP: PRODUCTION_DATABASE_URL 없음 (READ ONLY 조회 생략)");
    return;
  }
  const prisma = new PrismaClient({
    datasources: { db: { url } },
  });
  try {
    const kinds = await prisma.$queryRaw<
      Array<{ kind: string; workpattern: string; shift: string; n: bigint }>
    >`
      SELECT kind::text AS kind,
             "workPattern"::text AS workpattern,
             shift,
             COUNT(*)::bigint AS n
      FROM "DailySpecialSupport"
      GROUP BY kind, "workPattern", shift
      ORDER BY kind, "workPattern", shift
    `;
    const recent = await prisma.$queryRaw<
      Array<{
        id: number;
        date: Date;
        caddyid: number;
        name: string;
        kind: string;
        workpattern: string;
        shift: string;
        sortorder: number;
        createdat: Date;
        updatedat: Date;
      }>
    >`
      SELECT s.id,
             s.date,
             s."caddyId" AS caddyid,
             c.name,
             s.kind::text AS kind,
             s."workPattern"::text AS workpattern,
             s.shift,
             s."sortOrder" AS sortorder,
             s."createdAt" AS createdat,
             s."updatedAt" AS updatedat
      FROM "DailySpecialSupport" s
      JOIN "Caddy" c ON c.id = s."caddyId"
      ORDER BY s."updatedAt" DESC, s.id DESC
      LIMIT 40
    `;
    const nonSpecial = await prisma.$queryRaw<
      Array<{
        id: number;
        date: Date;
        caddyid: number;
        name: string;
        kind: string;
        workpattern: string;
        shift: string;
        createdat: Date;
      }>
    >`
      SELECT s.id,
             s.date,
             s."caddyId" AS caddyid,
             c.name,
             s.kind::text AS kind,
             s."workPattern"::text AS workpattern,
             s.shift,
             s."createdAt" AS createdat
      FROM "DailySpecialSupport" s
      JOIN "Caddy" c ON c.id = s."caddyId"
      WHERE s.kind <> 'SPECIAL_SUPPORT'
      ORDER BY s.date DESC, s.id DESC
      LIMIT 50
    `;
    console.log(
      JSON.stringify(
        {
          mode: "read-only",
          kindPatternCounts: kinds.map((r) => ({
            kind: r.kind,
            workPattern: r.workpattern,
            shift: r.shift,
            n: Number(r.n),
          })),
          nonSpecialRows: nonSpecial.map((r) => ({
            id: r.id,
            date: r.date,
            caddyId: r.caddyid,
            name: r.name,
            kind: r.kind,
            workPattern: r.workpattern,
            shift: r.shift,
            createdAt: r.createdat,
          })),
          recent: recent.map((r) => ({
            id: r.id,
            date: r.date,
            caddyId: r.caddyid,
            name: r.name,
            kind: r.kind,
            workPattern: r.workpattern,
            shift: r.shift,
            sortOrder: r.sortorder,
            createdAt: r.createdat,
            updatedAt: r.updatedat,
          })),
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
