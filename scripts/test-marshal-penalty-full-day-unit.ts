/**
 * 마샬 전일 벌당 P1 — 순수 엔진/Daily Ops 읽기 계약 (production write 없음)
 * 실행: npm run test:marshal-penalty-full-day-unit
 */
import fs from "node:fs";
import path from "node:path";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { MarshalRosterError } from "../src/lib/marshalDomain";
import {
  mapFinalizedMarshalSlots,
  overlayMonthlyMarshalDutyEntries,
} from "../src/lib/marshalMonthDutySource";
import {
  assertFullDayPenaltyPairLocked,
  assertGeneratedSlotsSameDayIntegrity,
  balanceDayShifts,
  generateMonthRotation,
  parsePenaltyCoverage,
  penaltyOccupiedSlotCount,
  penaltyShiftOccupancy,
  resolvePenaltyCoverage,
  type DayPenaltyInput,
  type GeneratedSlot,
  type RotationMember,
} from "../src/lib/marshalRotationDomain";

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

function throws(fn: () => void, code: string, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof MarshalRosterError && e.code === code, msg);
  }
}

function member(order: number, name: string, id = order): RotationMember {
  return {
    profileId: id,
    caddyId: id * 10,
    rotationOrder: order,
    name,
    employmentStatus: "ACTIVE",
  };
}

const roster = [
  member(1, "A"),
  member(2, "B"),
  member(3, "C"),
  member(4, "D"),
  member(5, "E"),
  member(6, "F"),
];

function namesOn(
  slots: { date: string; caddyId: number }[],
  date: string
): string {
  return [
    ...new Set(
      slots
        .filter((s) => s.date === date)
        .map(
          (s) => roster.find((m) => m.caddyId === s.caddyId)?.name || String(s.caddyId)
        )
    ),
  ]
    .sort()
    .join(",");
}

function uniquePeople(slots: { caddyId: number }[]): number {
  return new Set(slots.map((s) => s.caddyId)).size;
}

function fullDayA(): DayPenaltyInput {
  return {
    caddyId: 10,
    profileId: 1,
    shift: "AM",
    coverage: "FULL_DAY",
  };
}

section("coverage helpers keep legacy shift occupancy");
{
  assert(parsePenaltyCoverage(undefined) === "FULL_DAY", "create default FULL_DAY");
  assert(parsePenaltyCoverage("전일") === "FULL_DAY", "한글 전일");
  assert(parsePenaltyCoverage("AM") === "AM", "explicit AM");
  assert(
    resolvePenaltyCoverage({ shift: "PM" }) === "PM",
    "legacy omit coverage → shift"
  );
  assert(
    resolvePenaltyCoverage({ shift: "AM", coverage: "FULL_DAY" }) === "FULL_DAY",
    "explicit FULL_DAY wins over shift"
  );
  const occ = penaltyShiftOccupancy([fullDayA()]);
  assert(occ.am === 1 && occ.pm === 1, "FULL_DAY occupies AM+PM");
  assert(penaltyOccupiedSlotCount([fullDayA()]) === 2, "FULL_DAY slot count 2");
  assert(
    penaltyOccupiedSlotCount([{ caddyId: 10, profileId: 1, shift: "PM" }]) === 1,
    "legacy PM occupies 1"
  );
  throws(() => parsePenaltyCoverage("DAY"), "invalid_coverage", "bad coverage rejected");
}

section("1. 벌당 없는 기존 월표");
{
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(out.slots.length === 3, "AM2+PM1 = 3 slots");
  assert(namesOn(out.slots, "2026-11-01") === "A,B,C", "normal 1,2,3");
  assert(uniquePeople(out.slots) === 3, "3 distinct people");
  assert(
    out.slots.every((s) => s.source === "ROTATION"),
    "all ROTATION"
  );
}

section("2. FULL_DAY 벌당 1건");
{
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([["2026-11-01", [fullDayA()]]]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const day = out.slots.filter((s) => s.date === "2026-11-01");
  assert(day.length === 3, "total slots stay 3");
  assert(uniquePeople(day) === 2, "actual people = 2");
  assert(namesOn(out.slots, "2026-11-01") === "A,B", "A 벌당 + B 정상");
  const aSlots = day.filter((s) => s.caddyId === 10);
  assert(
    aSlots.length === 2 &&
      aSlots.every((s) => s.source === "PENALTY") &&
      aSlots.some((s) => s.shift === "AM") &&
      aSlots.some((s) => s.shift === "PM"),
    "A occupies AM+PM as PENALTY"
  );
  assert(
    day.filter((s) => s.source === "ROTATION").length === 1,
    "normal rotation consumes 1 person"
  );
  const b = day.find((s) => s.caddyId === 20);
  assert(b?.source === "ROTATION" && b.shift === "AM", "B fills remaining AM");
  assert(out.nextRotationOrder === 3, "cursor after B is C");
  assert(out.nextPendingProfileIds.join(",") === "1", "A deferred as pending");
}

section("3. 벌당+정상 순번 혼합 (레거시 단일 칸 유지)");
{
  const legacy = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([
      ["2026-11-01", [{ caddyId: 30, profileId: 3, shift: "PM" as const }]],
    ]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(namesOn(legacy.slots, "2026-11-01") === "C,E,F", "legacy PM penalty still C+E+F");
  assert(
    legacy.slots.filter((s) => s.source === "ROTATION").length === 2,
    "legacy penalty occupies 1 so rotation 2"
  );
}

section("4. 후출 2명 + FULL_DAY");
{
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 2,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([["2026-11-01", [fullDayA()]]]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const day = out.slots.filter((s) => s.date === "2026-11-01");
  assert(day.length === 4, "AM2+PM2 = 4 slots");
  assert(day.filter((s) => s.shift === "PM").length === 2, "PM capacity 2");
  assert(uniquePeople(day) === 3, "A + 2 rotation");
  assert(
    day.filter((s) => s.source === "ROTATION").length === 2,
    "FULL_DAY occupies 2 of 4 → rotation 2"
  );
}

section("5. 벌당 정원 초과");
{
  throws(
    () =>
      generateMonthRotation({
        year: 2026,
        month: 11,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 1,
        members: roster,
        dates: ["2026-11-01"],
        penaltiesByDate: new Map([
          [
            "2026-11-01",
            [
              fullDayA(),
              {
                caddyId: 20,
                profileId: 2,
                shift: "AM",
                coverage: "FULL_DAY",
              },
            ],
          ],
        ]),
        statusByDateCaddy: new Map(),
        openCredits: [],
      }),
    "penalty_overflow",
    "two FULL_DAY overflow PM=1"
  );
  const pm2 = generateMonthRotation({
    year: 2026,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 2,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([
      [
        "2026-11-01",
        [
          fullDayA(),
          { caddyId: 20, profileId: 2, shift: "PM", coverage: "FULL_DAY" },
        ],
      ],
    ]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(pm2.slots.length === 4, "two FULL_DAY fits AM2/PM2");
  assert(uniquePeople(pm2.slots) === 2, "two people cover 4 slots");
  assert(
    pm2.slots.every((s) => s.source === "PENALTY"),
    "no extra rotation placed"
  );
}

section("6. 동일 캐디 불법 중복");
{
  throws(
    () =>
      generateMonthRotation({
        year: 2026,
        month: 11,
        startRotationOrder: 1,
        members: roster,
        dates: ["2026-11-01"],
        penaltiesByDate: new Map([
          [
            "2026-11-01",
            [
              { caddyId: 10, profileId: 1, shift: "AM", coverage: "AM" },
              { caddyId: 10, profileId: 1, shift: "PM", coverage: "PM" },
            ],
          ],
        ]),
        statusByDateCaddy: new Map(),
        openCredits: [],
      }),
    "same_day_duplicate",
    "two penalty rows same caddy rejected"
  );
  throws(
    () =>
      assertGeneratedSlotsSameDayIntegrity("2026-11-01", [
        {
          date: "2026-11-01",
          shift: "AM",
          slotIndex: 0,
          caddyId: 10,
          profileId: 1,
          source: "PENALTY",
          warning: null,
        },
        {
          date: "2026-11-01",
          shift: "AM",
          slotIndex: 1,
          caddyId: 10,
          profileId: 1,
          source: "PENALTY",
          warning: null,
        },
      ]),
    "same_day_duplicate",
    "AM+AM same caddy rejected"
  );
  throws(
    () =>
      assertGeneratedSlotsSameDayIntegrity("2026-11-01", [
        {
          date: "2026-11-01",
          shift: "AM",
          slotIndex: 0,
          caddyId: 10,
          profileId: 1,
          source: "ROTATION",
          warning: null,
        },
        {
          date: "2026-11-01",
          shift: "PM",
          slotIndex: 0,
          caddyId: 10,
          profileId: 1,
          source: "ROTATION",
          warning: null,
        },
      ]),
    "same_day_duplicate",
    "rotation AM+PM same caddy rejected"
  );
}

section("7. 벌당 AM/PM 쌍 보호");
{
  assertGeneratedSlotsSameDayIntegrity("2026-11-01", [
    {
      date: "2026-11-01",
      shift: "AM",
      slotIndex: 0,
      caddyId: 10,
      profileId: 1,
      source: "PENALTY",
      warning: null,
    },
    {
      date: "2026-11-01",
      shift: "PM",
      slotIndex: 0,
      caddyId: 10,
      profileId: 1,
      source: "PENALTY",
      warning: null,
    },
    {
      date: "2026-11-01",
      shift: "AM",
      slotIndex: 1,
      caddyId: 20,
      profileId: 2,
      source: "ROTATION",
      warning: null,
    },
  ]);
  assert(true, "FULL_DAY AM+PM pair allowed");
  throws(
    () =>
      assertFullDayPenaltyPairLocked({
        slotId: 1,
        slotCaddyId: 10,
        slotSource: "PENALTY",
        daySlots: [
          { id: 1, caddyId: 10, shift: "AM", source: "PENALTY" },
          { id: 2, caddyId: 10, shift: "PM", source: "PENALTY" },
          { id: 3, caddyId: 20, shift: "AM", source: "ROTATION" },
        ],
      }),
    "full_day_penalty_locked",
    "one-sided FULL_DAY replace → 409"
  );
  assertFullDayPenaltyPairLocked({
    slotId: 3,
    slotCaddyId: 20,
    slotSource: "ROTATION",
    daySlots: [
      { id: 1, caddyId: 10, shift: "AM", source: "PENALTY" },
      { id: 2, caddyId: 10, shift: "PM", source: "PENALTY" },
      { id: 3, caddyId: 20, shift: "AM", source: "ROTATION" },
    ],
  });
  assert(true, "normal rotation substitute still allowed");
}

section("8. 월말 순번 이월 (FULL_DAY)");
{
  const lastDay = generateMonthRotation({
    year: 2026,
    month: 10,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-10-31"],
    penaltiesByDate: new Map([["2026-10-31", [fullDayA()]]]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(
    lastDay.nextPendingProfileIds.join(",") === "1",
    "final-day FULL_DAY=current-turn carries A"
  );
  assert(lastDay.nextRotationOrder === 3, "cursor after the 1 rotation (B) is C");
  const nextMonth = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: lastDay.nextRotationOrder,
    startPendingProfileIds: lastDay.nextPendingProfileIds,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(namesOn(nextMonth.slots, "2026-11-01") === "A,C,D", "pending A then C,D");
  assert(
    nextMonth.slots.find((s) => s.caddyId === 10)?.source === "ROTATION",
    "carried A is ROTATION next month"
  );
}

section("9. 기존 병가/장기병가");
{
  const sick = new Map<string, { kind: "hard_skip" | "ok"; message: string | null }>();
  sick.set("2026-11-01:20", { kind: "hard_skip", message: "병가" });
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([["2026-11-01", [fullDayA()]]]),
    statusByDateCaddy: sick,
    openCredits: [],
  });
  assert(namesOn(out.slots, "2026-11-01") === "A,C", "SICK skips B → A벌당 + C");
  assert(
    !out.slots.some((s) => s.caddyId === 20),
    "sick B not assigned"
  );
}

section("10. 기존 휴무 충돌");
{
  const status = new Map<
    string,
    { kind: "off_conflict" | "ok"; message: string | null }
  >();
  status.set("2026-11-01:20", { kind: "off_conflict", message: "휴무 충돌" });
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([["2026-11-01", [fullDayA()]]]),
    statusByDateCaddy: status,
    openCredits: [],
  });
  const b = out.slots.find((s) => s.caddyId === 20);
  assert(b?.warning === "휴무 충돌", "OFF keeps B with warning");
  assert(namesOn(out.slots, "2026-11-01") === "A,B", "OFF does not skip");
}

section("11. 기존 대타/크레딧");
{
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map([["2026-11-01", [fullDayA()]]]),
    statusByDateCaddy: new Map(),
    openCredits: [{ id: 9, profileId: 2 }],
  });
  assert(namesOn(out.slots, "2026-11-01") === "A,C", "B credit skip, C fills rotation");
  assert(out.consumedCredits[0]?.profileId === 2, "B credit consumed once");
}

section("12. FINALIZED Daily Ops 읽기");
{
  const mapped = mapFinalizedMarshalSlots({
    planId: 77,
    planStatus: "FINALIZED",
    slots: [
      { shift: "AM", slotIndex: 0, caddyId: 10, name: "A", source: "PENALTY" },
      { shift: "AM", slotIndex: 1, caddyId: 20, name: "B", source: "ROTATION" },
      { shift: "PM", slotIndex: 0, caddyId: 10, name: "A", source: "PENALTY" },
    ],
  });
  assert(mapped.source === "monthly" && mapped.rows.length === 3, "3 duty rows");
  assert(
    mapped.rows.some((r) => r.roleKey === "마샬_조출_1" && r.caddyId === 10),
    "조출1 = A"
  );
  assert(
    mapped.rows.some((r) => r.roleKey === "마샬_조출_2" && r.caddyId === 20),
    "조출2 = B"
  );
  assert(
    mapped.rows.some((r) => r.roleKey === "마샬_후출_1" && r.caddyId === 10),
    "후출1 = A"
  );
  const entries = overlayMonthlyMarshalDutyEntries([], mapped.rows);
  assert(entries.length === 3, "overlay keeps AM and PM for same A");
}

section("13. 자동배치 제외 인원 중복 방지");
{
  const caddies = [
    {
      id: 10,
      name: "A",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE" as const,
      caddyType: "HOUSE" as const,
    },
    {
      id: 20,
      name: "B",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "ACTIVE" as const,
      caddyType: "HOUSE" as const,
    },
  ];
  const mapped = mapFinalizedMarshalSlots({
    planStatus: "FINALIZED",
    slots: [
      { shift: "AM", slotIndex: 0, caddyId: 10, name: "A", source: "PENALTY" },
      { shift: "AM", slotIndex: 1, caddyId: 20, name: "B", source: "ROTATION" },
      { shift: "PM", slotIndex: 0, caddyId: 10, name: "A", source: "PENALTY" },
    ],
  });
  const entries = overlayMonthlyMarshalDutyEntries([], mapped.rows);
  const availability = computeAvailability({
    date: "2026-11-01",
    caddies,
    assignments: [],
  });
  const overlaid = applyDailyExternalExclusions({
    availability,
    caddies,
    offNames: [],
    dutyEntries: entries,
  });
  assert(
    overlaid.opsDutyCaddyIds.filter((id) => id === 10).length === 1,
    "A excluded once in opsDutyCaddyIds"
  );
  assert(overlaid.opsDutyCaddyIds.includes(20), "B also excluded");
  assert(
    overlaid.dailySummary.duplicateExcluded >= 1,
    "second A counted as duplicateExcluded"
  );
}

section("source contracts");
{
  const schema = fs.readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(
    path.resolve("prisma/migrations/20261018120000_marshal_penalty_full_day_p1/migration.sql"),
    "utf8"
  );
  const engine = fs.readFileSync(path.resolve("src/lib/autoAssignEngine.ts"), "utf8");
  const keys = fs.readFileSync(path.resolve("src/lib/opsDutyRoleKeys.ts"), "utf8");
  assert(schema.includes("enum MarshalPenaltyCoverage"), "schema coverage enum");
  assert(schema.includes("@default(FULL_DAY)"), "new rows default FULL_DAY");
  assert(
    schema.includes("@@unique([planId, date, shift, caddyId])"),
    "slot unique per shift+caddy"
  );
  const slotModel = schema.slice(
    schema.indexOf("model MarshalMonthSlot"),
    schema.indexOf("model MarshalPenaltyDuty")
  );
  assert(
    !slotModel.includes("@@unique([planId, date, caddyId])"),
    "old date+caddy unique removed from slots"
  );
  assert(
    migration.includes("coverage = shift") ||
      migration.includes('WHEN "shift"::text = \'AM\''),
    "backfill preserves existing shift meaning"
  );
  assert(migration.includes("Production migrate 실행은 이 PR에서 하지 않는다"), "no prod migrate");
  assert(engine.includes("computeAutoAssignmentsV1"), "autoAssignEngine untouched");
  assert(keys.includes("OPS_DUTY_ROLE_KEYS"), "sheet 8-key file present");
}

section("balanceDayShifts FULL_DAY does not extra-fill");
{
  const counts = new Map();
  const slots: GeneratedSlot[] = balanceDayShifts({
    date: "2026-11-01",
    amSlots: 2,
    pmSlots: 1,
    rotationPicks: [roster[1], roster[2], roster[3]],
    penalties: [fullDayA()],
    dayKindByCaddy: new Map(),
    counts,
  });
  assert(slots.length === 3, "balanced 3");
  assert(uniquePeople(slots) === 2, "does not place extra rotation people");
  assert(
    slots.filter((s) => s.source === "ROTATION").map((s) => s.caddyId).join(",") ===
      "20",
    "only first remaining pick used"
  );
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
