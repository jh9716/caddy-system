/**
 * Marshal PR3 — FINALIZED monthly marshal → Daily Ops read path
 * DailyOpsDuty materialize / rotation regenerate / Sheet write 없음.
 *
 * 실행: npm run test:marshal-pr3-duty-unit
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import type { DailyOpsDutyRole } from "../src/lib/dailyOpsDuty";
import type { StoredOpsDutyRow } from "../src/lib/dailyOpsDutyService";
import {
  applyOpsDutyOverrides,
  type OpsDutyOverrideInput,
} from "../src/lib/opsDutyEffective";
import { resolveEffectiveOpsDuty } from "../src/lib/opsDutyEffectiveService";
import { loadAdminOpsDashboardSource } from "../src/lib/adminOpsDashboardSource";
import { loadAdminOpsDashboardDbFirst } from "../src/lib/adminOpsDashboardFastPath";
import {
  mergedDutyExcelEntriesFromReadOnly,
  opsDutyPanelRowsFromReadOnly,
  opsDutyReadCompleteForSnapshot,
  resolveOpsDutyReadOnly,
} from "../src/lib/opsDutyReadOnlySource";
import { filledMarshalSlots } from "../src/lib/opsStatusPanelView";
import { sortMarshalSlotLabels } from "../src/lib/unavailablePanelView";
import { buildOpsDutySheetTestSheets } from "../src/lib/opsDutySheetParser";
import { OPS_DUTY_ROLE_KEYS } from "../src/lib/opsDutyRoleKeys";
import { isOpsDutyRoleKey } from "../src/lib/opsDutyRoleKeys";
import {
  isMonthlyExtraMarshalRoleKey,
  mapFinalizedMarshalSlots,
  marshalMonthSlotToRoleKey,
  marshalNonOperationalKeys,
  overlayMonthlyMarshalDutyEntries,
  type MonthlyMarshalDutyRow,
} from "../src/lib/marshalMonthDutySource";
import { groupOpsDutyNames } from "../src/lib/adminOpsDashboard";
import { opsDutyRoleFromKind } from "../src/lib/dailyOpsDuty";

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

const DATE = "2099-03-07";
const SHEET_DATE = "2099-03-08";

function storedRow(
  roleKey: string,
  role: DailyOpsDutyRole,
  caddyId: number,
  name: string
): StoredOpsDutyRow {
  return {
    id: caddyId,
    role,
    roleKey,
    caddyId,
    rawName: name,
    name,
    team: "1조",
    employmentStatus: "ACTIVE",
  };
}

function rosterFrom(people: Array<{ id: number; name: string }>) {
  return people.map((row) => ({
    id: row.id,
    name: row.name,
    team: "1조",
    teamOrder: row.id,
    employmentStatus: "ACTIVE" as const,
    caddyType: "HOUSE" as const,
  }));
}

function monthlyRow(
  roleKey: MonthlyMarshalDutyRow["roleKey"],
  caddyId: number,
  name: string,
  slotSource = "ROTATION"
): MonthlyMarshalDutyRow {
  return {
    roleKey,
    role: /후출/.test(roleKey) ? "MARSHAL_PM" : "MARSHAL_AM",
    caddyId,
    name,
    team: "1조",
    rawName: name,
    employmentStatus: "ACTIVE",
    slotSource,
  };
}

const SEPT7_STYLE = [
  { roleKey: "당번_조출_1", role: "DUTY_AM" as const, id: 156, name: "지선영" },
  { roleKey: "당번_조출_2", role: "DUTY_AM" as const, id: 158, name: "하연화" },
  { roleKey: "당번_후출_1", role: "DUTY_PM" as const, id: 203, name: "이인아" },
  { roleKey: "당번_후출_2", role: "DUTY_PM" as const, id: 15, name: "서승희" },
  { roleKey: "마샬_조출_1", role: "MARSHAL_AM" as const, id: 161, name: "이용근" },
  { roleKey: "마샬_조출_2", role: "MARSHAL_AM" as const, id: 53, name: "김청운" },
  { roleKey: "마샬_후출_1", role: "MARSHAL_PM" as const, id: 99, name: "김성규" },
  { roleKey: "조장_1", role: "LEADER" as const, id: 18, name: "엄진순" },
];

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
section("source contracts");
{
  const source = readSrc("src/lib/marshalMonthDutySource.ts");
  const readOnly = readSrc("src/lib/opsDutyReadOnlySource.ts");
  const dashboard = readSrc("src/lib/adminOpsDashboardSource.ts");
  const getRoute = readSrc("src/app/api/daily-ops-duties/route.ts");
  const rotation = readSrc("src/lib/marshalRotationService.ts");
  const engine = readSrc("src/lib/autoAssignEngine.ts");
  const support = readSrc("src/lib/dailySpecialSupport.ts");
  assert(!/replaceDailyOpsDuties/.test(source + readOnly), "no DailyOpsDuty replace");
  assert(
    !/\bdailyOpsDuty\.(create|update|upsert|createMany|deleteMany)/.test(source + readOnly),
    "no DailyOpsDuty write API"
  );
  assert(!/generateMonthRotation/.test(source), "does not rerun P2 rotation");
  assert(!/from ["']@\/lib\/autoAssignEngine["']/.test(source), "no engine import");
  assert(!/from ["']@\/lib\/marshalRotationService["']/.test(source), "no rotation service import");
  assert(/listFinalizedMarshalMonthDutyRows/.test(readOnly), "read-only loads FINALIZED slots");
  assert(!/monthly marshal skipped/.test(readOnly), "no silent monthly error swallow");
  assert(/mergedDutyExcelEntriesFromReadOnly/.test(dashboard), "dashboard uses merged marshal entries");
  assert(/marshalSource/.test(getRoute), "GET exposes marshalSource");
  assert(!/resolveEffectiveOpsDuty/.test(getRoute), "GET rows stay read-only resolver");
  assert(rotation.includes("DailyOpsDuty / Assignment.MARSHAL / Cart 에 write 하지 않는다"), "P2 write contract intact");
  assert(engine.includes("computeAutoAssignmentsV1"), "autoAssignEngine untouched");
  assert(support.includes("MARSHAL_SUPPORT"), "special support untouched");
  assert(
    OPS_DUTY_ROLE_KEYS.length === 8 && !OPS_DUTY_ROLE_KEYS.includes("마샬_후출_2" as never),
    "8-key editor/sheet contract 유지"
  );
  const names = String(
    spawnSync(
      "git",
      [
        "diff",
        "--name-only",
        "origin/main",
        "--",
        "src/lib/autoAssignEngine.ts",
        "src/lib/dailySpecialSupport.ts",
        "src/lib/marshalRotationService.ts",
        "src/app/manage/marshals/schedule/page.tsx",
        "prisma/schema.prisma",
      ],
      { encoding: "utf8" }
    ).stdout || ""
  ).trim();
  assert(names === "", `protected files 0 (${names || "clean"})`);
}

section("roleKey mapping");
{
  assert(marshalMonthSlotToRoleKey("AM", 0) === "마샬_조출_1", "AM 0");
  assert(marshalMonthSlotToRoleKey("조출", 1) === "마샬_조출_2", "AM 1");
  assert(marshalMonthSlotToRoleKey("PM", 0) === "마샬_후출_1", "PM 0");
  assert(marshalMonthSlotToRoleKey("PM", 1) === "마샬_후출_2", "PM1 → monthly extra key");
  assert(marshalMonthSlotToRoleKey("AM", 2) === "마샬_조출_3", "AM2 → monthly extra key");
  assert(!isOpsDutyRoleKey("마샬_후출_2"), "extra key is not in 8-key editor/sheet");
  assert(isMonthlyExtraMarshalRoleKey("마샬_후출_2"), "PM2 is monthly-only extra");
  const draft = mapFinalizedMarshalSlots({
    planStatus: "DRAFT",
    slots: [{ shift: "AM", slotIndex: 0, caddyId: 1, name: "월표A" }],
  });
  assert(draft.source === "none" && draft.rows.length === 0, "DRAFT → no source");
  const none = mapFinalizedMarshalSlots({
    planStatus: "FINALIZED",
    slots: [],
  });
  assert(none.source === "none" && none.planStatus === "FINALIZED", "FINALIZED empty day → no marshal overlay");
  const mapped = mapFinalizedMarshalSlots({
    planId: 9,
    planStatus: "FINALIZED",
    slots: [
      { shift: "AM", slotIndex: 0, caddyId: 1, name: "조출1", source: "MANUAL" },
      { shift: "PM", slotIndex: 0, caddyId: 2, name: "후출1", source: "SUBSTITUTE" },
      { shift: "PM", slotIndex: 1, caddyId: 3, name: "후출2", source: "PENALTY" },
    ],
  });
  assert(mapped.source === "monthly" && mapped.rows.length === 3, "mapped AM0 + PM0 + PM1");
  assert(
    mapped.rows.some((row) => row.slotSource === "SUBSTITUTE" && row.roleKey === "마샬_후출_1"),
    "P2 slot source kept as stored"
  );
  assert(
    mapped.rows.some((row) => row.roleKey === "마샬_후출_2" && row.slotSource === "PENALTY"),
    "PM2 penalty slot kept"
  );
}

section("FINALIZED monthly beats stored marshal; duty/leader unchanged");
{
  const stored = SEPT7_STYLE.map((row) =>
    storedRow(row.roleKey, row.role, row.id, row.name)
  );
  const monthly = [
    monthlyRow("마샬_조출_1", 501, "월조출1", "MANUAL"),
    monthlyRow("마샬_조출_2", 502, "월조출2", "SUBSTITUTE"),
    monthlyRow("마샬_후출_1", 503, "월후출1", "PENALTY"),
  ];
  const caddies = rosterFrom([
    ...SEPT7_STYLE.map((row) => ({ id: row.id, name: row.name })),
    { id: 501, name: "월조출1" },
    { id: 502, name: "월조출2" },
    { id: 503, name: "월후출1" },
  ]);
  const resolved = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    fetchOpsDutySheets: async () => {
      throw new Error("stored가 있으면 sheet를 읽지 않음");
    },
  });
  assert(resolved.source === "stored", "duty/leader baseSource stored");
  assert(resolved.marshalSource === "monthly", "marshalSource monthly");
  const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
  const byKey = Object.fromEntries(rows.map((row) => [row.roleKey, row.caddyId]));
  assert(byKey["당번_조출_1"] === 156 && byKey["조장_1"] === 18, "duty/leader 유지");
  assert(
    byKey["마샬_조출_1"] === 501 &&
      byKey["마샬_조출_2"] === 502 &&
      byKey["마샬_후출_1"] === 503,
    "monthly marshal overlay"
  );
  assert(!rows.some((row) => row.caddyId === 161 || row.caddyId === 53 || row.caddyId === 99), "stored marshal 제거");
  const effective = await resolveEffectiveOpsDuty(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => [],
  });
  const excluded = exclusionIds(DATE, caddies, effective.entries);
  assert(excluded.includes(501) && excluded.includes(156), "monthly marshal + stored duty exclusion");
  assert(!excluded.includes(161), "stored marshal 이용근 제외 해제");
}

section("DRAFT ignored → stored/sheet fallback");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
  ];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 20, name: "저장마샬" },
    { id: 30, name: "드래프트마샬" },
  ]);
  const effective = await resolveEffectiveOpsDuty(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => [],
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => [],
  });
  assert(effective.marshalSource === "stored", "no monthly → stored marshal");
  assert(effective.rows.some((row) => row.caddyId === 20), "stored marshal used");
  assert(!effective.rows.some((row) => row.caddyId === 30), "DRAFT 사람 없음");
}

section("override SET/CLEAR beat FINALIZED");
{
  const stored = [storedRow("당번_조출_1", "DUTY_AM", 10, "당번A")];
  const monthly = [monthlyRow("마샬_조출_1", 20, "월마샬")];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 20, name: "월마샬" },
    { id: 30, name: "현장마샬" },
  ]);
  const deps = {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => [],
  };
  const set = await resolveEffectiveOpsDuty(DATE, {
    ...deps,
    listOverrides: async () => [
      {
        id: 1,
        roleKey: "마샬_조출_1",
        role: "MARSHAL_AM",
        action: "SET",
        caddyId: 30,
        name: "현장마샬",
        rawName: "현장마샬",
        team: "2조",
      },
    ],
  });
  assert(set.rows.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 30, "SET > monthly");
  assert(!set.caddyIds.includes(20), "월마샬 exclusion 해제");
  const getAfterSet = await resolveOpsDutyReadOnly(DATE, deps);
  const getRows = opsDutyPanelRowsFromReadOnly(getAfterSet, caddies);
  assert(
    getRows.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 20,
    "GET rows는 override 없이 monthly base"
  );

  const cleared = await resolveEffectiveOpsDuty(DATE, {
    ...deps,
    listOverrides: async () => [
      {
        id: 1,
        roleKey: "마샬_조출_1",
        role: "MARSHAL_AM",
        action: "CLEAR",
        caddyId: null,
        name: null,
        rawName: null,
        team: null,
      },
    ],
  });
  assert(
    !cleared.rows.some((row) => row.roleKey === "마샬_조출_1"),
    "CLEAR blocks monthly/stored/sheet marshal"
  );
  const restored = applyOpsDutyOverrides(
    opsDutyPanelRowsFromReadOnly(getAfterSet, caddies),
    [] as OpsDutyOverrideInput[]
  );
  assert(
    restored.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 20,
    "RESTORE overlay 없음 → monthly 복귀"
  );
}

section("FINALIZED empty day falls back to stored then sheet");
{
  const stored = [
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
  ];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 20, name: "저장마샬" },
    { id: 40, name: "시트마샬" },
  ]);
  const storedHit = await resolveEffectiveOpsDuty(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => [],
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => {
      throw new Error("stored hit");
    },
  });
  assert(storedHit.rows.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 20, "stored marshal fallback");

  const sheets = buildOpsDutySheetTestSheets([
    {
      name: "0301~0314",
      startDate: SHEET_DATE,
      week1Dates: [
        SHEET_DATE,
        "2099-03-09",
        "2099-03-10",
        "2099-03-11",
        "2099-03-12",
        "2099-03-13",
        "2099-03-14",
      ],
      week2Dates: [
        "2099-03-15",
        "2099-03-16",
        "2099-03-17",
        "2099-03-18",
        "2099-03-19",
        "2099-03-20",
        "2099-03-21",
      ],
      week1Names: [
        {
          당번_조출_1: "당번A",
          마샬_조출_1: "시트마샬",
        },
      ],
    },
  ]);
  const sheetHit = await resolveEffectiveOpsDuty(SHEET_DATE, {
    listDuties: async () => [],
    listMonthlyMarshal: async () => [],
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => sheets,
  });
  assert(sheetHit.baseSource === "sheet", "no stored → sheet");
  assert(sheetHit.rows.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 40, "sheet marshal fallback");
}

section("manual/substitute slot edit reflects on next read");
{
  const caddies = rosterFrom([
    { id: 1, name: "원본마샬" },
    { id: 2, name: "대타마샬" },
  ]);
  let current: MonthlyMarshalDutyRow[] = [
    monthlyRow("마샬_조출_1", 1, "원본마샬", "ROTATION"),
  ];
  const first = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => [],
    listMonthlyMarshal: async () => current,
    fetchOpsDutySheets: async () => [],
  });
  assert(
    opsDutyPanelRowsFromReadOnly(first, caddies)[0]?.caddyId === 1,
    "before edit"
  );
  current = [monthlyRow("마샬_조출_1", 2, "대타마샬", "SUBSTITUTE")];
  const second = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => [],
    listMonthlyMarshal: async () => current,
    fetchOpsDutySheets: async () => [],
  });
  assert(
    opsDutyPanelRowsFromReadOnly(second, caddies)[0]?.caddyId === 2,
    "next read sees substitute without materialize"
  );
}

section("dashboard merge: monthly marshal, stored duty");
{
  const resolved = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => [
      storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
      storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
    ],
    listMonthlyMarshal: async () => [monthlyRow("마샬_조출_1", 30, "월마샬", "MANUAL")],
    fetchOpsDutySheets: async () => {
      throw new Error("stored hit");
    },
  });
  const groups = groupOpsDutyNames(
    mergedDutyExcelEntriesFromReadOnly(resolved).map((entry) => ({
      role: opsDutyRoleFromKind(entry.kind),
      name: entry.rawName,
      rawName: entry.rawName,
    }))
  );
  const duty = groups.find((g) => g.role === "DUTY_AM");
  const marshal = groups.find((g) => g.role === "MARSHAL_AM");
  assert(duty?.names.includes("당번A"), "dashboard duty 유지");
  assert(marshal?.names.includes("월마샬"), "dashboard monthly marshal");
  assert(!marshal?.names.includes("저장마샬"), "dashboard stored marshal 숨김");
  assert(resolved.source === "stored", "snapshot dutySource stored 유지");
}

section("merged entries helper + overlay");
{
  const overlaid = overlayMonthlyMarshalDutyEntries(
    [
      { kind: "duty_am", roleKey: "당번_조출_1", rawName: "당번A" },
      { kind: "marshal_am", roleKey: "마샬_조출_1", rawName: "저장마샬" },
    ],
    [monthlyRow("마샬_조출_1", 30, "월마샬")]
  );
  assert(
    overlaid.some((row) => row.roleKey === "당번_조출_1" && row.rawName === "당번A"),
    "overlay keeps duty"
  );
  assert(
    overlaid.some((row) => row.roleKey === "마샬_조출_1" && row.rawName === "월마샬"),
    "overlay replaces marshal"
  );
  const resolved = {
    source: "stored" as const,
    stored: [
      storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
      storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
    ],
    sheetEntries: [],
    monthlyMarshal: [monthlyRow("마샬_조출_1", 30, "월마샬")],
    error: null,
  };
  const merged = mergedDutyExcelEntriesFromReadOnly(resolved);
  assert(
    merged.filter((row) => row.roleKey.startsWith("마샬_")).map((row) => row.rawName).join(",") ===
      "월마샬",
    "mergedDutyExcelEntriesFromReadOnly"
  );
}

section("2 AM + 2 PM FINALIZED extra slot is visible and excluded");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("조장_1", "LEADER", 11, "조장A"),
  ];
  const monthly = [
    monthlyRow("마샬_조출_1", 21, "월A"),
    monthlyRow("마샬_조출_2", 22, "월B"),
    monthlyRow("마샬_후출_1", 23, "월C"),
    monthlyRow("마샬_후출_2", 24, "월D"),
  ];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 11, name: "조장A" },
    { id: 21, name: "월A" },
    { id: 22, name: "월B" },
    { id: 23, name: "월C" },
    { id: 24, name: "월D" },
  ]);
  const resolved = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    fetchOpsDutySheets: async () => [],
  });
  const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
  const ids = rows.map((row) => row.caddyId).sort((a, b) => a - b);
  assert(ids.join(",") === "10,11,21,22,23,24", "GET rows keep A/B/C/D + duty/leader");
  assert(rows.some((row) => row.roleKey === "마샬_후출_2" && row.caddyId === 24), "second PM visible");
  const effective = await resolveEffectiveOpsDuty(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => [],
  });
  assert(effective.caddyIds.includes(24), "second PM in effective caddyIds");
  const excluded = exclusionIds(DATE, caddies, effective.entries);
  assert(excluded.includes(24) && excluded.includes(23), "second PM assignment exclusion");
  const groups = groupOpsDutyNames(
    mergedDutyExcelEntriesFromReadOnly(resolved).map((entry) => ({
      role: opsDutyRoleFromKind(entry.kind),
      name: entry.rawName,
      rawName: entry.rawName,
    }))
  );
  const marshalPm = groups.find((g) => g.role === "MARSHAL_PM");
  assert(
    marshalPm?.names.includes("월C") && marshalPm?.names.includes("월D"),
    "dashboard/date-bundle PM names include second PM"
  );
  assert(
    effective.slots.every((slot) => isOpsDutyRoleKey(slot.roleKey)),
    "editor slots stay 8-key"
  );
  assert(
    !effective.slots.some((slot) => slot.roleKey === "마샬_후출_2"),
    "extra PM is not an editor slot"
  );
}

section("partial stored marshal + Sheet fallback");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("조장_1", "LEADER", 11, "조장A"),
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장조출1"),
  ];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 11, name: "조장A" },
    { id: 20, name: "저장조출1" },
    { id: 40, name: "시트후출1" },
    { id: 41, name: "시트당번무시" },
  ]);
  const sheets = buildOpsDutySheetTestSheets([
    {
      name: "0301~0314",
      startDate: SHEET_DATE,
      week1Dates: [
        SHEET_DATE,
        "2099-03-09",
        "2099-03-10",
        "2099-03-11",
        "2099-03-12",
        "2099-03-13",
        "2099-03-14",
      ],
      week2Dates: [
        "2099-03-15",
        "2099-03-16",
        "2099-03-17",
        "2099-03-18",
        "2099-03-19",
        "2099-03-20",
        "2099-03-21",
      ],
      week1Names: [
        {
          당번_조출_1: "시트당번무시",
          마샬_조출_1: "시트조출무시",
          마샬_후출_1: "시트후출1",
        },
      ],
    },
  ]);
  const effective = await resolveEffectiveOpsDuty(SHEET_DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => [],
    listOverrides: async () => [],
    listCaddies: async () => caddies,
    fetchOpsDutySheets: async () => sheets,
  });
  assert(effective.baseSource === "stored", "duty/leader stay stored");
  assert(effective.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === 10, "sheet duty blocked");
  assert(effective.rows.find((row) => row.roleKey === "조장_1")?.caddyId === 11, "leader stays stored");
  assert(
    effective.rows.find((row) => row.roleKey === "마샬_조출_1")?.caddyId === 20,
    "stored marshal key stays stored"
  );
  assert(
    effective.rows.find((row) => row.roleKey === "마샬_후출_1")?.caddyId === 40,
    "missing stored marshal key uses sheet"
  );
  assert(!effective.rows.some((row) => row.caddyId === 41), "sheet duty name not mixed in");
}

section("unexpected monthly loader error does not silent-fallback");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
  ];
  let threw = false;
  try {
    await resolveOpsDutyReadOnly(DATE, {
      listDuties: async () => stored,
      listMonthlyMarshal: async () => {
        throw new Error("prisma monthly down");
      },
      fetchOpsDutySheets: async () => [],
    });
  } catch (error) {
    threw = error instanceof Error && error.message === "prisma monthly down";
  }
  assert(threw, "unexpected monthly DB error propagates");
  try {
    await resolveEffectiveOpsDuty(DATE, {
      listDuties: async () => stored,
      listMonthlyMarshal: async () => {
        throw new Error("prisma monthly down");
      },
      listOverrides: async () => [],
      listCaddies: async () => rosterFrom([{ id: 20, name: "저장마샬" }]),
      fetchOpsDutySheets: async () => [],
    });
    assert(false, "effective must not succeed with stored marshal fallback");
  } catch (error) {
    assert(
      error instanceof Error && error.message === "prisma monthly down",
      "effective also fail-closed"
    );
  }
}

section("non-operational FINALIZED monthly does not resurrect stored marshal");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
  ];
  const monthly = [
    {
      ...monthlyRow("마샬_조출_1", 30, "퇴사월마샬", "MANUAL"),
      employmentStatus: "RETIRED",
    },
  ];
  const caddies = [
    ...rosterFrom([
      { id: 10, name: "당번A" },
      { id: 20, name: "저장마샬" },
    ]),
    {
      id: 30,
      name: "퇴사월마샬",
      team: "1조",
      teamOrder: 30,
      employmentStatus: "RETIRED" as const,
      caddyType: "HOUSE" as const,
    },
  ];
  const resolved = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    fetchOpsDutySheets: async () => [],
  });
  const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
  assert(!rows.some((row) => row.caddyId === 20), "stored marshal not resurrected");
  assert(!rows.some((row) => row.caddyId === 30), "retired monthly not rendered");
  assert(rows.some((row) => row.caddyId === 10), "duty still shown");
  assert(
    marshalNonOperationalKeys(monthly, caddies).includes("마샬_조출_1"),
    "warning metadata for unrenderable monthly key"
  );
  const merged = mergedDutyExcelEntriesFromReadOnly(resolved);
  assert(
    !merged.some((entry) => entry.roleKey === "마샬_조출_1" && entry.rawName === "저장마샬"),
    "exclusion entries do not revive stored marshal"
  );
  assert(
    !merged.some((entry) => entry.rawName === "퇴사월마샬"),
    "retired monthly not in overlay names"
  );
}

section("required Sheet marshal fallback failure is incomplete");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("조장_1", "LEADER", 11, "조장A"),
  ];
  const caddies = rosterFrom([
    { id: 10, name: "당번A" },
    { id: 11, name: "조장A" },
  ]);
  const failed = await resolveOpsDutyReadOnly(DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => [],
    fetchOpsDutySheets: async () => {
      throw new Error("ops_duty_sheet_failed");
    },
  });
  assert(failed.source === "stored", "stored duty/leader still readable");
  assert(failed.error === "ops_duty_sheet_failed", "required Sheet fallback failure is explicit");
  assert(!opsDutyReadCompleteForSnapshot(failed), "snapshot complete=false");
  const failedRows = opsDutyPanelRowsFromReadOnly(failed, caddies);
  assert(failedRows.some((row) => row.caddyId === 10), "stored duty remains");
  assert(failedRows.some((row) => row.caddyId === 11), "stored leader remains");
  assert(
    !failedRows.some((row) => String(row.roleKey).startsWith("마샬_")),
    "does not invent stale marshal"
  );

  const okEmpty = await resolveOpsDutyReadOnly(SHEET_DATE, {
    listDuties: async () => stored,
    listMonthlyMarshal: async () => [],
    fetchOpsDutySheets: async () =>
      buildOpsDutySheetTestSheets([
        {
          name: "0301~0314",
          startDate: SHEET_DATE,
          week1Dates: [
            SHEET_DATE,
            "2099-03-09",
            "2099-03-10",
            "2099-03-11",
            "2099-03-12",
            "2099-03-13",
            "2099-03-14",
          ],
          week2Dates: [
            "2099-03-15",
            "2099-03-16",
            "2099-03-17",
            "2099-03-18",
            "2099-03-19",
            "2099-03-20",
            "2099-03-21",
          ],
          week1Names: [{ 당번_조출_1: "시트당번무시" }],
        },
      ]),
  });
  assert(okEmpty.source === "stored" && okEmpty.error === null, "successful empty Sheet is not failure");
  assert(opsDutyReadCompleteForSnapshot(okEmpty), "absent marshal key after successful Sheet read is complete");
}

section("retired monthly hidden on dashboard full source and DB-first");
{
  const stored = [
    storedRow("당번_조출_1", "DUTY_AM", 10, "당번A"),
    storedRow("마샬_조출_1", "MARSHAL_AM", 20, "저장마샬"),
  ];
  const monthly = [
    {
      ...monthlyRow("마샬_조출_1", 30, "퇴사월마샬", "MANUAL"),
      employmentStatus: "RETIRED",
    },
  ];
  const roster = [
    ...rosterFrom([
      { id: 10, name: "당번A" },
      { id: 20, name: "저장마샬" },
    ]),
    {
      id: 30,
      name: "퇴사월마샬",
      team: "1조",
      teamOrder: 30,
      employmentStatus: "RETIRED" as const,
      caddyType: "HOUSE" as const,
    },
  ];
  const mockAvail = async (ymd: string) =>
    applyDailyExternalExclusions({
      availability: computeAvailability({ date: ymd, caddies: roster, assignments: [] }),
      caddies: roster,
      offNames: [],
      dutyEntries: [],
    });
  const full = await loadAdminOpsDashboardSource(DATE, {
    loadAvailability: mockAvail,
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
    fetchOffSheets: async () => [],
    fetchOpsDutySheets: async () => [],
  });
  const fullMarshal = full.dashboard.opsDuties.find((g) => g.role === "MARSHAL_AM");
  assert(!fullMarshal?.names.includes("퇴사월마샬"), "dashboard full-source hides retired monthly");
  assert(!fullMarshal?.names.includes("저장마샬"), "dashboard full-source does not resurrect stored marshal");
  assert(full.dashboard.opsDuties.some((g) => g.role === "DUTY_AM" && g.names.includes("당번A")), "dashboard duty remains");

  const dbFirst = await loadAdminOpsDashboardDbFirst(DATE, {
    listRoster: async () => roster,
    listDuties: async () => stored,
    listMonthlyMarshal: async () => monthly,
  });
  const firstMarshal = dbFirst.opsDuties.find((g) => g.role === "MARSHAL_AM");
  assert(!firstMarshal?.names.includes("퇴사월마샬"), "dashboard DB-first hides retired monthly");
  assert(!firstMarshal?.names.includes("저장마샬"), "dashboard DB-first does not resurrect stored marshal");
}

section("3 AM + 2 PM marshal display order");
{
  assert(
    sortMarshalSlotLabels(["후출2", "조출3", "후출1", "조출1", "조출2"]).join(",") ===
      "조출1,조출2,조출3,후출1,후출2",
    "sortMarshalSlotLabels AM then PM by index"
  );
  const filled = filledMarshalSlots([
    { label: "후출1", people: [{ caddyId: 4, name: "C", badges: [] }] },
    { label: "조출1", people: [{ caddyId: 1, name: "A", badges: [] }] },
    { label: "조출3", people: [{ caddyId: 3, name: "A3", badges: [] }] },
    { label: "조출2", people: [{ caddyId: 2, name: "B", badges: [] }] },
    { label: "후출2", people: [{ caddyId: 5, name: "D", badges: [] }] },
  ]);
  assert(
    filled.map((slot) => slot.label).join(",") === "조출1,조출2,조출3,후출1,후출2",
    "3 AM + 2 PM display order"
  );
}

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
