/**
 * Production READ ONLY: Draft / houseStart / spares / 병가 snapshot.
 * WRITE 금지. migrate 금지. DATABASE_URL 을 production 으로 덮지 않음.
 *
 *   INSPECT_DATE=2026-08-28 npx tsx scripts/inspect-sick-spare-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";
import { parseYmd } from "../src/lib/availabilityEngine";

const DATE = process.env.INSPECT_DATE || "2026-08-28";
const VICTIM_NAME = process.env.INSPECT_CADDY_NAME || "최루비";

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

function houseFp(
  assignments: unknown[],
  shift: string
): Array<{ id: number; name: string; team: string; teamOrder: number }> {
  const rows: Array<{
    id: number;
    name: string;
    team: string;
    teamOrder: number;
    sequenceIndex: number;
  }> = [];
  for (const raw of assignments) {
    const row = asRecord(raw);
    const res = asRecord(row.reservation);
    const caddy = asRecord(row.caddy);
    const sh = String(res.shift || row.shift || "");
    if (sh !== shift || String(row.kind || "") !== "regular") continue;
    if (String(caddy.caddyType || "HOUSE") !== "HOUSE") continue;
    rows.push({
      id: Number(caddy.id) || 0,
      name: String(caddy.name || ""),
      team: String(caddy.team || ""),
      teamOrder: Number(caddy.teamOrder) || 0,
      sequenceIndex: Number(row.sequenceIndex) || 0,
    });
  }
  rows.sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  return rows.map(({ sequenceIndex: _s, ...rest }) => rest);
}

function spareFp(spares: unknown[], shift: string) {
  const row = (spares || [])
    .map(asRecord)
    .find((s) => String(s.shift || "") === shift);
  const s1 = asRecord(row?.spare1);
  const s2 = asRecord(row?.spare2);
  return {
    spare1: s1.caddyId
      ? { id: Number(s1.caddyId), name: String(s1.name || "") }
      : null,
    spare2: s2.caddyId
      ? { id: Number(s2.caddyId), name: String(s2.name || "") }
      : null,
  };
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
    const [draftRows, victimRows, liveSick] = await Promise.all([
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
          id: number;
          name: string;
          team: string;
          teamOrder: number;
          caddyType: string;
        }>
      >`
        SELECT id, name, team, "teamOrder", "caddyType"::text AS "caddyType"
        FROM "Caddy"
        WHERE name = ${VICTIM_NAME}
        LIMIT 5
      `,
      prisma.$queryRaw<
        Array<{ caddyId: number; name: string; reason: string }>
      >`
        SELECT u."caddyId", c.name, u.reason::text AS reason
        FROM "DailyCaddyUnavailable" u
        JOIN "Caddy" c ON c.id = u."caddyId"
        WHERE u.date >= ${start} AND u.date <= ${end}
        ORDER BY u.id
      `,
    ]);
    const draft = draftRows[0] || null;
    const payload = asRecord(draft?.payload);
    const assignments = Array.isArray(payload.assignments)
      ? payload.assignments
      : [];
    const pool = Array.isArray(payload.caddyPool) ? payload.caddyPool : [];
    const spares = Array.isArray(payload.sparesByShift)
      ? payload.sparesByShift
      : [];
    const victim = victimRows[0] || null;
    const victimOnBoard = victim
      ? houseFp(assignments, "1부").find((c) => c.id === victim.id) ||
        houseFp(assignments, "2부").find((c) => c.id === victim.id) ||
        null
      : null;
    const summary = {
      date: DATE,
      draftVersion: draft?.version ?? null,
      updatedAt: draft?.updatedAt ?? null,
      houseStartCaddyId: payload.houseStartCaddyId ?? null,
      thirdStartCaddyId: payload.thirdStartCaddyId ?? null,
      unavailableCaddyIds: payload.unavailableCaddyIds ?? [],
      caddyPoolCount: pool.length,
      caddyPoolHead: pool.slice(0, 5).map((raw) => {
        const c = asRecord(raw);
        return { id: Number(c.id) || 0, name: String(c.name || "") };
      }),
      victim,
      victimHouseIndex1: victimOnBoard
        ? houseFp(assignments, "1부").findIndex((c) => c.id === victim.id)
        : null,
      liveSick: liveSick.map((row) => ({
        id: row.caddyId,
        name: row.name,
        reason: row.reason,
      })),
      spares: {
        "1부": spareFp(spares, "1부"),
        "2부": spareFp(spares, "2부"),
        "3부": spareFp(spares, "3부"),
      },
      house: {
        "1부": {
          n: houseFp(assignments, "1부").length,
          first3: houseFp(assignments, "1부").slice(0, 3),
          last3: houseFp(assignments, "1부").slice(-3),
        },
        "2부": {
          n: houseFp(assignments, "2부").length,
          first3: houseFp(assignments, "2부").slice(0, 3),
          last3: houseFp(assignments, "2부").slice(-3),
        },
        "3부": {
          n: houseFp(assignments, "3부").length,
          first3: houseFp(assignments, "3부").slice(0, 3),
          last3: houseFp(assignments, "3부").slice(-3),
        },
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
