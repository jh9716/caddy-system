/**
 * 자동배치 exclusion = resolveEffectiveOpsDuty
 * stored / sheet fallback / SET / CLEAR / RESTORE
 * GET rows 계약은 바꾸지 않고 effective caddyIds만 맞춘다.
 *
 * 실행: npm run test:ops-duty-assign-exclusion-unit
 */
import fs from "node:fs";
import path from "node:path";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import type { DailyOpsDutyRole } from "../src/lib/dailyOpsDuty";
import type { StoredOpsDutyRow } from "../src/lib/dailyOpsDutyService";
import {
  applyOpsDutyOverrides,
  effectiveDutyEntriesFromRows,
  effectiveOpsDutyCaddyIds,
  type OpsDutyOverrideInput,
} from "../src/lib/opsDutyEffective";
import { resolveEffectiveOpsDuty } from "../src/lib/opsDutyEffectiveService";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "../src/lib/opsDutyReadOnlySource";
import { buildOpsDutySheetTestSheets } from "../src/lib/opsDutySheetParser";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const DATE = "2026-09-07";
const SHEET_DATE = "2099-11-03";

const SEPT7 = [
  { roleKey: "당번_조출_1", role: "DUTY_AM" as const, id: 156, name: "지선영" },
  { roleKey: "당번_조출_2", role: "DUTY_AM" as const, id: 158, name: "하연화" },
  { roleKey: "당번_후출_1", role: "DUTY_PM" as const, id: 203, name: "이인아" },
  { roleKey: "당번_후출_2", role: "DUTY_PM" as const, id: 15, name: "서승희" },
  { roleKey: "마샬_조출_1", role: "MARSHAL_AM" as const, id: 161, name: "이용근" },
  { roleKey: "마샬_조출_2", role: "MARSHAL_AM" as const, id: 53, name: "김청운" },
  { roleKey: "마샬_후출_1", role: "MARSHAL_PM" as const, id: 99, name: "김성규" },
  { roleKey: "조장_1", role: "LEADER" as const, id: 18, name: "엄진순" },
];

function storedRow(
  roleKey: string,
  role: DailyOpsDutyRole,
  caddyId: number,
  name: string,
  id = caddyId
): StoredOpsDutyRow {
  return {
    id,
    role,
    roleKey,
    caddyId,
    rawName: name,
    name,
    team: "1조",
    employmentStatus: "ACTIVE",
  };
}

function rosterFrom(
  people: Array<{ id: number; name: string }>,
  extra: Array<{ id: number; name: string }> = []
) {
  return [...people, ...extra].map((row) => ({
    id: row.id,
    name: row.name,
    team: "1조",
    teamOrder: row.id,
    employmentStatus: "ACTIVE" as const,
    caddyType: "HOUSE" as const,
  }));
}

function exclusionIds(
  date: string,
  caddies: ReturnType<typeof rosterFrom>,
  entries: { kind: string; roleKey: string; rawName: string }[]
) {
  const availability = computeAvailability({
    date,
    caddies,
    assignments: [],
  });
  const overlaid = applyDailyExternalExclusions({
    availability,
    caddies,
    offNames: [],
    dutyEntries: entries as never,
  });
  return [...overlaid.opsDutyCaddyIds].sort((a, b) => a - b);
}

async function main() {
section("wiring: 한 resolver만 사용");
{
  const avail = readSrc("src/lib/availabilityService.ts");
  const canonical = readSrc("src/lib/caddyPoolCanonicalService.ts");
  const live = readSrc("src/lib/opsDutyLivePool.ts");
  const getRoute = readSrc("src/app/api/daily-ops-duties/route.ts");
  const dashboard = readSrc("src/lib/adminOpsDashboardSource.ts");
  assert(
    /loadEffectiveOpsDutyEntries/.test(avail),
    "preview availability → loadEffectiveOpsDutyEntries"
  );
  assert(
    /resolveEffectiveOpsDuty/.test(canonical),
    "canonical → resolveEffectiveOpsDuty"
  );
  assert(
    /listEffectiveOpsDutyCaddyIds/.test(live),
    "reflow fallback → listEffectiveOpsDutyCaddyIds"
  );
  assert(
    !/loadStoredDutyEntries/.test(avail + canonical),
    "stored-only loader 제거"
  );
  assert(!/resolveEffectiveOpsDuty/.test(getRoute), "GET rows 계약 유지");
  assert(!/resolveEffectiveOpsDuty/.test(dashboard), "Dashboard는 base overlay 유지");
  assert(
    /includeStoredOpsDuty: false/.test(dashboard),
    "Dashboard는 effective default path를 타지 않음"
  );
}

section("9/7 회귀: stored 8 + override 0");
{
  const stored = SEPT7.map((row) =>
    storedRow(row.roleKey, row.role, row.id, row.name)
  );
  const caddies = rosterFrom(SEPT7.map((row) => ({ id: row.id, name: row.name })), [
    { id: 189, name: "박지아" },
  ]);
  const effective = await resolveEffectiveOpsDuty(DATE, {
    listDuties: async () => stored,
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => {
      throw new Error("stored가 있으면 sheet를 읽지 않음");
    },
  });
  const expected = SEPT7.map((row) => row.id).sort((a, b) => a - b);
  assert(effective.storedCount === 8, "storedCount 8");
  assert(effective.overrideCount === 0, "override 0");
  assert(effective.baseSource === "stored", "baseSource stored");
  assert(
    [...effective.caddyIds].sort((a, b) => a - b).join(",") === expected.join(","),
    "effective 8명 = stored 8명"
  );
  const excluded = exclusionIds(DATE, caddies, effective.entries);
  assert(excluded.join(",") === expected.join(","), "자동배치 exclusion = 같은 8명");
  const getBase = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => stored,
    fetchOpsDutySheets: async () => [],
  });
  const getRows = opsDutyPanelRowsFromReadOnly(getBase, caddies);
  const getIds = [...new Set(getRows.map((row) => row.caddyId))].sort((a, b) => a - b);
  assert(getIds.join(",") === expected.join(","), "GET base caddyIds도 8명 (override 0)");
  assert(
    !excluded.includes(189),
    "HOUSE 시작 캐디 박지아는 exclusion 아님"
  );
}

section("sheet-only: stored 0 + sheet names + override 0");
{
  const people = [
    { id: 11, name: "시트당1" },
    { id: 12, name: "시트당2" },
    { id: 13, name: "시트후1" },
    { id: 14, name: "시트후2" },
    { id: 21, name: "시트마1" },
    { id: 22, name: "시트마2" },
    { id: 23, name: "시트마후" },
    { id: 31, name: "시트조장" },
    { id: 99, name: "일반" },
  ];
  const caddies = rosterFrom(people);
  const sheets = buildOpsDutySheetTestSheets([
    {
      name: "1101~1114",
      startDate: SHEET_DATE,
      week1Dates: [
        SHEET_DATE,
        "2099-11-04",
        "2099-11-05",
        "2099-11-06",
        "2099-11-07",
        "2099-11-08",
        "2099-11-09",
      ],
      week2Dates: [
        "2099-11-10",
        "2099-11-11",
        "2099-11-12",
        "2099-11-13",
        "2099-11-14",
        "2099-11-15",
        "2099-11-16",
      ],
      week1Names: [
        {
          당번_조출_1: "시트당1",
          당번_조출_2: "시트당2",
          당번_후출_1: "시트후1",
          당번_후출_2: "시트후2",
          마샬_조출_1: "시트마1",
          마샬_조출_2: "시트마2",
          마샬_후출_1: "시트마후",
          조장_1: "시트조장",
        },
      ],
    },
  ]);
  const effective = await resolveEffectiveOpsDuty(SHEET_DATE, {
    listDuties: async () => [],
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => sheets,
  });
  assert(effective.baseSource === "sheet", "stored 0 → sheet fallback");
  assert(effective.storedCount === 0, "storedCount 0");
  const expected = [11, 12, 13, 14, 21, 22, 23, 31].sort((a, b) => a - b);
  assert(
    [...effective.caddyIds].sort((a, b) => a - b).join(",") === expected.join(","),
    "GET effective caddyIds = sheet 8명"
  );
  const excluded = exclusionIds(SHEET_DATE, caddies, effective.entries);
  assert(
    excluded.join(",") === expected.join(","),
    "자동배치 exclusion = GET effective"
  );
  assert(!excluded.includes(99), "시트에 없는 일반 캐디는 제외하지 않음");
}

section("SET / CLEAR / RESTORE exclusion");
{
  const a = { id: 11, name: "원본A" };
  const b = { id: 99, name: "현장B" };
  const other = { id: 12, name: "조출2" };
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", a.id, a.name),
    storedRow("당번_조출_2", "DUTY_AM", other.id, other.name),
  ];
  const caddies = rosterFrom([a, b, other, { id: 77, name: "일반" }]);
  const depsBase = {
    listDuties: async () => stored,
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => [],
  };

  const before = await resolveEffectiveOpsDuty(DATE, {
    ...depsBase,
    listOverrides: async () => [],
  });
  assert(
    exclusionIds(DATE, caddies, before.entries).join(",") === "11,12",
    "A. base는 A+조출2 exclusion"
  );

  const afterSet = await resolveEffectiveOpsDuty(DATE, {
    ...depsBase,
    listOverrides: async () => [
      {
        id: 1,
        roleKey: "당번_조출_1",
        role: "DUTY_AM",
        action: "SET",
        caddyId: b.id,
        name: b.name,
        rawName: b.name,
        team: "2조",
      },
    ],
  });
  const setIds = exclusionIds(DATE, caddies, afterSet.entries);
  assert(setIds.includes(99) && !setIds.includes(11), "A. SET B → A 대신 B exclusion");
  assert(setIds.includes(12), "D. 다른 roleKey(조출2) 유지");

  const afterClear = await resolveEffectiveOpsDuty(DATE, {
    ...depsBase,
    listOverrides: async () => [
      {
        id: 1,
        roleKey: "당번_조출_1",
        role: "DUTY_AM",
        action: "CLEAR",
        caddyId: null,
        name: null,
        rawName: null,
        team: null,
      },
    ],
  });
  const clearIds = exclusionIds(DATE, caddies, afterClear.entries);
  assert(!clearIds.includes(11) && !clearIds.includes(99), "B. CLEAR → 해당 roleKey 제외 없음");
  assert(clearIds.join(",") === "12", "D. CLEAR는 조출2만 남김");

  const afterRestore = await resolveEffectiveOpsDuty(DATE, {
    ...depsBase,
    listOverrides: async () => [],
  });
  assert(
    exclusionIds(DATE, caddies, afterRestore.entries).join(",") === "11,12",
    "C. RESTORE → 원본 A 복귀"
  );

  const pure = applyOpsDutyOverrides(
    opsDutyPanelRowsFromReadOnly(
      {
        source: "stored",
        stored,
        sheetEntries: [],
        error: null,
      },
      caddies
    ),
    [
      {
        roleKey: "당번_조출_1",
        role: "DUTY_AM",
        action: "SET",
        caddyId: 99,
        name: "현장B",
      } satisfies OpsDutyOverrideInput,
    ]
  );
  assert(
    effectiveOpsDutyCaddyIds(pure).includes(99) &&
      !effectiveOpsDutyCaddyIds(pure).includes(11),
    "순수 applyOpsDutyOverrides SET도 동일"
  );
  assert(
    effectiveDutyEntriesFromRows(pure).some((row) => row.rawName === "현장B"),
    "effective entries가 overlay에 쓰일 이름"
  );
}

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
