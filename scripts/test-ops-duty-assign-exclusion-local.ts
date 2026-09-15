/**
 * LOCAL POSTGRESQL ONLY — effective ops duty → availability exclusion
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *   npm run test:ops-duty-assign-exclusion-local
 */
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { parseYmd } from "../src/lib/availabilityEngine";
import { loadAvailabilityForDate } from "../src/lib/availabilityService";
import { resolveEffectiveOpsDuty, writeDailyOpsDutyOverride } from "../src/lib/opsDutyEffectiveService";
import { buildOpsDutySheetTestSheets } from "../src/lib/opsDutySheetParser";

const DATE = "2099-12-26";
const SHEET_DATE = "2099-11-02";
const TAG = "__OVEXCL__";
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

function idsOf(overlaid: { opsDutyCaddyIds?: number[]; excluded: Array<{ id: number; excludedReasons: string[] }> }) {
  const fromField = [...(overlaid.opsDutyCaddyIds || [])].sort((a, b) => a - b);
  if (fromField.length) return fromField;
  return overlaid.excluded
    .filter((row) =>
      row.excludedReasons.some((reason) => /당번|마샬|조장/.test(reason))
    )
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const { start } = parseYmd(DATE);
  const { start: sheetStart } = parseYmd(SHEET_DATE);
  const createdIds: number[] = [];

  try {
    const a = await prisma.caddy.create({
      data: {
        name: `${TAG}A`,
        team: "1조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const b = await prisma.caddy.create({
      data: {
        name: `${TAG}B`,
        team: "2조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const other = await prisma.caddy.create({
      data: {
        name: `${TAG}OTHER`,
        team: "1조",
        teamOrder: 2,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(a.id, b.id, other.id);

    await prisma.dailyOpsDuty.createMany({
      data: [
        {
          date: start,
          role: "DUTY_AM",
          roleKey: "당번_조출_1",
          caddyId: a.id,
          rawName: a.name,
        },
        {
          date: start,
          role: "DUTY_AM",
          roleKey: "당번_조출_2",
          caddyId: other.id,
          rawName: other.name,
        },
      ],
    });

    const avail0 = await loadAvailabilityForDate(DATE, { includeOffSheet: false });
    const effective0 = await resolveEffectiveOpsDuty(DATE);
    assert(
      idsOf(avail0).join(",") === [...effective0.caddyIds].sort((a, b) => a - b).join(","),
      "local stored: GET effective == availability exclusion"
    );
    assert(idsOf(avail0).includes(a.id) && idsOf(avail0).includes(other.id), "A+OTHER exclusion");

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "SET",
      caddyId: b.id,
      username: "local-excl",
      userId: 0,
    });
    const availSet = await loadAvailabilityForDate(DATE, { includeOffSheet: false });
    const effectiveSet = await resolveEffectiveOpsDuty(DATE);
    assert(
      idsOf(availSet).join(",") ===
        [...effectiveSet.caddyIds].sort((a, b) => a - b).join(","),
      "SET 후 GET effective == exclusion"
    );
    assert(idsOf(availSet).includes(b.id) && !idsOf(availSet).includes(a.id), "SET B가 A를 대체");
    assert(idsOf(availSet).includes(other.id), "다른 roleKey 유지");

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "CLEAR",
      username: "local-excl",
      userId: 0,
    });
    const availClear = await loadAvailabilityForDate(DATE, { includeOffSheet: false });
    assert(!idsOf(availClear).includes(a.id) && !idsOf(availClear).includes(b.id), "CLEAR 후 해당 슬롯 제외 없음");
    assert(idsOf(availClear).join(",") === String(other.id), "CLEAR는 OTHER만 남김");

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "RESTORE",
      username: "local-excl",
      userId: 0,
    });
    const availRestore = await loadAvailabilityForDate(DATE, { includeOffSheet: false });
    assert(
      idsOf(availRestore).includes(a.id) && !idsOf(availRestore).includes(b.id),
      "RESTORE → 원본 A"
    );

    const sheetA = await prisma.caddy.create({
      data: {
        name: `${TAG}SHEET`,
        team: "3조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(sheetA.id);
    const sheets = buildOpsDutySheetTestSheets([
      {
        name: "1101~1114",
        startDate: SHEET_DATE,
        week1Dates: [
          SHEET_DATE,
          "2099-11-03",
          "2099-11-04",
          "2099-11-05",
          "2099-11-06",
          "2099-11-07",
          "2099-11-08",
        ],
        week2Dates: [
          "2099-11-09",
          "2099-11-10",
          "2099-11-11",
          "2099-11-12",
          "2099-11-13",
          "2099-11-14",
          "2099-11-15",
        ],
        week1Names: [{ 당번_조출_1: sheetA.name }],
      },
    ]);
    const sheetCount = await prisma.dailyOpsDuty.count({ where: { date: sheetStart } });
    assert(sheetCount === 0, "sheet-only 날짜 stored 0");
    const sheetAvail = await loadAvailabilityForDate(SHEET_DATE, {
      includeOffSheet: false,
      opsDutyDeps: {
        listDuties: async () => [],
        listOverrides: async () => [],
        fetchOpsDutySheets: async () => sheets,
      },
    });
    const sheetEffective = await resolveEffectiveOpsDuty(SHEET_DATE, {
      listDuties: async () => [],
      listOverrides: async () => [],
      fetchOpsDutySheets: async () => sheets,
    });
    assert(sheetEffective.baseSource === "sheet", "sheet fallback source");
    assert(
      idsOf(sheetAvail).join(",") ===
        [...sheetEffective.caddyIds].sort((a, b) => a - b).join(","),
      "sheet-only GET effective == exclusion"
    );
    assert(idsOf(sheetAvail).includes(sheetA.id), "sheet 이름이 exclusion에 들어감");
  } finally {
    await prisma.dailyOpsDutyOverride.deleteMany({
      where: { date: { in: [start, sheetStart] } },
    });
    await prisma.dailyOpsDuty.deleteMany({
      where: { date: { in: [start, sheetStart] } },
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
