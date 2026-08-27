/**
 * Production READ ONLY: 특수근무/특수지원 vs Draft 배치 불일치 확인.
 * WRITE 금지. migrate 금지.
 *
 *   npx tsx scripts/inspect-special-assign-prod-readonly.ts
 * uses PRODUCTION_DATABASE_URL only (never copies it onto DATABASE_URL).
 */
import { PrismaClient } from "@prisma/client";
import { parseYmd } from "../src/lib/availabilityEngine";

const DATE = process.env.INSPECT_DATE || "2026-08-27";

function assertReadOnly() {
  if (process.env.PROD_MAINTENANCE_CONFIRM) {
    throw new Error("이 스크립트는 maintenance confirm 없이 SELECT만 합니다.");
  }
}

function summarizeAssignments(payload: unknown) {
  const o = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const assignments = Array.isArray(o.assignments) ? o.assignments : [];
  const kinds: Record<string, number> = {};
  const caddyIds = new Set<number>();
  for (const row of assignments) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { kind?: string; caddy?: { id?: number } };
    const kind = String(rec.kind || "unknown");
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (typeof rec.caddy?.id === "number") caddyIds.add(rec.caddy.id);
  }
  const pool = Array.isArray(o.caddyPool) ? o.caddyPool : [];
  const poolIds = new Set(
    pool
      .map((c) => (c && typeof c === "object" ? Number((c as { id?: number }).id) : 0))
      .filter((id) => id > 0)
  );
  return {
    assignmentCount: assignments.length,
    kinds,
    assignedIds: caddyIds,
    poolIds,
  };
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
  const { start, end } = parseYmd(DATE);
  try {
    const [duties, supports, draft] = await Promise.all([
      prisma.dailySpecialDuty.findMany({
        where: { date: { gte: start, lte: end } },
        include: { caddy: { select: { id: true, name: true, team: true, caddyType: true, employmentStatus: true } } },
        orderBy: [{ kind: "asc" }, { sortOrder: "asc" }],
      }),
      prisma.dailySpecialSupport.findMany({
        where: { date: { gte: start, lte: end } },
        include: { caddy: { select: { id: true, name: true, team: true, employmentStatus: true } } },
        orderBy: [{ shift: "asc" }, { id: "asc" }],
      }),
      prisma.dailyBoardDraft.findFirst({
        where: { date: { gte: start, lte: end } },
        select: { version: true, updatedAt: true, payload: true },
      }),
    ]);

    const draftSummary = draft ? summarizeAssignments(draft.payload) : null;
    const dutyIds = duties.map((d) => d.caddyId);
    const supportIds = supports.map((s) => s.caddyId);
    const dutyOnBoard = dutyIds.filter((id) => draftSummary?.assignedIds.has(id));
    const dutyMissing = dutyIds.filter((id) => !draftSummary?.assignedIds.has(id));
    const supportOnBoard = supportIds.filter((id) => draftSummary?.assignedIds.has(id));
    const supportMissing = supportIds.filter((id) => !draftSummary?.assignedIds.has(id));

    const report = {
      date: DATE,
      dailySpecialDuty: duties.map((d) => ({
        kind: d.kind,
        caddyId: d.caddyId,
        name: d.caddy.name,
        team: d.caddy.team,
        createdAt: d.createdAt,
      })),
      dailySpecialSupport: supports.map((s) => ({
        shift: s.shift,
        caddyId: s.caddyId,
        name: s.caddy.name,
        createdAt: s.createdAt,
      })),
      draft: draft
        ? {
            version: draft.version,
            updatedAt: draft.updatedAt,
            assignmentCount: draftSummary?.assignmentCount,
            kinds: draftSummary?.kinds,
          }
        : null,
      dutyOnBoard,
      dutyMissing,
      supportOnBoard,
      supportMissing,
      settingsExistButDraftLacksDuty: dutyMissing.length > 0,
      settingsExistButDraftLacksSupport: supportMissing.length > 0,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
