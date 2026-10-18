/**
 * 마샬 벌당 발생 P2 — 다음 달 FULL_DAY 배정 순수 규칙 (production write 없음)
 * 실행: npm run test:marshal-penalty-occurrence-unit
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MarshalRosterError } from "../src/lib/marshalDomain";
import {
  assertOccurrenceCancellable,
  assertOccurrenceTargetMutable,
  assertPlanReadyToFinalize,
  mergeAssignedOccurrences,
  nextYearMonth,
  occurrenceToFullDayPenalty,
  parseIdempotencyKey,
  scheduleOccurrencesForMonth,
  sortOccurrencesForSchedule,
  targetMonthFromOccurredOn,
} from "../src/lib/marshalPenaltyOccurrenceDomain";
import {
  generateMonthRotation,
  type DayPenaltyInput,
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

function occ(
  id: number,
  caddyId: number,
  occurredOn: string,
  profileId = Math.floor(caddyId / 10)
) {
  return { id, caddyId, profileId, occurredOn };
}

section("source contracts — P1 engine reuse, autoAssign untouched");
{
  const domain = fs.readFileSync(
    path.join(process.cwd(), "src/lib/marshalPenaltyOccurrenceDomain.ts"),
    "utf8"
  );
  const service = fs.readFileSync(
    path.join(process.cwd(), "src/lib/marshalPenaltyOccurrenceService.ts"),
    "utf8"
  );
  const rotation = fs.readFileSync(
    path.join(process.cwd(), "src/lib/marshalRotationService.ts"),
    "utf8"
  );
  assert(
    domain.includes("penaltyShiftOccupancy") &&
      domain.includes("occurrenceToFullDayPenalty"),
    "domain reuses P1 occupancy + FULL_DAY input"
  );
  assert(
    service.includes("MarshalPenaltyDuty 행을 만들지 않는다"),
    "service does not materialize PenaltyDuty"
  );
  assert(
    !/from ["']@\/lib\/autoAssignEngine["']/.test(domain + service + rotation),
    "no autoAssignEngine import"
  );
  assert(
    rotation.includes("applyOccurrencesToMonth"),
    "generateMonthPlan hooks occurrence pack"
  );
  const names = String(
    spawnSync(
      "git",
      ["diff", "--name-only", "origin/main", "--", "src/lib/autoAssignEngine.ts"],
      { encoding: "utf8" }
    ).stdout || ""
  ).trim();
  assert(names === "", `autoAssignEngine untouched (${names || "clean"})`);
}

section("target month is next month of occurredOn");
{
  assert(
    JSON.stringify(nextYearMonth(2096, 10)) === JSON.stringify({ year: 2096, month: 11 }),
    "Oct → Nov"
  );
  assert(
    JSON.stringify(nextYearMonth(2096, 12)) === JSON.stringify({ year: 2097, month: 1 }),
    "Dec → Jan"
  );
  const target = targetMonthFromOccurredOn(new Date("2096-10-18T00:00:00"));
  assert(target.year === 2096 && target.month === 11, "occurredOn 10-18 → 2096-11");
}

section("occurrence order is occurredOn then id");
{
  const sorted = sortOccurrencesForSchedule([
    occ(3, 10, "2096-10-02"),
    occ(1, 20, "2096-10-01"),
    occ(2, 30, "2096-10-01"),
  ]);
  assert(
    sorted.map((row) => row.id).join(",") === "1,2,3",
    "same day uses id, then later occurredOn"
  );
}

section("assign from day 1 in occurrence order as FULL_DAY");
{
  const dates = ["2096-11-01", "2096-11-02", "2096-11-03"];
  const packed = scheduleOccurrencesForMonth({
    dates,
    amSlots: 2,
    pmSlots: 1,
    occurrences: [
      occ(2, 20, "2096-10-02"),
      occ(1, 10, "2096-10-01"),
    ],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(packed.assignments.length === 2, "both assigned");
  assert(
    packed.assignments[0].id === 1 && packed.assignments[0].date === "2096-11-01",
    "earlier occurrence → day 1"
  );
  assert(
    packed.assignments[1].id === 2 && packed.assignments[1].date === "2096-11-02",
    "later occurrence → day 2"
  );
  assert(
    occurrenceToFullDayPenalty(packed.assignments[0]).coverage === "FULL_DAY",
    "assignment is FULL_DAY"
  );
}

section("same caddy multiple occurrences take consecutive days");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02", "2096-11-03"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [
      occ(1, 10, "2096-10-01"),
      occ(2, 10, "2096-10-03"),
      occ(3, 10, "2096-10-05"),
    ],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(
    packed.assignments.map((row) => row.date).join(",") ===
      "2096-11-01,2096-11-02,2096-11-03",
    "same caddy 3건 → 1,2,3일"
  );
  assert(packed.leftover.length === 0, "no leftover when days remain");
}

section("skip SICK/LONG_SICK, keep OFF as non-skip");
{
  const statusByDateCaddy = new Map([
    ["2096-11-01:10", { kind: "hard_skip" as const, message: "병가" }],
    ["2096-11-02:10", { kind: "off_conflict" as const, message: "휴무 충돌" }],
  ]);
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [occ(1, 10, "2096-10-01")],
    existingByDate: new Map(),
    statusByDateCaddy,
  });
  assert(
    packed.assignments[0]?.date === "2096-11-02",
    "병가 1일은 건너뛰고 휴무 2일에 배정"
  );
}

section("PM capacity: two FULL_DAY cannot share a day");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [occ(1, 10, "2096-10-01"), occ(2, 20, "2096-10-02")],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(
    packed.assignments.map((row) => `${row.caddyId}@${row.date}`).join(",") ===
      "10@2096-11-01,20@2096-11-02",
    "두 전일 벌당은 날짜를 나눈다"
  );
}

section("existing PenaltyDuty consumes capacity; leftover stays OPEN");
{
  const existing = new Map<string, DayPenaltyInput[]>([
    [
      "2096-11-01",
      [{ caddyId: 30, profileId: 3, shift: "AM", coverage: "FULL_DAY" }],
    ],
  ]);
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [occ(1, 10, "2096-10-01")],
    existingByDate: existing,
    statusByDateCaddy: new Map(),
  });
  assert(packed.assignments.length === 0, "day already has FULL_DAY");
  assert(
    packed.leftover.length === 1 &&
      packed.leftover[0].id === 1 &&
      packed.leftover[0].deferReason.includes("수동"),
    "unassigned leftover keeps deferReason"
  );
}

section("month full of FULL_DAY leaves extra OPEN");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [
      occ(1, 10, "2096-10-01"),
      occ(2, 20, "2096-10-02"),
      occ(3, 30, "2096-10-03"),
    ],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(packed.assignments.length === 2, "two days take two FULL_DAY");
  assert(packed.leftover.map((row) => row.id).join(",") === "3", "third waits");
}

section("merge into penaltiesByDate does not mutate source");
{
  const existing = new Map<string, DayPenaltyInput[]>([
    ["2096-11-01", [{ caddyId: 20, profileId: 2, shift: "AM", coverage: "AM" }]],
  ]);
  const merged = mergeAssignedOccurrences(existing, [
    { id: 1, caddyId: 10, profileId: 1, date: "2096-11-02" },
  ]);
  assert(
    existing.get("2096-11-02") == null &&
      merged.get("2096-11-02")?.[0].coverage === "FULL_DAY",
    "merge copies and adds FULL_DAY"
  );
  assert(
    existing.get("2096-11-01")?.length === 1 &&
      merged.get("2096-11-01")?.length === 1,
    "original day 1 unchanged in source map"
  );
}

section("PM=2 still one occurrence per day");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02", "2096-11-03"],
    amSlots: 2,
    pmSlots: 2,
    occurrences: [
      occ(1, 10, "2096-10-01"),
      occ(2, 20, "2096-10-02"),
      occ(3, 30, "2096-10-03"),
    ],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(
    packed.assignments.map((row) => `${row.caddyId}@${row.date}`).join(",") ===
      "10@2096-11-01,20@2096-11-02,30@2096-11-03",
    "A,B,C each get their own day even when PM=2"
  );
}

section("sick skip does not invert occurrence order");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02", "2096-11-03"],
    amSlots: 2,
    pmSlots: 2,
    occurrences: [occ(1, 10, "2096-10-01"), occ(2, 20, "2096-10-02")],
    existingByDate: new Map(),
    statusByDateCaddy: new Map([
      ["2096-11-01:10", { kind: "hard_skip" as const, message: "병가" }],
    ]),
  });
  assert(
    packed.assignments.map((row) => `${row.id}@${row.date}`).join(",") ===
      "1@2096-11-02,2@2096-11-03",
    "A skips Nov 1 so B starts after A, not on Nov 1"
  );
}

section("same occurredOn two ids take consecutive days");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2096-11-01", "2096-11-02"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [occ(1, 10, "2096-10-05"), occ(2, 10, "2096-10-05")],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(
    packed.assignments.map((row) => `${row.id}@${row.date}`).join(",") ===
      "1@2096-11-01,2@2096-11-02",
    "same caddy same day 2건 → Nov 1 then Nov 2"
  );
}

section("idempotency key parse");
{
  assert(parseIdempotencyKey(undefined) == null, "omit key");
  assert(parseIdempotencyKey("req-1") === "req-1", "valid key");
  throws(
    () => parseIdempotencyKey("has space"),
    "invalid_idempotency_key",
    "spaces rejected"
  );
}

section("finalize blocked when stale or orphan penalty slots");
{
  throws(
    () =>
      assertPlanReadyToFinalize({
        needsRegeneration: true,
        generatedAt: new Date(),
        slotCount: 3,
        penaltySlots: [],
        duties: [],
        scheduledOccurrences: [],
      }),
    "regeneration_required",
    "needsRegeneration blocks finalize"
  );
  throws(
    () =>
      assertPlanReadyToFinalize({
        needsRegeneration: false,
        generatedAt: new Date(),
        slotCount: 3,
        penaltySlots: [
          { date: "2096-11-01", caddyId: 10, shift: "AM", source: "PENALTY" },
          { date: "2096-11-01", caddyId: 10, shift: "PM", source: "PENALTY" },
        ],
        duties: [],
        scheduledOccurrences: [],
      }),
    "regeneration_required",
    "orphan cancelled slots block finalize"
  );
  assertPlanReadyToFinalize({
    needsRegeneration: false,
    generatedAt: new Date(),
    slotCount: 3,
    penaltySlots: [
      { date: "2096-11-01", caddyId: 10, shift: "AM", source: "PENALTY" },
      { date: "2096-11-01", caddyId: 10, shift: "PM", source: "PENALTY" },
    ],
    duties: [],
    scheduledOccurrences: [{ date: "2096-11-01", caddyId: 10 }],
  });
  assert(true, "matching FULL_DAY pair allows finalize");
}

section("cancel / FINALIZED guards");
{
  throws(
    () => assertOccurrenceCancellable({ status: "CANCELLED" }),
    "occurrence_cancelled",
    "already cancelled"
  );
  throws(
    () =>
      assertOccurrenceCancellable({
        status: "SCHEDULED",
        planStatus: "FINALIZED",
      }),
    "finalized_locked",
    "cannot cancel scheduled on FINALIZED"
  );
  assertOccurrenceCancellable({ status: "OPEN" });
  assertOccurrenceCancellable({ status: "SCHEDULED", planStatus: "DRAFT" });
  assert(true, "OPEN and DRAFT SCHEDULED are cancellable");
  throws(
    () => assertOccurrenceTargetMutable("FINALIZED"),
    "finalized_locked",
    "cannot create targeting FINALIZED month"
  );
}

section("P1 generateMonthRotation consumes occupancy, not rotation turn");
{
  const penaltiesByDate = mergeAssignedOccurrences(new Map(), [
    { id: 1, caddyId: 10, profileId: 1, date: "2096-11-01" },
  ]);
  const generated = generateMonthRotation({
    year: 2096,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate,
    statusByDateCaddy: new Map(),
    openCredits: [],
    dates: ["2096-11-01"],
  });
  const day = generated.slots.filter((s) => s.date === "2096-11-01");
  const aSlots = day.filter((s) => s.caddyId === 10);
  assert(
    aSlots.length === 2 &&
      aSlots.every((s) => s.source === "PENALTY") &&
      aSlots.some((s) => s.shift === "AM") &&
      aSlots.some((s) => s.shift === "PM"),
    "occurrence FULL_DAY writes AM+PM PENALTY"
  );
  assert(
    day.filter((s) => s.source === "ROTATION").length === 1,
    "one rotation slot remains"
  );
  assert(
    !day.some((s) => s.source === "ROTATION" && s.caddyId === 10),
    "A does not consume a rotation turn"
  );
  assert(day.length === 3, "day still has AM2+PM1 = 3 slots");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
