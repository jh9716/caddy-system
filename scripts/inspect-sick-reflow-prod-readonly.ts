/**
 * Production READ ONLY: find 서승희 / 김하나1 / 김예진1 in recent Drafts
 * and reconstruct 1부 sequence + spare around a sick-leave reflow.
 * WRITE 금지. migrate 금지. DATABASE_URL 을 production 으로 덮지 않음.
 *
 *   npx tsx scripts/inspect-sick-reflow-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";

function assertReadOnly() {
  if (process.env.PROD_MAINTENANCE_CONFIRM) {
    throw new Error("이 스크립트는 maintenance confirm 없이 SELECT만 합니다.");
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function nameOf(row: Record<string, unknown>): string {
  const caddy = asRecord(row.caddy);
  return String(caddy.name || "");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

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
    const drafts = await prisma.$queryRaw<
      Array<{ date: Date; version: number; updatedAt: Date; payload: unknown }>
    >`
      SELECT date, version, "updatedAt", payload
      FROM "DailyBoardDraft"
      WHERE date >= DATE '2026-08-20' AND date <= DATE '2026-08-31'
      ORDER BY date DESC
    `;
    const hits: unknown[] = [];
    for (const draft of drafts) {
      const payload = asRecord(draft.payload);
      const assignments = Array.isArray(payload.assignments)
        ? payload.assignments.map((r) => asRecord(r))
        : [];
      const names = assignments.map(nameOf);
      const wanted = ["서승희", "김하나1", "김예진1"];
      const found = wanted.filter((n) => names.some((x) => x.includes(n.replace("1", "")) || x === n));
      const exact = {
        서승희: names.includes("서승희"),
        김하나1: names.includes("김하나1"),
        김예진1: names.includes("김예진1") || names.includes("김예진"),
      };
      if (!exact.서승희 && !names.some((n) => n.includes("서승희"))) continue;
      const shift1 = assignments
        .filter((row) => {
          const res = asRecord(row.reservation);
          return String(res.shift || row.shift || "") === "1부";
        })
        .map((row, i) => {
          const res = asRecord(row.reservation);
          const caddy = asRecord(row.caddy);
          return {
            i,
            kind: String(row.kind || ""),
            locked: row.locked === true,
            course: String(res.course || ""),
            teeTime: String(res.teeTime || ""),
            teamName: String(res.teamName || ""),
            caddyId: Number(caddy.id) || null,
            name: String(caddy.name || ""),
            team: String(caddy.team || ""),
            teamOrder: Number(caddy.teamOrder) || 0,
            caddyType: String(caddy.caddyType || ""),
          };
        })
        .sort((a, b) => a.teeTime.localeCompare(b.teeTime) || a.course.localeCompare(b.course));
      const sky614 = shift1.find(
        (r) => r.course === "SKY" && (r.teeTime === "06:14" || r.teeTime === "6:14")
      );
      const spares = Array.isArray(payload.sparesByShift)
        ? payload.sparesByShift.map((s) => asRecord(s))
        : [];
      const spare1 = asRecord(
        (spares.find((s) => String(s.shift) === "1부") || {}).spare1
      );
      const spare2 = asRecord(
        (spares.find((s) => String(s.shift) === "1부") || {}).spare2
      );
      const pool = Array.isArray(payload.caddyPool)
        ? payload.caddyPool.map((c) => asRecord(c))
        : [];
      const poolHouse = pool
        .filter((c) => {
          const team = String(c.team || "");
          const t = String(c.caddyType || "HOUSE").toUpperCase();
          return !/^9조$|^10조$|^11조$|^12조$/.test(team) && (t === "HOUSE" || t === "");
        })
        .sort((a, b) => Number(a.teamOrder) - Number(b.teamOrder) || Number(a.id) - Number(b.id))
        .map((c) => ({
          id: Number(c.id),
          name: String(c.name || ""),
          team: String(c.team || ""),
          teamOrder: Number(c.teamOrder) || 0,
        }));
      hits.push({
        date: draft.date,
        version: draft.version,
        updatedAt: draft.updatedAt,
        exact,
        found,
        sky614,
        first8Regular1부: shift1.filter((r) => r.kind === "regular").slice(0, 8),
        서승희: shift1.find((r) => r.name === "서승희") || null,
        김하나1: shift1.find((r) => r.name === "김하나1") || null,
        김예진1: shift1.find((r) => r.name === "김예진1" || r.name === "김예진") || null,
        spare1: spare1.name
          ? { name: spare1.name, caddyId: spare1.caddyId, team: spare1.team, teamOrder: spare1.teamOrder }
          : null,
        spare2: spare2.name
          ? { name: spare2.name, caddyId: spare2.caddyId, team: spare2.team, teamOrder: spare2.teamOrder }
          : null,
        houseStartInferred: shift1.find((r) => r.kind === "regular") || null,
        poolHouseFirst8: poolHouse.slice(0, 8),
        poolHas김예진1: poolHouse.some((c) => c.name === "김예진1" || c.name === "김예진"),
        payloadHouseStartCaddyId: payload.houseStartCaddyId ?? null,
      });
    }

    const changes = await prisma.$queryRaw<
      Array<{
        date: Date;
        changeType: string;
        cause: string | null;
        appliedAt: Date;
        payload: unknown;
      }>
    >`
      SELECT date, "changeType"::text, cause, "appliedAt", payload
      FROM "DailyAssignmentChange"
      WHERE date >= DATE '2026-08-20' AND date <= DATE '2026-08-31'
        AND "changeType"::text IN ('CADDY_SICK', 'CADDY_ATTENDANCE_NOSHOW')
      ORDER BY "appliedAt" DESC
      LIMIT 20
    `;

    console.log(
      JSON.stringify(
        {
          draftHits: hits,
          recentSickChanges: changes.map((c) => ({
            date: c.date,
            changeType: c.changeType,
            cause: c.cause,
            appliedAt: c.appliedAt,
            payload: c.payload,
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
