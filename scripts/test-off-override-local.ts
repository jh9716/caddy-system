/**
 * LOCAL POSTGRESQL ONLY — 현장 휴무 overlay A–G + 병가/결근
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *   npm run test:off-override-local
 */
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { parseYmd } from "../src/lib/availabilityEngine";
import { loadAvailabilityForDate } from "../src/lib/availabilityService";
import { writeDailyOffOverride } from "../src/lib/offEffectiveService";
import { writeDailyUnavailable } from "../src/lib/dailyUnavailableWrite";
import { buildOffSnapshot } from "../src/lib/offSnapshot";
import type { OffSheet } from "../src/lib/offSheetParser";

const DATE = "2099-12-27";
const TAG = "__OFFOV__";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function houseIds(overlaid: {
  available: { all: Array<{ id: number; caddyType?: string | null }> };
}) {
  return overlaid.available.all
    .filter((row) => String(row.caddyType || "HOUSE") === "HOUSE")
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

function offIds(overlaid: {
  excluded: Array<{ id: number; excludedReasons: string[] }>;
}) {
  return overlaid.excluded
    .filter((row) => row.excludedReasons.includes("휴무"))
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const { start } = parseYmd(DATE);
  const createdIds: number[] = [];

  try {
    const a = await prisma.caddy.create({
      data: {
        name: `${TAG}A`,
        team: "1조",
        teamOrder: 91,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const b = await prisma.caddy.create({
      data: {
        name: `${TAG}B`,
        team: "1조",
        teamOrder: 92,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const duty = await prisma.caddy.create({
      data: {
        name: `${TAG}DUTY`,
        team: "2조",
        teamOrder: 91,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(a.id, b.id, duty.id);

    const offSheets: OffSheet[] = [
      {
        name: "2099-off",
        matrix: [
          ["2099.12.27 (토)", "", ""],
          ["1조", "2조", "3조"],
          [b.name, "", ""],
        ],
      },
    ];
    const dutyEntries = [
      { kind: "duty_am" as const, roleKey: "당번_조출_1", rawName: duty.name },
    ];

    async function load() {
      return loadAvailabilityForDate(DATE, {
        offSheets,
        dutyEntries,
        includeStoredOpsDuty: false,
        includeOffSheet: true,
      });
    }

    const base = await load();
    assert(offIds(base).includes(b.id), "B는 원본 시트 휴무");
    assert(!offIds(base).includes(a.id), "A는 원본 출근");
    assert(houseIds(base).includes(a.id), "A는 HOUSE 가용");
    assert(!houseIds(base).includes(duty.id), "당번은 HOUSE 제외");
    const snap = buildOffSnapshot({
      date: DATE,
      caddyIds: base.offOverlay?.baseOffCaddyIds || [],
    });
    assert(snap.caddyIds.includes(b.id) && !snap.caddyIds.includes(a.id), "snapshot은 시트 원본");

    await writeDailyOffOverride({
      date: DATE,
      action: "FORCE_OFF",
      caddyId: a.id,
    });
    const afterOff = await load();
    assert(offIds(afterOff).includes(a.id), "A FORCE_OFF → 휴무");
    assert(!houseIds(afterOff).includes(a.id), "A는 자동배치 HOUSE 제외");
    assert(
      JSON.stringify(snap.caddyIds) ===
        JSON.stringify(afterOff.offOverlay?.baseOffCaddyIds || []),
      "FORCE_OFF 해도 snapshot base 유지"
    );

    await writeDailyOffOverride({
      date: DATE,
      action: "FORCE_AVAILABLE",
      caddyId: b.id,
    });
    const afterAvail = await load();
    assert(!offIds(afterAvail).includes(b.id), "B FORCE_AVAILABLE → 휴무 목록 제거");
    assert(houseIds(afterAvail).includes(b.id), "B는 HOUSE 가용 복귀");

    await writeDailyUnavailable({
      date: DATE,
      action: "SET",
      reason: "SICK",
      caddyId: b.id,
    });
    const afterSick = await load();
    assert(!houseIds(afterSick).includes(b.id), "B 병가면 FORCE_AVAILABLE 해도 가용 아님");
    assert(
      afterSick.excluded.some(
        (row) => row.id === b.id && row.excludedReasons.includes("병가")
      ),
      "B는 병가 제외"
    );

    await writeDailyUnavailable({
      date: DATE,
      action: "CLEAR",
      reason: "SICK",
      caddyId: b.id,
    });
    await writeDailyOffOverride({
      date: DATE,
      action: "RESTORE",
      caddyId: b.id,
    });
    await writeDailyOffOverride({
      date: DATE,
      action: "RESTORE",
      caddyId: a.id,
    });
    const restored = await load();
    assert(offIds(restored).includes(b.id) && !offIds(restored).includes(a.id), "RESTORE → 시트 원본");
    assert(houseIds(restored).includes(a.id) && !houseIds(restored).includes(b.id), "A 가용 / B 휴무");

    await writeDailyUnavailable({
      date: DATE,
      action: "SET",
      reason: "SICK",
      caddyId: a.id,
    });
    const sickA = await load();
    assert(!houseIds(sickA).includes(a.id), "병가 추가 → 제외");
    await writeDailyUnavailable({
      date: DATE,
      action: "CLEAR",
      reason: "SICK",
      caddyId: a.id,
    });
    const sickCleared = await load();
    assert(houseIds(sickCleared).includes(a.id), "병가 해제 → 가용");

    await writeDailyUnavailable({
      date: DATE,
      action: "SET",
      reason: "ATTENDANCE_NOSHOW",
      caddyId: a.id,
    });
    const noshowA = await load();
    assert(!houseIds(noshowA).includes(a.id), "결근 추가 → 제외");
    await writeDailyUnavailable({
      date: DATE,
      action: "CLEAR",
      reason: "ATTENDANCE_NOSHOW",
      caddyId: a.id,
    });
    const noshowCleared = await load();
    assert(houseIds(noshowCleared).includes(a.id), "결근 해제 → 가용");

    await writeDailyOffOverride({
      date: DATE,
      action: "FORCE_AVAILABLE",
      caddyId: duty.id,
    });
    const dutyStill = await load();
    assert(!houseIds(dutyStill).includes(duty.id), "휴무 overlay가 당번 exclusion을 제거하지 않음");
    const audits = await prisma.audit.findMany({
      where: {
        action: { startsWith: "DAILY_OFF_OVERRIDE_" },
        payload: { path: ["date"], equals: DATE },
      },
    });
    assert(audits.length >= 3, "휴무 overlay audit 기록");
  } finally {
    await prisma.dailyOffOverride.deleteMany({ where: { date: start } });
    await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: start } });
    await prisma.audit.deleteMany({
      where: {
        OR: [
          { action: { startsWith: "DAILY_OFF_OVERRIDE_" }, payload: { path: ["date"], equals: DATE } },
          { action: { startsWith: "DAILY_UNAVAILABLE_" }, payload: { path: ["date"], equals: DATE } },
        ],
      },
    });
    if (createdIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.$disconnect();
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
