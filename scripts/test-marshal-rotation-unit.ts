/**
 * 마샬 월 순환 P2 — 순수 엔진/계약 (production write 없음)
 * 실행: npm run test:marshal-rotation-unit
 */
import fs from "node:fs";
import path from "node:path";
import { MarshalRosterError, assertUniqueActiveRotationOrders } from "../src/lib/marshalDomain";
import {
  assertPlanMutable,
  assertReplaceConfirmed,
  assertSlotMatchesPlan,
  assertSubstituteChangesCaddy,
  canonicalOriginalCaddyId,
  classifyMarshalDayStatus,
  generateMonthRotation,
  inheritStartPendingProfileIds,
  listMonthYmds,
  nextCursorOrder,
  orderedActiveMembers,
  previousYearMonth,
  resolvePendingMembers,
  type RotationMember,
} from "../src/lib/marshalRotationDomain";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function throws(fn: () => void, code: string, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof MarshalRosterError && e.code === code, msg);
  }
}

function member(
  order: number,
  name: string,
  id = order
): RotationMember {
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

function namesOn(slots: { date: string; caddyId: number; source: string }[], date: string) {
  return slots
    .filter((s) => s.date === date)
    .map((s) => roster.find((m) => m.caddyId === s.caddyId)?.name || String(s.caddyId))
    .sort()
    .join(",");
}

function sourcesOn(slots: { date: string; source: string }[], date: string) {
  return slots
    .filter((s) => s.date === date)
    .map((s) => s.source)
    .sort()
    .join(",");
}

section("rotation order uniqueness");
assertUniqueActiveRotationOrders([
  { id: 1, active: true, rotationOrder: 1 },
  { id: 2, active: true, rotationOrder: 2 },
  { id: 3, active: false, rotationOrder: 1 },
]);
assert(true, "inactive may reuse order");
throws(
  () =>
    assertUniqueActiveRotationOrders([
      { id: 1, active: true, rotationOrder: 1 },
      { id: 2, active: true, rotationOrder: 1 },
    ]),
  "duplicate_rotation_order",
  "active duplicate rejected"
);

section("month-to-month cursor + wrap");
{
  const nov = generateMonthRotation({
    year: 2026,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const first = nov.slots.filter((s) => s.date === "2026-11-01");
  const second = nov.slots.filter((s) => s.date === "2026-11-02");
  assert(namesOn(nov.slots, "2026-11-01") === "A,B,C", "day1 1,2,3");
  assert(namesOn(nov.slots, "2026-11-02") === "D,E,F", "day2 4,5,6");
  assert(nov.nextRotationOrder === 1, "after 6 wrap to 1");
  assert(nov.nextPendingProfileIds.length === 0, "no month-end pending without collision");
  const day1Ids = first.map((s) => s.caddyId);
  assert(new Set(day1Ids).size === 3, "same-day duplicate 없음");
  const aDays = nov.slots.filter((s) => s.caddyId === 10).map((s) => s.date);
  assert(aDays.includes("2026-11-01") && aDays.includes("2026-11-07"), "consecutive cycle 허용");

  const dec = generateMonthRotation({
    year: 2026,
    month: 12,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 4,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(namesOn(dec.slots, "2026-12-01") === "D,E,F", "next month starts at 4");
  assert(previousYearMonth(2026, 1).month === 12, "prev month wrap");
}

section("AM2/PM1 and AM2/PM2");
{
  const am2pm1 = generateMonthRotation({
    year: 2026,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const d1 = am2pm1.slots.filter((s) => s.date === "2026-11-01");
  assert(d1.filter((s) => s.shift === "AM").length === 2, "AM2");
  assert(d1.filter((s) => s.shift === "PM").length === 1, "PM1");

  const am2pm2 = generateMonthRotation({
    year: 2026,
    month: 11,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 2,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const d1b = am2pm2.slots.filter((s) => s.date === "2026-11-01");
  assert(d1b.filter((s) => s.shift === "AM").length === 2, "AM2 configurable");
  assert(d1b.filter((s) => s.shift === "PM").length === 2, "PM2 configurable");
  assert(d1b.length === 4, "day capacity 4");
}

section("OFF does not skip");
{
  const status = new Map<string, { kind: "off_conflict" | "hard_skip" | "ok"; message: string | null }>();
  status.set("2026-11-01:20", { kind: "off_conflict", message: "휴무 충돌" });
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: status,
    openCredits: [],
  });
  assert(namesOn(out.slots, "2026-11-01") === "A,B,C", "OFF keeps 1,2,3");
  const b = out.slots.find((s) => s.date === "2026-11-01" && s.caddyId === 20);
  assert(b?.warning === "휴무 충돌", "OFF conflict warning");
}

section("hard skip SICK / LONG_SICK / LEAVE");
{
  const sick = new Map<string, { kind: "hard_skip" | "ok"; message: string | null }>();
  sick.set("2026-11-01:20", { kind: "hard_skip", message: "병가" });
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: sick,
    openCredits: [],
  });
  assert(namesOn(out.slots, "2026-11-01") === "A,C,D", "SICK skips 2 → 1,3,4");
  assert(out.slots.find((s) => s.date === "2026-11-02" && s.caddyId === 50), "next starts 5");
  assert(
    classifyMarshalDayStatus({
      employmentStatus: "ACTIVE",
      overlappingTypes: ["LONG_SICK"],
      isEffectiveOff: false,
    }).kind === "hard_skip",
    "LONG_SICK hard skip"
  );
  assert(
    classifyMarshalDayStatus({
      employmentStatus: "LEAVE",
      overlappingTypes: [],
      isEffectiveOff: false,
    }).kind === "hard_skip",
    "LEAVE hard skip"
  );
  assert(
    classifyMarshalDayStatus({
      employmentStatus: "RETIRED",
      overlappingTypes: [],
      isEffectiveOff: false,
    }).kind === "hard_skip",
    "RETIRED hard skip"
  );
}

section("penalty does not consume rotation");
{
  const out = generateMonthRotation({
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
  assert(namesOn(out.slots, "2026-11-01") === "C,E,F", "C(벌당) + 5 + 6");
  assert(sourcesOn(out.slots, "2026-11-01").includes("PENALTY"), "penalty source");
  assert(out.nextRotationOrder === 1, "next=1 after 5,6");
  const xSlot = out.slots.find((s) => s.caddyId === 30);
  assert(xSlot?.source === "PENALTY" && xSlot.shift === "PM", "penalty shift fixed");
  const two = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    members: roster,
    dates: ["2026-11-01", "2026-11-02"],
    penaltiesByDate: new Map([
      ["2026-11-01", [{ caddyId: 30, profileId: 3, shift: "PM" as const }]],
    ]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const cDay2 = two.slots.find((s) => s.date === "2026-11-02" && s.caddyId === 30);
  assert(cDay2?.source === "ROTATION", "penalty does not skip later normal turn");
}

section("penalty === current rotation turn is deferred");
{
  const four = [
    member(1, "A"),
    member(2, "B"),
    member(3, "C"),
    member(4, "D"),
  ];
  const out = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: four,
    dates: ["2026-11-01", "2026-11-02"],
    penaltiesByDate: new Map([
      ["2026-11-01", [{ caddyId: 10, profileId: 1, shift: "AM" as const }]],
    ]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const day1 = out.slots.filter((s) => s.date === "2026-11-01");
  const day2 = out.slots.filter((s) => s.date === "2026-11-02");
  assert(namesOn(out.slots, "2026-11-01") === "A,B,C", "day1 A벌당 + B + C");
  assert(
    day1.find((s) => s.caddyId === 10)?.source === "PENALTY",
    "A is penalty not rotation on collision day"
  );
  assert(
    day1.filter((s) => s.source === "ROTATION").map((s) => s.caddyId).sort().join(",") ===
      "20,30",
    "collision day rotation is B,C only"
  );
  const aDay2 = day2.find((s) => s.caddyId === 10);
  assert(aDay2?.source === "ROTATION", "A normal turn deferred to next day");
  assert(
    !day1.some((s) => s.source === "ROTATION" && s.caddyId === 10),
    "A does not consume rotation slot the penalty day"
  );
  assert(out.nextPendingProfileIds.length === 0, "mid-month collision leaves month-end pending 0");
}

section("month-boundary pending carry");
{
  const lastDay = generateMonthRotation({
    year: 2026,
    month: 10,
    startRotationOrder: 1,
    members: roster,
    dates: ["2026-10-31"],
    penaltiesByDate: new Map([
      ["2026-10-31", [{ caddyId: 10, profileId: 1, shift: "AM" as const }]],
    ]),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(
    lastDay.nextPendingProfileIds.join(",") === "1",
    "final-day penalty=current-turn carries A"
  );
  assert(lastDay.nextRotationOrder === 4, "cursor after B,C is D/E start 4");
  assert(
    lastDay.slots.find((s) => s.caddyId === 10)?.source === "PENALTY",
    "Oct 31 A is penalty"
  );

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
  const nov1 = nextMonth.slots.filter((s) => s.date === "2026-11-01");
  assert(
    nov1.find((s) => s.caddyId === 10)?.source === "ROTATION",
    "pending A is ROTATION before cursor"
  );
  assert(namesOn(nextMonth.slots, "2026-11-01") === "A,D,E", "A then D,E; B/C not replayed");

  const multi = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    startPendingProfileIds: [1, 3],
    members: roster,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(namesOn(multi.slots, "2026-11-01") === "A,C,E", "pending A,C then cursor E");
  assert(
    !multi.slots.some((s) => s.caddyId === 20 || s.caddyId === 40),
    "B,D not reassigned after being consumed"
  );

  const first = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    startPendingProfileIds: [1, 3],
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const second = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    startPendingProfileIds: [1, 3],
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(
    JSON.stringify(first.slots) === JSON.stringify(second.slots) &&
      JSON.stringify(first.nextPendingProfileIds) ===
        JSON.stringify(second.nextPendingProfileIds),
    "regenerate identical pending+cursor is deterministic"
  );

  assert(
    inheritStartPendingProfileIds({
      hasGeneratedPlan: false,
      previousFinalizedNextPending: [1, 3],
    }).join(",") === "1,3",
    "previous FINALIZED carry auto inherit"
  );
  assert(
    inheritStartPendingProfileIds({
      hasGeneratedPlan: true,
      storedStartPendingProfileIds: [1, 3],
      previousFinalizedNextPending: [9],
    }).join(",") === "1,3",
    "regenerate keeps stored start pending"
  );
  assert(
    inheritStartPendingProfileIds({
      hasGeneratedPlan: false,
      previousFinalizedNextPending: [],
    }).length === 0,
    "first month pending empty"
  );

  const reordered = [
    member(2, "B", 2),
    member(3, "C", 3),
    member(4, "D", 4),
    member(5, "E", 5),
    member(6, "F", 6),
    member(9, "A", 1),
  ];
  const byIdentity = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 5,
    startPendingProfileIds: [1],
    members: reordered,
    dates: ["2026-11-01"],
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(
    byIdentity.slots.find((s) => s.profileId === 1)?.source === "ROTATION",
    "pending identity follows profileId after order change"
  );
  assert(
    byIdentity.slots.filter((s) => s.date === "2026-11-01").map((s) => s.profileId).includes(1),
    "A profile still assigned first from pending"
  );
  assert(
    resolvePendingMembers([1, 99, 3], roster).map((m) => m.profileId).join(",") === "1,3",
    "missing pending profile is consumed without rewind"
  );
}

section("substitute credit skips one future turn and can cross month");
{
  const first = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [{ id: 7, profileId: 1 }],
  });
  assert(!namesOn(first.slots, "2026-11-01").includes("A"), "A credit skip day1");
  assert(namesOn(first.slots, "2026-11-01") === "B,C,D", "skip A → 2,3,4");
  assert(first.consumedCredits[0]?.creditId === 7, "credit consumed once");
  assert(first.slots.some((s) => s.caddyId === 10), "A still works later this month");

  const leftover = generateMonthRotation({
    year: 2026,
    month: 12,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [{ id: 8, profileId: 3 }],
  });
  assert(!namesOn(leftover.slots, "2026-12-01").includes("C"), "credit crosses month");
}

section("AM/PM fairness among selected + deterministic");
{
  const a = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  const b = generateMonthRotation({
    year: 2026,
    month: 11,
    startRotationOrder: 1,
    members: roster,
    penaltiesByDate: new Map(),
    statusByDateCaddy: new Map(),
    openCredits: [],
  });
  assert(
    JSON.stringify(a.slots) === JSON.stringify(b.slots),
    "deterministic generation"
  );
  const am = new Map<number, number>();
  const pm = new Map<number, number>();
  for (const slot of a.slots) {
    if (slot.source !== "ROTATION") continue;
    if (slot.shift === "AM") am.set(slot.caddyId, (am.get(slot.caddyId) || 0) + 1);
    else pm.set(slot.caddyId, (pm.get(slot.caddyId) || 0) + 1);
  }
  const amVals = [...am.values()];
  const pmVals = [...pm.values()];
  assert(Math.max(...amVals) - Math.min(...amVals) <= 2, "AM counts bounded");
  assert(Math.max(...pmVals) - Math.min(...pmVals) <= 2, "PM counts bounded");
}

section("substitute integrity + route plan guard");
{
  assert(canonicalOriginalCaddyId({ caddyId: 1, originalCaddyId: null }) === 1, "first original=A");
  assert(
    canonicalOriginalCaddyId({ caddyId: 2, originalCaddyId: 1 }) === 1,
    "A->B keeps original A"
  );
  assert(
    canonicalOriginalCaddyId({ caddyId: 3, originalCaddyId: 1 }) === 1,
    "A->B->C original stays A"
  );
  throws(
    () => assertSubstituteChangesCaddy(1, 1),
    "substitute_unchanged",
    "A->A cannot earn credit"
  );
  assertSubstituteChangesCaddy(1, 2);
  assert(true, "A->B substitute allowed");
  throws(
    () => assertSlotMatchesPlan(11, 99),
    "slot_plan_mismatch",
    "wrong planId + valid slotId rejected"
  );
  assertSlotMatchesPlan(11, 11);
  assert(true, "matching planId accepted");
  const slotRoute = read("src/app/api/marshals/plans/[id]/slots/[slotId]/route.ts");
  const service = read("src/lib/marshalRotationService.ts");
  assert(slotRoute.includes("planId: resolved.id"), "route passes planId");
  assert(service.includes("assertSlotMatchesPlan(slot.planId, planId)"), "service checks planId");
  assert(service.includes("originalScheduledCaddyId"), "audit keeps scheduled original");
  assert(service.includes("fromCaddyId"), "audit keeps immediate from");
  const replaceFn = service.slice(
    service.indexOf("export async function replaceMonthSlot"),
    service.indexOf("export async function createPenaltyDuty")
  );
  assert(!replaceFn.includes("finalized_locked"), "FINALIZED slot substitute remains allowed");
}

section("fail-closed + overwrite guards");
{
  throws(
    () =>
      generateMonthRotation({
        year: 2026,
        month: 11,
        startRotationOrder: 1,
        members: [member(1, "A")],
        penaltiesByDate: new Map(),
        statusByDateCaddy: new Map(),
        openCredits: [],
      }),
    "insufficient_marshals",
    "too few marshals fail-closed"
  );
  throws(() => assertReplaceConfirmed(false, true), "draft_exists", "draft overwrite protected");
  assertReplaceConfirmed(true, true);
  throws(() => assertPlanMutable("FINALIZED", "generate"), "finalized_locked", "FINALIZED regeneration remains rejected");
  assert(listMonthYmds(2026, 11).length === 30, "november days");
  assert(nextCursorOrder(orderedActiveMembers(roster), 6) === 1, "wrap 30→1 style");
}

section("classify OFF vs hard");
{
  assert(
    classifyMarshalDayStatus({
      employmentStatus: "ACTIVE",
      overlappingTypes: ["OFF"],
      isEffectiveOff: true,
    }).kind === "off_conflict",
    "OFF conflict"
  );
  assert(
    classifyMarshalDayStatus({
      employmentStatus: "ACTIVE",
      overlappingTypes: ["SICK"],
      isEffectiveOff: true,
    }).kind === "hard_skip",
    "SICK wins over OFF"
  );
}

section("source contracts");
{
  const engine = read("src/lib/autoAssignEngine.ts");
  const cart = read("src/lib/cartManage.ts");
  const rotation = read("src/lib/marshalRotationDomain.ts");
  const service = read("src/lib/marshalRotationService.ts");
  const schema = read("prisma/schema.prisma");
  assert(engine.includes("computeAutoAssignmentsV1"), "autoAssignEngine intact");
  assert(!service.includes("dailyOpsDuty"), "rotation service DailyOpsDuty 0");
  assert(!service.includes("computeAutoAssignmentsV1"), "no engine import");
  assert(!rotation.includes("Math.random"), "no Math.random");
  assert(schema.includes("model MarshalMonthPlan"), "plan model");
  assert(schema.includes("model MarshalMonthSlot"), "slot model");
  assert(schema.includes("model MarshalPenaltyDuty"), "penalty model");
  assert(schema.includes("model MarshalRotationCredit"), "credit model");
  assert(schema.includes("rotationOrder"), "roster order field");
  assert(schema.includes("startPendingProfileIds"), "start pending field");
  assert(schema.includes("nextPendingProfileIds"), "next pending field");
  assert(service.includes("inheritStartPendingProfileIds"), "service inherits previous pending");
  assert(service.includes("startPendingProfileIds"), "service stores start pending");
  assert(service.includes("nextPendingProfileIds"), "service stores next pending");
  assert(read("src/app/manage/marshals/schedule/page.tsx").includes("이월 대기"), "UI carry hint");
  assert(
    read("prisma/migrations/20261013120000_marshal_month_rotation_p2/migration.sql").includes(
      "startPendingProfileIds"
    ),
    "p2 migration has pending columns"
  );
  assert(cart.includes("dormitoryResident") || cart.includes("Cart"), "cart domain still present");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_ROTATION_ORDER_CHANGE"), "order audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_MONTH_GENERATE"), "generate audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_MONTH_SLOT_CHANGE"), "slot audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_SUBSTITUTE"), "sub audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_PENALTY_CREATE"), "penalty audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_ADJUSTMENT_CHANGE"), "credit audit");
  assert(read("src/lib/marshalDomain.ts").includes("MARSHAL_MONTH_FINALIZE"), "finalize audit");
}

section("git protected files");
{
  const { spawnSync } = await import("node:child_process");
  const names = String(
    spawnSync(
      "git",
      [
        "diff",
        "--name-only",
        "origin/main",
        "--",
        "src/lib/autoAssignEngine.ts",
        "src/lib/opsDutyEffective.ts",
        "src/lib/cartManage.ts",
        "src/lib/cartService.ts",
      ],
      { encoding: "utf8" }
    ).stdout || ""
  ).trim();
  assert(names === "", `protected files 0 (${names || "clean"})`);
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
