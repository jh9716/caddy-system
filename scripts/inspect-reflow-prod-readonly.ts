/**
 * Production READ ONLY: 2026-08-27 Draft / houseStart / special settings
 * for 배치 다시 맞추기 silent-click 조사.
 * WRITE 금지. migrate 금지. DATABASE_URL 을 production 으로 덮지 않음.
 *
 *   npx tsx scripts/inspect-reflow-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";
import { parseYmd } from "../src/lib/availabilityEngine";

const DATE = process.env.INSPECT_DATE || "2026-08-27";

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
  const { start, end } = parseYmd(DATE);
  try {
    const [draftRows, duties, supports] = await Promise.all([
      prisma.$queryRaw<
        Array<{ version: number; updatedAt: Date; payload: unknown }>
      >`
        SELECT version, "updatedAt", payload
        FROM "DailyBoardDraft"
        WHERE date >= ${start} AND date <= ${end}
        LIMIT 1
      `,
      prisma.$queryRaw<
        Array<{
          kind: string;
          caddyId: number;
          name: string;
          team: string;
          sortOrder: number;
        }>
      >`
        SELECT d.kind::text AS kind, d."caddyId", c.name, c.team, d."sortOrder"
        FROM "DailySpecialDuty" d
        JOIN "Caddy" c ON c.id = d."caddyId"
        WHERE d.date >= ${start} AND d.date <= ${end}
        ORDER BY d.kind, d."sortOrder", d.id
      `,
      prisma.$queryRaw<
        Array<{ shift: string; caddyId: number; name: string }>
      >`
        SELECT s.shift, s."caddyId", c.name
        FROM "DailySpecialSupport" s
        JOIN "Caddy" c ON c.id = s."caddyId"
        WHERE s.date >= ${start} AND s.date <= ${end}
        ORDER BY s.shift, s.id
      `,
    ]);
    const draft = draftRows[0] || null;
    const payload = asRecord(draft?.payload);
    const assignments = Array.isArray(payload.assignments)
      ? payload.assignments
      : [];
    const unassigned = Array.isArray(payload.unassignedReservations)
      ? payload.unassignedReservations
      : [];
    const closed = Array.isArray(payload.closedCourseReservations)
      ? payload.closedCourseReservations
      : [];
    const pool = Array.isArray(payload.caddyPool) ? payload.caddyPool : [];
    const reservations = new Set<string>();
    const shift1: Array<{
      kind: string;
      sequenceIndex: unknown;
      teeTime: string;
      caddyId: number | null;
      caddyName: string;
      caddyType: string;
      team: string;
    }> = [];
    for (const raw of assignments) {
      const row = asRecord(raw);
      const res = asRecord(row.reservation);
      const caddy = asRecord(row.caddy);
      const key = `${res.course || ""}|${res.shift || ""}|${res.teeTime || ""}|${res.teamName || ""}`;
      reservations.add(key);
      if (String(res.shift || row.shift || "") === "1부") {
        shift1.push({
          kind: String(row.kind || ""),
          sequenceIndex: row.sequenceIndex,
          teeTime: String(res.teeTime || ""),
          caddyId: typeof caddy.id === "number" ? caddy.id : Number(caddy.id) || null,
          caddyName: String(caddy.name || ""),
          caddyType: String(caddy.caddyType || ""),
          team: String(caddy.team || ""),
        });
      }
    }
    for (const raw of unassigned) {
      const u = asRecord(raw);
      const res = asRecord(u.reservation);
      reservations.add(
        `${res.course || ""}|${res.shift || ""}|${res.teeTime || ""}|${res.teamName || ""}`
      );
    }
    const firstRegularHouse = shift1.find(
      (r) =>
        r.kind === "regular" &&
        (r.caddyType === "HOUSE" || r.caddyType === "") &&
        !/^9조$|^10조$|^11조$|^12조$/.test(r.team)
    );
    const report = {
      date: DATE,
      draftExists: Boolean(draft),
      draftVersion: draft?.version ?? null,
      draftUpdatedAt: draft?.updatedAt ?? null,
      payloadHasHouseStartCaddyId: Object.prototype.hasOwnProperty.call(
        payload,
        "houseStartCaddyId"
      ),
      payloadHouseStartCaddyId: payload.houseStartCaddyId ?? null,
      reservationCount: reservations.size,
      assignmentCount: assignments.length,
      unassignedCount: unassigned.length,
      closedCount: closed.length,
      caddyPoolCount: pool.length,
      shift1First8: shift1.slice(0, 8),
      inferredHouseStartFromFirstRegular1부: firstRegularHouse
        ? {
            caddyId: firstRegularHouse.caddyId,
            name: firstRegularHouse.caddyName,
            team: firstRegularHouse.team,
            teeTime: firstRegularHouse.teeTime,
          }
        : null,
      dailySpecialDuty: duties,
      dailySpecialSupport: supports,
      note: "houseStartCaddyId is client React state; not stored on DailyBoardDraft payload. Page load leaves it empty until the top select is filled.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
