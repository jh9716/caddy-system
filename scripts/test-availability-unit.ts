/**
 * 가용 엔진 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-availability-unit.ts
 */
import {
  assignmentOverlapsDay,
  compareAvailabilityRows,
  computeAvailability,
  isInactiveEmploymentAvailability,
  isSpecialPlacementText,
  normalizeCaddyType,
  parseYmd,
  type AvailabilityCaddyInput,
} from "../src/lib/availabilityEngine";

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

const baseCaddies: AvailabilityCaddyInput[] = [
  {
    id: 1,
    name: "가용A",
    team: "1조",
    teamOrder: 2,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
    extraFlags: ["주중반"],
  },
  {
    id: 2,
    name: "가용B",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
    extraFlags: [],
  },
  {
    id: 3,
    name: "3부C",
    team: "9조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "THIRD",
    extraFlags: [],
  },
  {
    id: 4,
    name: "드라이빙D",
    team: "드라이빙",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "DRIVING",
    extraFlags: ["드라이빙"],
  },
  {
    id: 5,
    name: "퇴사자",
    team: "2조",
    teamOrder: 1,
    employmentStatus: "RETIRED",
    caddyType: "HOUSE",
  },
  {
    id: 6,
    name: "휴직자",
    team: "2조",
    teamOrder: 2,
    employmentStatus: "LEAVE",
    caddyType: "HOUSE",
  },
  {
    id: 7,
    name: "휴무자",
    team: "3조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
  {
    id: 8,
    name: "특별찾근",
    team: "4조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
  {
    id: 1,
    name: "중복ID무시",
    team: "1조",
    teamOrder: 99,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
];

console.log("== helpers ==");
assert(normalizeCaddyType("third") === "THIRD", "normalize THIRD");
assert(isSpecialPlacementText("특별찾근") === true, "special 찾근");
assert(isSpecialPlacementText("고정카트") === true, "special 고정");
assert(isSpecialPlacementText("일반") === false, "not special");
const { start, end } = parseYmd("2026-08-10");
assert(
  assignmentOverlapsDay(
    { startDate: "2026-08-09T00:00:00", endDate: "2026-08-11T00:00:00" },
    start,
    end
  ),
  "overlap inclusive"
);
assert(
  !assignmentOverlapsDay(
    { startDate: "2026-08-01T00:00:00", endDate: "2026-08-02T00:00:00" },
    start,
    end
  ),
  "no overlap"
);

console.log("== computeAvailability ==");
const result = computeAvailability({
  date: "2026-08-10",
  caddies: baseCaddies,
  assignments: [
    {
      caddyId: 7,
      type: "OFF",
      startDate: "2026-08-10T00:00:00",
      endDate: "2026-08-10T23:59:59",
    },
    {
      caddyId: 3,
      type: "DUTY",
      subType: "당번A",
      startDate: "2026-08-10T00:00:00",
      endDate: "2026-08-10T23:59:59",
    },
  ],
  extraTags: [{ caddyId: 8, tag: "특별찾근", date: "2026-08-10T00:00:00" }],
});

assert(result.counts.available === 3, "available count = 3 (A,B,D)");
assert(result.counts.special === 1, "special count = 1");
assert(result.counts.excluded === 4, "excluded = 퇴사/휴직/휴무/당번");
assert(
  result.available.all.map((r) => r.id).join(",") === "2,1,4",
  "teamOrder sort 1조: B then A, then 드라이빙"
);
assert(
  result.available.byType.HOUSE.map((r) => r.id).join(",") === "2,1",
  "HOUSE only"
);
assert(result.available.byType.DRIVING.length === 1, "DRIVING bucket");
assert(result.available.byType.THIRD.length === 0, "THIRD on duty → not available");
assert(result.special[0]?.id === 8, "special id 8");
assert(
  result.available.all.every((r) => r.bucket === "available"),
  "available bucket tag"
);
assert(
  new Set(result.available.all.map((r) => r.id)).size ===
    result.available.all.length,
  "no duplicate available ids"
);

const excludedIds = new Set(result.excluded.map((r) => r.id));
assert(excludedIds.has(5) && excludedIds.has(6), "retire/leave excluded");
assert(excludedIds.has(7) && excludedIds.has(3), "OFF/DUTY excluded");
const off = result.excluded.find((r) => r.id === 7);
assert(off?.excludedReasons.some((x) => x.includes("휴무")), "OFF reason");
const a = result.available.all.find((r) => r.id === 1);
assert(a?.extraFlags.includes("주중반") === true, "extraFlags kept");

const sorted = [...result.available.all].sort(compareAvailabilityRows);
assert(
  sorted.map((r) => r.id).join(",") ===
    result.available.all.map((r) => r.id).join(","),
  "result already sorted"
);

// MARSHAL / SICK also exclude
const m = computeAvailability({
  date: "2026-08-10",
  caddies: [
    {
      id: 10,
      name: "마샬",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
    },
    {
      id: 11,
      name: "병가",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
    },
  ],
  assignments: [
    {
      caddyId: 10,
      type: "MARSHAL",
      startDate: "2026-08-10",
      endDate: "2026-08-10",
    },
    {
      caddyId: 11,
      type: "SICK",
      startDate: "2026-08-10",
      endDate: "2026-08-10",
    },
  ],
});
assert(m.counts.available === 0 && m.counts.excluded === 2, "MARSHAL/SICK exclude");

// ACCIDENT / FAMILY_EVENT also exclude from regular assignment
const af = computeAvailability({
  date: "2026-08-10",
  caddies: [
    {
      id: 20,
      name: "타구",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
    },
    {
      id: 21,
      name: "경조",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
    },
  ],
  assignments: [
    {
      caddyId: 20,
      type: "ACCIDENT",
      startDate: "2026-08-10",
      endDate: "2026-08-10",
    },
    {
      caddyId: 21,
      type: "FAMILY_EVENT",
      startDate: "2026-08-10",
      endDate: "2026-08-10",
    },
  ],
});
assert(
  af.counts.available === 0 && af.counts.excluded === 2,
  "ACCIDENT/FAMILY_EVENT exclude"
);
assert(
  af.excluded.find((r) => r.id === 20)?.excludedReasons.some((x) => x.includes("타구")),
  "ACCIDENT label"
);
assert(
  af.excluded.find((r) => r.id === 21)?.excludedReasons.some((x) => x.includes("경조")),
  "FAMILY_EVENT label"
);

assert(
  isInactiveEmploymentAvailability({ employmentStatus: "RETIRED" }),
  "RETIRED is inactive"
);
assert(
  isInactiveEmploymentAvailability({ employmentStatus: "LEAVE" }),
  "LEAVE is inactive"
);
assert(
  !isInactiveEmploymentAvailability({
    employmentStatus: "ACTIVE",
    excludedReasons: ["휴무"],
  }),
  "당일 휴무 ACTIVE는 후보에서 재직 제외가 아님"
);
assert(
  isInactiveEmploymentAvailability({
    excludedReasons: ["퇴사(RETIRED)"],
  }),
  "excludedReasons 퇴사도 inactive"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
