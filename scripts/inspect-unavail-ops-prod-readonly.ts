/**
 * Production READ ONLY: 2026-08-28 비가용/당번 source 추적.
 * WRITE 금지. migrate 금지. DATABASE_URL 을 production 으로 덮지 않음.
 *
 *   INSPECT_DATE=2026-08-28 npx tsx scripts/inspect-unavail-ops-prod-readonly.ts
 */
import { PrismaClient } from "@prisma/client";
import { parseYmd } from "../src/lib/availabilityEngine";
import { fetchPublishedOpsDutySheets } from "../src/lib/opsDutySheetFetch";
import {
  parseOpsDutySheetsForDate,
  scanOpsDutySheetDates,
} from "../src/lib/opsDutySheetParser";

const DATE = process.env.INSPECT_DATE || "2026-08-28";

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
  const { start, end } = parseYmd(DATE);
  try {
    const [opsDuty, unavail, sickAssign, draftRows, snapshots] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          id: number;
          role: string;
          roleKey: string;
          caddyId: number;
          rawName: string;
          name: string;
        }>
      >`
        SELECT d.id, d.role::text AS role, d."roleKey", d."caddyId", d."rawName", c.name
        FROM "DailyOpsDuty" d
        JOIN "Caddy" c ON c.id = d."caddyId"
        WHERE d.date >= ${start} AND d.date <= ${end}
        ORDER BY d."roleKey"
      `,
      prisma.$queryRaw<
        Array<{ caddyId: number; name: string; reason: string }>
      >`
        SELECT u."caddyId", c.name, u.reason::text AS reason
        FROM "DailyCaddyUnavailable" u
        JOIN "Caddy" c ON c.id = u."caddyId"
        WHERE u.date >= ${start} AND u.date <= ${end}
        ORDER BY u.reason, c.name
      `,
      prisma.$queryRaw<
        Array<{ caddyId: number; name: string; type: string }>
      >`
        SELECT a."caddyId", c.name, a.type::text AS type
        FROM "Assignment" a
        JOIN "Caddy" c ON c.id = a."caddyId"
        WHERE a."startDate" <= ${end}
          AND a."endDate" >= ${start}
          AND a.type::text IN ('SICK', 'LONG_SICK', 'OFF', 'DUTY', 'MARSHAL')
        ORDER BY a.type, c.name
      `,
      prisma.$queryRaw<
        Array<{ version: number; payload: unknown }>
      >`
        SELECT version, payload
        FROM "DailyBoardDraft"
        WHERE date >= ${start} AND date <= ${end}
        LIMIT 1
      `,
      prisma.$queryRaw<
        Array<{ capturedAt: Date; payload: unknown }>
      >`
        SELECT "capturedAt", payload
        FROM "DailyOpsSnapshot"
        WHERE date >= ${start} AND date <= ${end}
        LIMIT 1
      `,
    ]);

    const payload =
      draftRows[0]?.payload && typeof draftRows[0].payload === "object"
        ? (draftRows[0].payload as Record<string, unknown>)
        : {};
    const offSnapshot = payload.offSnapshot as
      | { caddyIds?: number[] }
      | undefined;
    const unavailableCaddyIds = Array.isArray(payload.unavailableCaddyIds)
      ? payload.unavailableCaddyIds
      : [];

    const assignByType: Record<string, number> = {};
    for (const row of sickAssign) {
      assignByType[row.type] = (assignByType[row.type] || 0) + 1;
    }
    const unavailByReason: Record<string, number> = {};
    for (const row of unavail) {
      unavailByReason[row.reason] = (unavailByReason[row.reason] || 0) + 1;
    }

    let sheet: {
      ok: boolean;
      error?: string;
      sheetName?: string;
      tabNames?: string[];
      operationalDates?: string[];
      entries?: Array<{ kind: string; roleKey: string; rawName: string }>;
    } = { ok: false };
    try {
      const sheets = await fetchPublishedOpsDutySheets({ timeoutMs: 20_000 });
      const scanned = scanOpsDutySheetDates(sheets, DATE);
      const dates = [...new Set(scanned.operational.map((d) => d.ymd))].sort();
      try {
        const parsed = parseOpsDutySheetsForDate(sheets, DATE);
        sheet = {
          ok: true,
          sheetName: parsed.sheetName,
          tabNames: sheets.map((s) => s.name),
          operationalDates: dates,
          entries: parsed.entries.map((e) => ({
            kind: e.kind,
            roleKey: e.roleKey,
            rawName: e.rawName,
          })),
        };
      } catch (error) {
        sheet = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          tabNames: sheets.map((s) => s.name),
          operationalDates: dates,
        };
      }
    } catch (error) {
      sheet = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const snapPayload =
      snapshots[0]?.payload && typeof snapshots[0].payload === "object"
        ? (snapshots[0].payload as Record<string, unknown>)
        : null;

    const summary = {
      date: DATE,
      dailyOpsDuty: {
        count: opsDuty.length,
        rows: opsDuty,
        byRole: opsDuty.reduce<Record<string, number>>((acc, row) => {
          acc[row.role] = (acc[row.role] || 0) + 1;
          return acc;
        }, {}),
      },
      dailyCaddyUnavailable: {
        count: unavail.length,
        byReason: unavailByReason,
        rows: unavail,
      },
      assignmentsOverlapping: {
        count: sickAssign.length,
        byType: assignByType,
        sickNames: sickAssign
          .filter((r) => r.type === "SICK" || r.type === "LONG_SICK")
          .map((r) => ({ id: r.caddyId, name: r.name, type: r.type })),
        dutyNames: sickAssign
          .filter((r) => r.type === "DUTY" || r.type === "MARSHAL")
          .map((r) => ({ id: r.caddyId, name: r.name, type: r.type })),
      },
      draft: {
        version: draftRows[0]?.version ?? null,
        offSnapshotCount: Array.isArray(offSnapshot?.caddyIds)
          ? offSnapshot.caddyIds.length
          : 0,
        unavailableCaddyIdsCount: unavailableCaddyIds.length,
      },
      snapshot: snapPayload
        ? {
            capturedAt: snapshots[0]?.capturedAt ?? null,
            opsDuties: snapPayload.opsDuties ?? null,
            availability: snapPayload.availability ?? null,
          }
        : null,
      sheet,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
