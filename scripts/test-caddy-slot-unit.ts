/**
 * 고정 슬롯 규칙 단위 테스트 (DB 없음)
 * npx tsx scripts/test-caddy-slot-unit.ts
 */
import {
  DEFAULT_SLOT_CAPACITY,
  assertSlotAvailable,
  assertSlotWithinConfiguredCapacity,
  findSlotHoldingConflicts,
  findSlotOccupant,
  getConfiguredSlotCapacity,
  isSlotHoldingStatus,
  listEmptySlots,
  listSelectableEmptySlots,
  observedMaxTeamOrder,
  resolveEffectiveSlotCount,
  resolveGridSlotCount,
  resolveSelectableSlotCount,
  SlotOccupiedError,
  SlotOutOfRangeError,
} from "../src/lib/caddySlot";
import { buildTeamSlotGrid } from "../src/lib/availabilitySlotGrid";
import {
  BLOCKING_ASSIGNMENT_TYPES,
  computeAvailability,
} from "../src/lib/availabilityEngine";
import { caddyCreateSchema } from "../src/lib/caddySchema";

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

function section(t: string) {
  console.log("\n==", t, "==");
}

section("slot holding");
assert(isSlotHoldingStatus("ACTIVE"), "ACTIVE holds");
assert(isSlotHoldingStatus("LEAVE"), "LEAVE holds");
assert(!isSlotHoldingStatus("RETIRED"), "RETIRED does not hold");

section("capacity resolver");
assert(DEFAULT_SLOT_CAPACITY === 24, "default capacity 24");
assert(getConfiguredSlotCapacity("1조") === 24, "team uses default 24");
assert(resolveSelectableSlotCount("1조") === 24, "selectable = capacity");
assert(
  resolveEffectiveSlotCount("1조", [{ teamOrder: 17 }]) === 24,
  "capacity=24 / max occupied=17 → effective 24"
);
assert(
  resolveEffectiveSlotCount("1조", [{ teamOrder: 26 }]) === 26,
  "observed 26 > capacity → effective 26 (no hide)"
);
assert(
  resolveGridSlotCount(
    ["1조", "2조"],
    [
      { team: "1조", teamOrder: 17 },
      { team: "2조", teamOrder: 5 },
    ]
  ) === 24,
  "grid maxSlot 24 when observed≤24"
);
assert(
  resolveGridSlotCount(["1조"], [{ team: "1조", teamOrder: 26 }]) === 26,
  "grid expands for over-capacity data"
);

section("occupancy / empty / selectable");
const peers = [
  {
    id: 1,
    name: "김A",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
  },
  {
    id: 2,
    name: "김B",
    team: "1조",
    teamOrder: 2,
    employmentStatus: "RETIRED",
  },
  {
    id: 3,
    name: "김C",
    team: "1조",
    teamOrder: 3,
    employmentStatus: "LEAVE",
  },
];
assert(findSlotOccupant(peers, "1조", 1)?.name === "김A", "slot1 ACTIVE");
assert(findSlotOccupant(peers, "1조", 2) == null, "RETIRED not occupant");
assert(findSlotOccupant(peers, "1조", 3)?.name === "김C", "slot3 LEAVE");
assert(
  JSON.stringify(listEmptySlots(peers, "1조", 4)) === JSON.stringify([2, 4]),
  "empty 2 and 4"
);

const selectable = listSelectableEmptySlots(peers, "1조");
assert(selectable.includes(2), "mid empty selectable");
assert(selectable.includes(7), "empty 7 selectable (same-team move target)");
assert(selectable.includes(24), "slot 24 selectable for new entry");
assert(!selectable.includes(25), "25 not selectable (over capacity)");
assert(selectable.includes(4), "empty 4 in capacity range");
assert(!selectable.includes(1) && !selectable.includes(3), "occupied not selectable");

section("DRIVING does not consume HOUSE slots");
{
  const mixed = [
    ...peers,
    {
      id: 90,
      name: "드라이브",
      team: "1조",
      teamOrder: 4,
      employmentStatus: "ACTIVE",
      caddyType: "DRIVING",
    },
    {
      id: 91,
      name: "전담",
      team: "드라이빙",
      teamOrder: 0,
      employmentStatus: "ACTIVE",
      caddyType: "DRIVING",
    },
  ];
  assert(findSlotOccupant(mixed, "1조", 4) == null, "DRIVING on 1조 4 not occupant");
  assert(listSelectableEmptySlots(mixed, "1조").includes(4), "slot 4 still empty");
}

try {
  assertSlotAvailable(peers, "1조", 1);
  assert(false, "should block occupied");
} catch (e) {
  assert(e instanceof SlotOccupiedError, "SlotOccupiedError on ACTIVE");
}
assertSlotAvailable(peers, "1조", 2);
assert(true, "RETIRED slot reusable");
assertSlotAvailable(peers, "1조", 7);
assert(true, "empty 7 available for same-team move");

try {
  assertSlotWithinConfiguredCapacity("1조", 25);
  assert(false, "25 should be out of range");
} catch (e) {
  assert(e instanceof SlotOutOfRangeError, "SlotOutOfRangeError on 25");
}
assertSlotWithinConfiguredCapacity("1조", 24);
assert(true, "24 within capacity");
assertSlotWithinConfiguredCapacity("1조", 26, {
  allowCurrentOverCapacity: 26,
});
assert(true, "allow keep over-capacity current");

section("conflicts ACTIVE+LEAVE");
const conflicts = findSlotHoldingConflicts([
  { id: 1, name: "A", team: "1조", teamOrder: 2, emp: "ACTIVE" },
  { id: 2, name: "B", team: "1조", teamOrder: 2, emp: "LEAVE" },
  { id: 3, name: "C", team: "1조", teamOrder: 2, emp: "RETIRED" },
]);
assert(conflicts.length === 1, "one conflict");
assert(conflicts[0].names.includes("A") && conflicts[0].names.includes("B"), "A+B");
assert(!conflicts[0].names.includes("C"), "RETIRED not in conflict names");

section("create schema requires slot");
const bad = caddyCreateSchema.safeParse({ name: "테스트", team: "1조" });
assert(!bad.success, "teamOrder required");
const ok = caddyCreateSchema.safeParse({
  name: "테스트",
  team: "1조",
  teamOrder: 2,
});
assert(ok.success, "explicit slot ok");

section("blocking includes ACCIDENT / FAMILY_EVENT");
assert(
  (BLOCKING_ASSIGNMENT_TYPES as readonly string[]).includes("ACCIDENT"),
  "ACCIDENT blocking"
);
assert(
  (BLOCKING_ASSIGNMENT_TYPES as readonly string[]).includes("FAMILY_EVENT"),
  "FAMILY_EVENT blocking"
);

section("slot grid trailing empty / capacity");
const av = computeAvailability({
  date: "2026-08-15",
  caddies: [
    {
      id: 1,
      name: "김A",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
    },
    {
      id: 2,
      name: "김B",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "RETIRED",
    },
    {
      id: 3,
      name: "김C",
      team: "1조",
      teamOrder: 3,
      employmentStatus: "LEAVE",
    },
    {
      id: 4,
      name: "김D",
      team: "1조",
      teamOrder: 4,
      employmentStatus: "ACTIVE",
    },
    {
      id: 17,
      name: "김Q",
      team: "1조",
      teamOrder: 17,
      employmentStatus: "ACTIVE",
    },
  ],
  assignments: [
    {
      caddyId: 4,
      type: "OFF",
      startDate: new Date("2026-08-15T00:00:00"),
      endDate: new Date("2026-08-15T23:59:59"),
    },
  ],
});
const grid = buildTeamSlotGrid({
  availability: av,
  occupants: [
    {
      id: 1,
      name: "김A",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
    },
    {
      id: 2,
      name: "김B",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "RETIRED",
    },
    {
      id: 3,
      name: "김C",
      team: "1조",
      teamOrder: 3,
      employmentStatus: "LEAVE",
    },
    {
      id: 4,
      name: "김D",
      team: "1조",
      teamOrder: 4,
      employmentStatus: "ACTIVE",
    },
    {
      id: 17,
      name: "김Q",
      team: "1조",
      teamOrder: 17,
      employmentStatus: "ACTIVE",
    },
    {
      id: 90,
      name: "드라이브",
      team: "1조",
      teamOrder: 18,
      employmentStatus: "ACTIVE",
      caddyType: "DRIVING",
    },
    {
      id: 91,
      name: "전담",
      team: "드라이빙",
      teamOrder: 0,
      employmentStatus: "ACTIVE",
      caddyType: "DRIVING",
    },
  ],
});
const t1 = grid.teams.find((t) => t.team === "1조")!;
assert(grid.maxSlot === 24, "capacity=24 / max occupied=17 → render 1~24");
assert(t1.slots.length === 24, "1조 has 24 slot cells");
assert(t1.slots[0].kind === "available" && t1.slots[0].name === "김A", "1 available");
assert(t1.slots[1].kind === "empty", "2 empty (RETIRED)");
assert(t1.slots[2].kind === "leave" && t1.slots[2].name === "김C", "3 leave");
assert(t1.slots[3].kind === "excluded", "4 excluded OFF");
assert(t1.slots[16].kind === "available" && t1.slots[16].name === "김Q", "17 occupied");
assert(t1.slots[17].kind === "empty", "18 trailing empty (DRIVING ignored)");
assert(t1.slots[23].kind === "empty", "24 trailing empty");
assert(grid.teams.length === 12, "12 teams");
assert(
  !grid.teams.some((t) => t.team === "드라이빙"),
  "slot grid has no 드라이빙 column"
);
assert(observedMaxTeamOrder([{ teamOrder: 17 }]) === 17, "max order 17");

const af = computeAvailability({
  date: "2026-08-15",
  caddies: [
    {
      id: 50,
      name: "사고",
      team: "1조",
      teamOrder: 5,
      employmentStatus: "ACTIVE",
    },
    {
      id: 51,
      name: "경조",
      team: "1조",
      teamOrder: 6,
      employmentStatus: "ACTIVE",
    },
  ],
  assignments: [
    {
      caddyId: 50,
      type: "ACCIDENT",
      startDate: "2026-08-15",
      endDate: "2026-08-15",
    },
    {
      caddyId: 51,
      type: "FAMILY_EVENT",
      startDate: "2026-08-15",
      endDate: "2026-08-15",
    },
  ],
});
assert(af.counts.available === 0 && af.counts.excluded === 2, "ACCIDENT/FAMILY_EVENT exclude");
assert(
  af.excluded.some((r) => r.id === 50 && r.excludedReasons.some((x) => x.includes("타구"))),
  "ACCIDENT reason"
);
assert(
  af.excluded.some((r) => r.id === 51 && r.excludedReasons.some((x) => x.includes("경조"))),
  "FAMILY_EVENT reason"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
