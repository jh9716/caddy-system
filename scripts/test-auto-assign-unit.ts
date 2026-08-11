/**
 * 자동배치 v1 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-auto-assign-unit.ts
 */

import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  compareReservationOrder,
  COURSE_ORDER,
  findEarliest54HolePair,
  findOneThreePair,
  findOneTwoPair,
  isCompatible54HolePair,
  isCompatibleOneThreePair,
  isCompatibleOneTwoPair,
  minutesBetweenReservations,
  normalizeOpenCourses,
  reasonForFixedType,
  reflowRegularAssignments,
  reservationKey,
  REASON,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";

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

function makeCaddies(n: number, startId = 1): AutoAssignCaddy[] {
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < n; i++) {
    const id = startId + i;
    const teamNum = (i % 12) + 1;
    out.push({
      id,
      name: `캐디${id}`,
      team: `${teamNum}조`,
      teamOrder: Math.floor(i / 12) + 1,
    });
  }
  return out.sort(compareCaddyOrder);
}

function makeReservations(
  date: string,
  specs: Array<{ shift: "1부" | "2부" | "3부"; count: number; teeStart?: string }>
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  let row = 2;
  for (const spec of specs) {
    const [hh, mm] = (spec.teeStart || "06:00").split(":").map(Number);
    for (let i = 0; i < spec.count; i++) {
      const total = hh * 60 + mm + i * 7;
      const h = String(Math.floor(total / 60) % 24).padStart(2, "0");
      const m = String(total % 60).padStart(2, "0");
      out.push({
        date,
        course: "VERTHILL",
        courseLabel: "베르힐",
        shift: spec.shift,
        teeTime: `${h}:${m}`,
        teamName: `${spec.shift}팀${i + 1}`,
        rawRowIndex: row++,
      });
    }
  }
  return out;
}

section("캐디 > 예약");
{
  const date = "2026-08-20";
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(10),
    special: [{ id: 999, name: "특별", team: "1조", teamOrder: 0 }],
    reservations: makeReservations(date, [{ shift: "1부", count: 3 }]),
  });
  assert(result.assignments.length === 3, "assigned 3");
  assert(result.unusedCaddies.length === 7, "unused 7");
  assert(result.unassignedReservations.length === 0, "no unassigned");
  assert(result.special.length === 1 && result.special[0].id === 999, "special passthrough");
  assert(
    result.assignments.every((a) => a.caddy.id !== 999),
    "special not assigned"
  );
}

section("캐디 < 예약");
{
  const date = "2026-08-21";
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(5),
    reservations: makeReservations(date, [{ shift: "1부", count: 8 }]),
  });
  assert(result.assignments.length === 5, "assign all 5 caddies");
  assert(result.unassignedReservations.length === 3, "3 unassigned");
  assert(result.unusedCaddies.length === 0, "no unused");
  const ids = result.assignments.map((a) => a.caddy.id);
  assert(new Set(ids).size === ids.length, "no duplicate caddy in shift");
}

section("1부→2부 순번 이어짐");
{
  const date = "2026-08-22";
  const available = makeCaddies(5);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: makeReservations(date, [
      { shift: "1부", count: 3 },
      { shift: "2부", count: 2 },
    ]),
  });
  const ordered = [...available].sort(compareCaddyOrder);
  assert(result.assignments.length === 5, "5 assigned");
  assert(result.assignments[0].caddy.id === ordered[0].id, "1부 starts at seq0");
  assert(result.assignments[2].caddy.id === ordered[2].id, "1부 third");
  assert(result.assignments[3].shift === "2부", "4th is 2부");
  assert(
    result.assignments[3].caddy.id === ordered[3].id,
    "2부 continues at seq3"
  );
  assert(result.assignments[4].caddy.id === ordered[4].id, "2부 next");
  assert(result.meta.finalPointer === 0, "pointer wrapped to 0");
}

section("1부 80 / 2부 80 / 캐디 100");
{
  const date = "2026-08-23";
  const available = makeCaddies(100);
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: makeReservations(date, [
      { shift: "1부", count: 80 },
      { shift: "2부", count: 80 },
    ]),
  });
  assert(result.assignments.length === 160, "160 assignments");
  assert(result.unassignedReservations.length === 0, "none unassigned");
  assert(result.unusedCaddies.length === 0, "all caddies used across shifts");
  assert(result.meta.byShift["1부"].assigned === 80, "1부 80");
  assert(result.meta.byShift["2부"].assigned === 80, "2부 80");

  const shift1 = result.assignments.filter((a) => a.shift === "1부");
  const shift2 = result.assignments.filter((a) => a.shift === "2부");
  assert(shift1[0].caddy.id === ordered[0].id, "1부 first = seq0");
  assert(shift1[79].caddy.id === ordered[79].id, "1부 last = seq79");
  assert(shift2[0].caddy.id === ordered[80].id, "2부 starts seq80");
  assert(shift2[19].caddy.id === ordered[99].id, "2부 20th = seq99");
  assert(shift2[20].caddy.id === ordered[0].id, "2부 wraps to seq0");
  assert(shift2[79].caddy.id === ordered[59].id, "2부 last = seq59");

  // 같은 부 중복 없음
  assert(
    new Set(shift1.map((a) => a.caddy.id)).size === 80,
    "1부 unique caddies"
  );
  assert(
    new Set(shift2.map((a) => a.caddy.id)).size === 80,
    "2부 unique caddies"
  );
}

section("3부 포함");
{
  const date = "2026-08-24";
  const available = makeCaddies(10);
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: makeReservations(date, [
      { shift: "1부", count: 4 },
      { shift: "2부", count: 4 },
      { shift: "3부", count: 4 },
    ]),
  });
  assert(result.assignments.length === 12, "12 assigned with wrap");
  assert(result.meta.byShift["3부"].assigned === 4, "3부 4");
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  // pointer after 1+2 = 8, so 3부 starts at index 8
  assert(s3[0].caddy.id === ordered[8].id, "3부 continues pointer");
  assert(s3[2].caddy.id === ordered[0].id, "3부 wraps");
}

section("중복 캐디 방지 (부 내)");
{
  const date = "2026-08-25";
  const available = makeCaddies(3);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: makeReservations(date, [{ shift: "1부", count: 5 }]),
  });
  const ids = result.assignments.map((a) => a.caddy.id);
  assert(ids.length === 3, "only 3 assigned");
  assert(new Set(ids).size === 3, "unique in shift");
  assert(result.unassignedReservations.length === 2, "2 left unassigned");
}

section("빈 예약");
{
  const result = computeAutoAssignmentsV1({
    date: "2026-08-26",
    available: makeCaddies(5),
    reservations: [],
  });
  assert(result.assignments.length === 0, "no assignments");
  assert(result.unusedCaddies.length === 5, "all unused");
  assert(result.meta.reservationCount === 0, "0 reservations");
}

section("빈 가용목록");
{
  const date = "2026-08-27";
  const result = computeAutoAssignmentsV1({
    date,
    available: [],
    reservations: makeReservations(date, [{ shift: "1부", count: 2 }]),
  });
  assert(result.assignments.length === 0, "nothing assigned");
  assert(result.unassignedReservations.length === 2, "all unassigned");
  assert(
    result.unassignedReservations.every((u) => u.reason.includes("가용")),
    "reason 가용 없음"
  );
}

section("needsReview / teeTime 정렬");
{
  const date = "2026-08-28";
  const available = makeCaddies(4);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "후",
        rawRowIndex: 3,
      },
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "06:30",
        teamName: "선",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "06:40",
        teamName: "리뷰",
        needsReview: true,
        reviewReasons: ["잘못된 시간 형식"],
        rawRowIndex: 4,
      },
    ],
  });
  assert(result.assignments.length === 2, "2 assigned");
  assert(result.assignments[0].reservation.teamName === "선", "earlier tee first");
  assert(result.assignments[1].reservation.teamName === "후", "later tee second");
  assert(result.unassignedReservations.length === 1, "review unassigned");
  assert(
    result.unassignedReservations[0].reason.includes("needsReview"),
    "needsReview reason"
  );
}

section("available 입력 중복 id 제거");
{
  const date = "2026-08-29";
  const c = makeCaddies(2);
  const result = computeAutoAssignmentsV1({
    date,
    available: [...c, c[0]],
    reservations: makeReservations(date, [{ shift: "1부", count: 2 }]),
  });
  assert(result.meta.availableCount === 2, "deduped to 2");
  assert(result.assignments.length === 2, "still 2 assigned");
}

section("54홀: 6시간 이상 간격 허용");
{
  const a = { date: "2026-09-01", teeTime: "07:00", shift: "1부" as const };
  const b = { date: "2026-09-01", teeTime: "13:00", shift: "2부" as const };
  assert(isCompatible54HolePair(a, b), "6h gap ok");
  assert(minutesBetweenReservations(a, b) === 360, "exactly 6h");
}

section("54홀: 6시간 미만 거절");
{
  const a = { date: "2026-09-01", teeTime: "07:00", shift: "1부" as const };
  const b = { date: "2026-09-01", teeTime: "12:59", shift: "2부" as const };
  assert(!isCompatible54HolePair(a, b), "5h59 reject");
  const pair = findEarliest54HolePair([
    {
      date: "2026-09-01",
      course: "SKY",
      shift: "1부",
      teeTime: "10:00",
      teamName: "A",
    },
    {
      date: "2026-09-01",
      course: "SKY",
      shift: "2부",
      teeTime: "14:00",
      teamName: "B",
    },
  ]);
  assert(pair === null, "no pair under 6h");
}

section("54홀: 1부 후반 + 3부 초반 가능");
{
  const date = "2026-09-02";
  const fiftyFour: AutoAssignCaddy = {
    id: 500,
    name: "54홀캐디",
    team: "1조",
    teamOrder: 1,
  };
  const reservations: AutoAssignReservation[] = [
    {
      date,
      course: "VERTHILL",
      shift: "1부",
      teeTime: "10:30",
      teamName: "1부후반",
      rawRowIndex: 2,
    },
    {
      date,
      course: "VERTHILL",
      shift: "2부",
      teeTime: "13:00",
      teamName: "2부",
      rawRowIndex: 3,
    },
    {
      date,
      course: "VERTHILL",
      shift: "3부",
      teeTime: "16:30",
      teamName: "3부초반",
      rawRowIndex: 4,
    },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(5, 1),
    fiftyFourHole: [fiftyFour],
    reservations,
  });
  assert(result.fiftyFourHoleAssignments.length === 2, "54홀 2슬롯");
  assert(
    result.fiftyFourHoleAssignments.every(
      (a) => a.reason === REASON.FIFTY_FOUR_HOLE_PRIORITY
    ),
    "reason 54HOLE_PRIORITY"
  );
  const tees = result.fiftyFourHoleAssignments
    .map((a) => a.reservation.teeTime)
    .sort();
  assert(tees[0] === "10:30" && tees[1] === "16:30", "1부후반+3부초반");
  assert(result.specialUnassigned.length === 0, "no 54 review");
  assert(result.regularAssignments.length === 1, "남은 2부 일반배치");
  assert(
    result.regularAssignments[0].reservation.teeTime === "13:00",
    "regular got midday"
  );
}

section("54홀: 시간 겹침 방지");
{
  const date = "2026-09-03";
  const c1: AutoAssignCaddy = {
    id: 501,
    name: "F1",
    team: "1조",
    teamOrder: 1,
  };
  const c2: AutoAssignCaddy = {
    id: 502,
    name: "F2",
    team: "1조",
    teamOrder: 2,
  };
  // only one valid pair exists (06:00 + 12:00); second candidate cannot reuse those
  const reservations: AutoAssignReservation[] = [
    {
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "06:00",
      teamName: "A",
      rawRowIndex: 2,
    },
    {
      date,
      course: "OCEAN",
      shift: "2부",
      teeTime: "12:00",
      teamName: "B",
      rawRowIndex: 3,
    },
    {
      date,
      course: "OCEAN",
      shift: "2부",
      teeTime: "12:30",
      teamName: "C",
      rawRowIndex: 4,
    },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 10),
    fiftyFourHole: [c1, c2],
    reservations,
  });
  assert(result.meta.fiftyFourHoleAssignedCaddyCount === 1, "only 1 54 caddy");
  assert(result.specialUnassigned.length === 1, "2nd 54 → review");
  assert(
    result.specialUnassigned[0].reason === REASON.FIFTY_FOUR_NO_PAIR ||
      result.specialUnassigned[0].reason ===
        REASON.FIFTY_FOUR_INSUFFICIENT_RESERVATIONS,
    "overlap/no pair reason"
  );
  const ids = result.fiftyFourHoleAssignments.map((a) => a.caddy.id);
  assert(ids.every((id) => id === c1.id), "same caddy on both 54 slots");
}

section("54홀: 후보 부족 / 예약 부족");
{
  const date = "2026-09-04";
  const onlyOneRes = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3),
    fiftyFourHole: [
      { id: 600, name: "F", team: "2조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "alone",
        rawRowIndex: 2,
      },
    ],
  });
  assert(onlyOneRes.specialUnassigned.length === 1, "예약 부족 → review");
  assert(
    onlyOneRes.specialUnassigned[0].reason ===
      REASON.FIFTY_FOUR_INSUFFICIENT_RESERVATIONS,
    "INSUFFICIENT_RESERVATIONS"
  );
  assert(onlyOneRes.regularAssignments.length === 1, "단일 예약은 일반배치");

  const noCandidates = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    fiftyFourHole: [],
    reservations: makeReservations(date, [
      { shift: "1부", count: 1, teeStart: "07:00" },
      { shift: "3부", count: 1, teeStart: "16:00" },
    ]),
  });
  assert(noCandidates.fiftyFourHoleAssignments.length === 0, "후보 없으면 54 없음");
  assert(noCandidates.meta.fiftyFourHoleCandidateCount === 0, "candidate 0");
}

section("54홀: 실패 후 review 남김 (일반 강등 없음)");
{
  const date = "2026-09-05";
  const f: AutoAssignCaddy = {
    id: 700,
    name: "실패54",
    team: "3조",
    teamOrder: 1,
  };
  // gaps all < 6h
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 1),
    fiftyFourHole: [f],
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "08:00",
        teamName: "a",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "2부",
        teeTime: "11:00",
        teamName: "b",
        rawRowIndex: 3,
      },
      {
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "13:30",
        teamName: "c",
        rawRowIndex: 4,
      },
    ],
  });
  assert(result.fiftyFourHoleAssignments.length === 0, "no 54 assign");
  assert(result.specialUnassigned.length === 1, "review kept");
  assert(result.specialUnassigned[0].review === true, "review flag");
  assert(
    !result.regularAssignments.some((a) => a.caddy.id === 700),
    "not demoted to regular"
  );
  assert(result.regularAssignments.length === 3, "all reserved by regular pool");
}

section("54홀: 배치 후 일반 순번 포인터 정상");
{
  const date = "2026-09-06";
  const available = makeCaddies(5, 1);
  const ordered = [...available].sort(compareCaddyOrder);
  const fiftyFour: AutoAssignCaddy = {
    id: 800,
    name: "54",
    team: "9조",
    teamOrder: 1,
  };
  // 54 takes 06:00 + 12:00; remaining 07:00, 08:00 go to regular from pointer 0
  const result = computeAutoAssignmentsV1({
    date,
    available,
    fiftyFourHole: [fiftyFour],
    reservations: [
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "06:00",
        teamName: "r1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "07:00",
        teamName: "r2",
        rawRowIndex: 3,
      },
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "08:00",
        teamName: "r3",
        rawRowIndex: 4,
      },
      {
        date,
        course: "VERTHILL",
        shift: "2부",
        teeTime: "12:00",
        teamName: "r4",
        rawRowIndex: 5,
      },
    ],
  });
  assert(result.fiftyFourHoleAssignments.length === 2, "54 took pair");
  assert(result.regularAssignments.length === 2, "2 regular");
  assert(
    result.regularAssignments[0].caddy.id === ordered[0].id,
    "regular starts seq0 (pointer not skewed by 54)"
  );
  assert(
    result.regularAssignments[1].caddy.id === ordered[1].id,
    "regular continues seq1"
  );
  assert(
    result.regularAssignments.every((a) => a.sequenceIndex >= 0),
    "regular has sequenceIndex"
  );
  assert(
    result.fiftyFourHoleAssignments.every((a) => a.sequenceIndex === -1),
    "54 sequenceIndex not in regular pointer"
  );
  assert(!result.meta.availableCount || result.meta.availableCount === 5, "54 excluded from available count");
  // fiftyFour id 800 not in available pool — availableCount is 5
  assert(result.meta.availableCount === 5, "available excludes 54 candidate");
}

section("1·3부: 1부 후반 + 3부 초반 정상");
{
  const date = "2026-09-10";
  const ot: AutoAssignCaddy = {
    id: 900,
    name: "일삼",
    team: "1조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 1),
    oneThreeCandidates: [ot],
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "이른1부",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "10:30",
        teamName: "후반1부",
        rawRowIndex: 3,
      },
      {
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "16:30",
        teamName: "초반3부",
        rawRowIndex: 4,
      },
      {
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "17:30",
        teamName: "늦은3부",
        rawRowIndex: 5,
      },
    ],
  });
  assert(result.oneThreeAssignments.length === 2, "1·3 2슬롯");
  assert(
    result.oneThreeAssignments.every((a) => a.reason === REASON.ONE_THREE_PRIORITY),
    "ONE_THREE_PRIORITY"
  );
  const tees = result.oneThreeAssignments
    .map((a) => a.reservation.teeTime)
    .sort();
  assert(tees[0] === "10:30" && tees[1] === "16:30", "후반1부+초반3부");
  assert(result.specialUnassigned.length === 0, "no review");
  // remaining: 07:00 and 17:30 → regular
  assert(result.regularAssignments.length === 2, "remaining regular");
}

section("1·3부: 6시간 미만 거절");
{
  const date = "2026-09-11";
  const found = findOneThreePair([
    {
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "11:00",
      teamName: "a",
    },
    {
      date,
      course: "OCEAN",
      shift: "3부",
      teeTime: "16:30",
      teamName: "b",
    },
  ]);
  assert(!found.ok && found.reason === REASON.ONE_THREE_NO_PAIR, "gap < 6h");
  assert(
    !isCompatibleOneThreePair(
      { date, teeTime: "11:00", shift: "1부" },
      { date, teeTime: "16:30", shift: "3부" }
    ),
    "helper reject"
  );

  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3),
    oneThreeCandidates: [
      { id: 901, name: "OT", team: "2조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "11:00",
        teamName: "a",
        rawRowIndex: 2,
      },
      {
        date,
        course: "OCEAN",
        shift: "3부",
        teeTime: "16:30",
        teamName: "b",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.oneThreeAssignments.length === 0, "no 1·3 assign");
  assert(result.specialUnassigned.length === 1, "review");
  assert(
    result.specialUnassigned[0].reason === REASON.ONE_THREE_NO_PAIR,
    "NO_PAIR reason"
  );
  assert(
    !result.regularAssignments.some((a) => a.caddy.id === 901),
    "not demoted"
  );
}

section("1·3부: 1부만 / 3부만");
{
  const date = "2026-09-12";
  const only1 = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    oneThreeCandidates: [
      { id: 910, name: "OT1", team: "1조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "10:00",
        teamName: "only1",
        rawRowIndex: 2,
      },
    ],
  });
  assert(
    only1.specialUnassigned[0]?.reason === REASON.ONE_THREE_MISSING_SHIFT3,
    "1부만 → MISSING_SHIFT3"
  );

  const only3 = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    oneThreeCandidates: [
      { id: 911, name: "OT3", team: "1조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "3부",
        teeTime: "16:00",
        teamName: "only3",
        rawRowIndex: 2,
      },
    ],
  });
  assert(
    only3.specialUnassigned[0]?.reason === REASON.ONE_THREE_MISSING_SHIFT1,
    "3부만 → MISSING_SHIFT1"
  );
}

section("1·3부: 후보/예약 부족");
{
  const date = "2026-09-13";
  // 후보 2, 유효 페어 슬롯 1세트만
  const shortRes = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 1),
    oneThreeCandidates: [
      { id: 920, name: "A", team: "1조", teamOrder: 1 },
      { id: 921, name: "B", team: "1조", teamOrder: 2 },
    ],
    reservations: [
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "10:00",
        teamName: "s1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "VERTHILL",
        shift: "3부",
        teeTime: "16:00",
        teamName: "s3",
        rawRowIndex: 3,
      },
    ],
  });
  assert(shortRes.meta.oneThreeAssignedCaddyCount === 1, "1 candidate placed");
  assert(shortRes.meta.oneThreeUnassignedCount === 1, "1 candidate review");
  assert(
    shortRes.specialUnassigned.some(
      (u) =>
        u.reason === REASON.ONE_THREE_MISSING_SHIFT1 ||
        u.reason === REASON.ONE_THREE_MISSING_SHIFT3 ||
        u.reason === REASON.ONE_THREE_INSUFFICIENT_RESERVATIONS
    ),
    "예약 부족 review"
  );

  // 예약 충분, 후보 1
  const shortCand = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 1),
    oneThreeCandidates: [
      { id: 922, name: "Only", team: "2조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "09:30",
        teamName: "a1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "10:30",
        teamName: "a2",
        rawRowIndex: 3,
      },
      {
        date,
        course: "VERTHILL",
        shift: "3부",
        teeTime: "16:00",
        teamName: "b1",
        rawRowIndex: 4,
      },
      {
        date,
        course: "VERTHILL",
        shift: "3부",
        teeTime: "16:30",
        teamName: "b2",
        rawRowIndex: 5,
      },
    ],
  });
  assert(shortCand.meta.oneThreeAssignedCaddyCount === 1, "후보 1만 배치");
  assert(shortCand.oneThreeAssignments.length === 2, "1 pair");
  assert(shortCand.regularAssignments.length === 2, "나머지 일반");
  assert(shortCand.meta.oneThreeCandidateCount === 1, "candidate count 1");
}

section("1·3부: 54홀과 동일 캐디면 54홀 우선");
{
  const date = "2026-09-14";
  const shared: AutoAssignCaddy = {
    id: 930,
    name: "충돌",
    team: "3조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 1),
    fiftyFourHole: [shared],
    oneThreeCandidates: [shared],
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "10:30",
        teamName: "s1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "16:30",
        teamName: "s3",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.meta.oneThreeCandidateCount === 0, "1·3에서 제외");
  assert(result.fiftyFourHoleAssignments.length === 2, "54홀이 가져감");
  assert(result.oneThreeAssignments.length === 0, "1·3 없음");
  assert(
    result.fiftyFourHoleAssignments.every((a) => a.caddy.id === 930),
    "54 caddy"
  );
}

section("1·3부: 배치 후 일반 순번 정상");
{
  const date = "2026-09-15";
  const available = makeCaddies(5, 1);
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    oneThreeCandidates: [
      { id: 940, name: "OT", team: "8조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "early",
        rawRowIndex: 2,
      },
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "10:00",
        teamName: "late1",
        rawRowIndex: 3,
      },
      {
        date,
        course: "OCEAN",
        shift: "2부",
        teeTime: "13:00",
        teamName: "mid",
        rawRowIndex: 4,
      },
      {
        date,
        course: "OCEAN",
        shift: "3부",
        teeTime: "16:00",
        teamName: "early3",
        rawRowIndex: 5,
      },
    ],
  });
  assert(result.oneThreeAssignments.length === 2, "OT pair");
  assert(
    result.oneThreeAssignments.map((a) => a.reservation.teeTime).sort().join(",") ===
      "10:00,16:00",
    "OT took late1+early3"
  );
  assert(result.regularAssignments.length === 2, "2 regular left");
  assert(
    result.regularAssignments[0].caddy.id === ordered[0].id,
    "pointer starts at 0"
  );
  assert(
    result.regularAssignments[1].caddy.id === ordered[1].id,
    "pointer continues"
  );
  assert(result.meta.availableCount === 5, "OT excluded from available");
}

section("1·2부: 정상 1부+2부 페어");
{
  const date = "2026-09-20";
  const ot: AutoAssignCaddy = {
    id: 950,
    name: "일이",
    team: "1조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 1),
    oneTwoCandidates: [ot],
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "이른1부",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "09:30",
        teamName: "후반1부",
        rawRowIndex: 3,
      },
      {
        date,
        course: "SKY",
        shift: "2부",
        teeTime: "13:30",
        teamName: "초반2부",
        rawRowIndex: 4,
      },
      {
        date,
        course: "SKY",
        shift: "2부",
        teeTime: "14:30",
        teamName: "늦은2부",
        rawRowIndex: 5,
      },
    ],
  });
  assert(result.oneTwoAssignments.length === 2, "1·2 2슬롯");
  assert(
    result.oneTwoAssignments.every((a) => a.reason === REASON.ONE_TWO_PRIORITY),
    "ONE_TWO_PRIORITY"
  );
  const tees = result.oneTwoAssignments
    .map((a) => a.reservation.teeTime)
    .sort();
  assert(tees[0] === "09:30" && tees[1] === "13:30", "후반1부+초반2부");
  assert(result.specialUnassigned.length === 0, "no review");
  assert(result.regularAssignments.length === 2, "remaining regular");
}

section("1·2부: 최소 간격 미달 거절");
{
  const date = "2026-09-21";
  const found = findOneTwoPair([
    {
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "10:00",
      teamName: "a",
    },
    {
      date,
      course: "OCEAN",
      shift: "2부",
      teeTime: "13:30",
      teamName: "b",
    },
  ]);
  assert(!found.ok && found.reason === REASON.ONE_TWO_NO_PAIR, "gap < 4h");
  assert(
    !isCompatibleOneTwoPair(
      { date, teeTime: "10:00", shift: "1부" },
      { date, teeTime: "13:30", shift: "2부" }
    ),
    "helper reject 3.5h"
  );
  assert(
    isCompatibleOneTwoPair(
      { date, teeTime: "09:00", shift: "1부" },
      { date, teeTime: "13:00", shift: "2부" }
    ),
    "helper allow 4h"
  );

  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3),
    oneTwoCandidates: [
      { id: 951, name: "OT2", team: "2조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "10:00",
        teamName: "a",
        rawRowIndex: 2,
      },
      {
        date,
        course: "OCEAN",
        shift: "2부",
        teeTime: "13:30",
        teamName: "b",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.oneTwoAssignments.length === 0, "no 1·2 assign");
  assert(result.specialUnassigned.length === 1, "review");
  assert(
    result.specialUnassigned[0].reason === REASON.ONE_TWO_NO_PAIR,
    "NO_PAIR"
  );
  assert(
    !result.regularAssignments.some((a) => a.caddy.id === 951),
    "not demoted"
  );
}

section("1·2부: 1부만 / 2부만");
{
  const date = "2026-09-22";
  const only1 = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    oneTwoCandidates: [
      { id: 960, name: "OT1", team: "1조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "09:00",
        teamName: "only1",
        rawRowIndex: 2,
      },
    ],
  });
  assert(
    only1.specialUnassigned[0]?.reason === REASON.ONE_TWO_MISSING_SHIFT2,
    "1부만 → MISSING_SHIFT2"
  );

  const only2 = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    oneTwoCandidates: [
      { id: 961, name: "OT2", team: "1조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "2부",
        teeTime: "13:00",
        teamName: "only2",
        rawRowIndex: 2,
      },
    ],
  });
  assert(
    only2.specialUnassigned[0]?.reason === REASON.ONE_TWO_MISSING_SHIFT1,
    "2부만 → MISSING_SHIFT1"
  );
}

section("1·2부: 후보/예약 부족");
{
  const date = "2026-09-23";
  const shortRes = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 1),
    oneTwoCandidates: [
      { id: 970, name: "A", team: "1조", teamOrder: 1 },
      { id: 971, name: "B", team: "1조", teamOrder: 2 },
    ],
    reservations: [
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "09:00",
        teamName: "s1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "VERTHILL",
        shift: "2부",
        teeTime: "13:00",
        teamName: "s2",
        rawRowIndex: 3,
      },
    ],
  });
  assert(shortRes.meta.oneTwoAssignedCaddyCount === 1, "1 candidate placed");
  assert(shortRes.meta.oneTwoUnassignedCount === 1, "1 candidate review");

  const shortCand = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 1),
    oneTwoCandidates: [
      { id: 972, name: "Only", team: "2조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "08:30",
        teamName: "a1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "09:30",
        teamName: "a2",
        rawRowIndex: 3,
      },
      {
        date,
        course: "VERTHILL",
        shift: "2부",
        teeTime: "13:00",
        teamName: "b1",
        rawRowIndex: 4,
      },
      {
        date,
        course: "VERTHILL",
        shift: "2부",
        teeTime: "13:30",
        teamName: "b2",
        rawRowIndex: 5,
      },
    ],
  });
  assert(shortCand.meta.oneTwoAssignedCaddyCount === 1, "후보 1만");
  assert(shortCand.oneTwoAssignments.length === 2, "1 pair");
  assert(shortCand.regularAssignments.length === 2, "나머지 일반");
}

section("1·2부: 54홀 충돌 시 54홀 우선");
{
  const date = "2026-09-24";
  const shared: AutoAssignCaddy = {
    id: 980,
    name: "충돌54",
    team: "3조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 1),
    fiftyFourHole: [shared],
    oneTwoCandidates: [shared],
    reservations: [
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "s1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "SKY",
        shift: "2부",
        teeTime: "13:00",
        teamName: "s2",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.meta.oneTwoCandidateCount === 0, "1·2에서 제외");
  assert(result.fiftyFourHoleAssignments.length === 2, "54홀이 가져감");
  assert(result.oneTwoAssignments.length === 0, "1·2 없음");
}

section("1·2부: 1·3부 충돌 시 1·3부 우선");
{
  const date = "2026-09-25";
  const shared: AutoAssignCaddy = {
    id: 981,
    name: "충돌13",
    team: "4조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(3, 1),
    oneThreeCandidates: [shared],
    oneTwoCandidates: [shared],
    reservations: [
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "10:00",
        teamName: "s1",
        rawRowIndex: 2,
      },
      {
        date,
        course: "OCEAN",
        shift: "2부",
        teeTime: "14:00",
        teamName: "s2",
        rawRowIndex: 3,
      },
      {
        date,
        course: "OCEAN",
        shift: "3부",
        teeTime: "16:00",
        teamName: "s3",
        rawRowIndex: 4,
      },
    ],
  });
  assert(result.meta.oneTwoCandidateCount === 0, "1·2 후보에서 제외");
  assert(result.oneThreeAssignments.length === 2, "1·3이 가져감");
  assert(result.oneTwoAssignments.length === 0, "1·2 없음");
  assert(
    result.oneThreeAssignments.every((a) => a.caddy.id === 981),
    "1·3 caddy"
  );
}

section("1·2부: 배치 후 일반 순번 정상");
{
  const date = "2026-09-26";
  const available = makeCaddies(5, 1);
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    oneTwoCandidates: [
      { id: 990, name: "OT12", team: "8조", teamOrder: 1 },
    ],
    reservations: [
      {
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "early",
        rawRowIndex: 2,
      },
      {
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "09:00",
        teamName: "late1",
        rawRowIndex: 3,
      },
      {
        date,
        course: "LAKE",
        shift: "2부",
        teeTime: "13:00",
        teamName: "early2",
        rawRowIndex: 4,
      },
      {
        date,
        course: "LAKE",
        shift: "3부",
        teeTime: "16:00",
        teamName: "s3",
        rawRowIndex: 5,
      },
    ],
  });
  assert(result.oneTwoAssignments.length === 2, "OT12 pair");
  assert(
    result.oneTwoAssignments.map((a) => a.reservation.teeTime).sort().join(",") ===
      "09:00,13:00",
    "OT12 took late1+early2"
  );
  assert(result.regularAssignments.length === 2, "2 regular left");
  assert(
    result.regularAssignments[0].caddy.id === ordered[0].id,
    "pointer starts at 0"
  );
  assert(
    result.regularAssignments[1].caddy.id === ordered[1].id,
    "pointer continues"
  );
  assert(result.meta.availableCount === 5, "OT12 excluded from available");
}

section("고정/찾근: reason 구분");
{
  assert(reasonForFixedType("FIXED") === REASON.FIXED_ASSIGNMENT, "FIXED");
  assert(reasonForFixedType("마샬찾근") === REASON.MARSHAL_CALL, "마샬");
  assert(reasonForFixedType("DUTY_CALL") === REASON.DUTY_CALL, "당번");
  assert(reasonForFixedType("당번찾근") === REASON.DUTY_CALL, "당번한글");
}

section("고정/찾근: 정상 고정배치 + 마샬/당번");
{
  const date = "2026-10-01";
  const available = makeCaddies(5, 1);
  const fixedCaddy = available[0];
  const marshal = {
    id: 2001,
    name: "마샬",
    team: "1조",
    teamOrder: 99,
  };
  const duty = { id: 2002, name: "당번", team: "2조", teamOrder: 99 };
  const reservations: AutoAssignReservation[] = [
    {
      id: "R1",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:00",
      teamName: "고정팀",
      rawRowIndex: 2,
    },
    {
      id: "R2",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:08",
      teamName: "마샬팀",
      rawRowIndex: 3,
    },
    {
      id: "R3",
      date,
      course: "SKY",
      shift: "2부",
      teeTime: "13:00",
      teamName: "당번팀",
      rawRowIndex: 4,
    },
    {
      id: "R4",
      date,
      course: "SKY",
      shift: "2부",
      teeTime: "13:08",
      teamName: "일반",
      rawRowIndex: 5,
    },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    caddyDirectory: [marshal, duty],
    fixedAssignments: [
      {
        caddyId: fixedCaddy.id,
        reservationId: "R1",
        type: "FIXED",
        note: "고정",
      },
      {
        caddyId: marshal.id,
        reservationId: "R2",
        type: "마샬찾근",
      },
      {
        caddyId: duty.id,
        reservationId: "R3",
        type: "DUTY_CALL",
      },
    ],
    reservations,
  });
  assert(result.fixedAssignments.length === 3, "3 fixed");
  assert(
    result.fixedAssignments.some((a) => a.reason === REASON.FIXED_ASSIGNMENT),
    "FIXED_ASSIGNMENT"
  );
  assert(
    result.fixedAssignments.some((a) => a.reason === REASON.MARSHAL_CALL),
    "MARSHAL_CALL"
  );
  assert(
    result.fixedAssignments.some((a) => a.reason === REASON.DUTY_CALL),
    "DUTY_CALL"
  );
  assert(result.regularAssignments.length === 1, "remaining 1 regular");
  assert(
    result.regularAssignments[0].reservation.id === "R4",
    "regular got R4"
  );
}

section("고정/찾근: 존재하지 않는 캐디/예약");
{
  const date = "2026-10-02";
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(2),
    fixedAssignments: [
      { caddyId: 99999, reservationId: "RX", type: "FIXED" },
      {
        caddyId: 1,
        reservationId: "NOPE",
        type: "FIXED",
      },
    ],
    reservations: [
      {
        id: "RX2",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "08:00",
        teamName: "t",
        rawRowIndex: 2,
      },
    ],
  });
  assert(
    result.specialUnassigned.some((u) => u.reason === REASON.FIXED_UNKNOWN_CADDY),
    "unknown caddy"
  );
  assert(
    result.specialUnassigned.some(
      (u) => u.reason === REASON.FIXED_UNKNOWN_RESERVATION
    ),
    "unknown reservation"
  );
  assert(result.fixedAssignments.length === 0, "no fixed success");
}

section("고정/찾근: 동일 캐디/예약 중복");
{
  const date = "2026-10-03";
  const caddies = makeCaddies(3, 1);
  const result = computeAutoAssignmentsV1({
    date,
    available: caddies,
    fixedAssignments: [
      { caddyId: caddies[0].id, reservationId: "A", type: "FIXED" },
      { caddyId: caddies[0].id, reservationId: "B", type: "FIXED" },
      { caddyId: caddies[1].id, reservationId: "C", type: "FIXED" },
      { caddyId: caddies[2].id, reservationId: "C", type: "MARSHAL_CALL" },
    ],
    reservations: [
      {
        id: "A",
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "a",
        rawRowIndex: 2,
      },
      {
        id: "B",
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "08:00",
        teamName: "b",
        rawRowIndex: 3,
      },
      {
        id: "C",
        date,
        course: "OCEAN",
        shift: "2부",
        teeTime: "13:00",
        teamName: "c",
        rawRowIndex: 4,
      },
    ],
  });
  assert(
    result.specialUnassigned.filter((u) => u.reason === REASON.FIXED_CADDY_CONFLICT)
      .length >= 2,
    "caddy conflict"
  );
  assert(
    result.specialUnassigned.filter(
      (u) => u.reason === REASON.FIXED_RESERVATION_CONFLICT
    ).length >= 2,
    "reservation conflict"
  );
  assert(result.fixedAssignments.length === 0, "conflicts not assigned");
}

section("고정/찾근: 54홀·1·3·1·2보다 우선");
{
  const date = "2026-10-04";
  const shared = {
    id: 3001,
    name: "공유",
    team: "1조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: makeCaddies(4, 10),
    fiftyFourHole: [shared],
    oneThreeCandidates: [shared],
    oneTwoCandidates: [shared],
    fixedAssignments: [
      {
        caddyId: shared.id,
        reservationId: "F1",
        type: "SPECIAL_CALL",
        note: "관리자지정",
      },
    ],
    caddyDirectory: [shared],
    reservations: [
      {
        id: "F1",
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "10:00",
        teamName: "fixed",
        rawRowIndex: 2,
      },
      {
        id: "F2",
        date,
        course: "VERTHILL",
        shift: "3부",
        teeTime: "16:00",
        teamName: "other",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.fixedAssignments.length === 1, "fixed wins");
  assert(
    result.fixedAssignments[0].reason === REASON.SPECIAL_CALL,
    "SPECIAL_CALL"
  );
  assert(result.meta.fiftyFourHoleCandidateCount === 0, "54 excluded");
  assert(result.meta.oneThreeCandidateCount === 0, "13 excluded");
  assert(result.meta.oneTwoCandidateCount === 0, "12 excluded");
  assert(result.fiftyFourHoleAssignments.length === 0, "no 54 assign");
}

section("고정/찾근: 캔슬 시 일반 재투입 없음");
{
  const date = "2026-10-05";
  const caddy = {
    id: 3100,
    name: "캔슬찾근",
    team: "5조",
    teamOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: [...makeCaddies(3, 1), caddy],
    fixedAssignments: [
      {
        caddyId: caddy.id,
        reservationId: "CANCEL",
        type: "마샬찾근",
        cancelled: true,
      },
    ],
    reservations: [
      {
        id: "CANCEL",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "취소팀",
        rawRowIndex: 2,
      },
      {
        id: "KEEP",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
        teamName: "남음",
        rawRowIndex: 3,
      },
    ],
  });
  assert(result.fixedAssignments.length === 0, "cancelled not assigned");
  assert(
    result.specialUnassigned.some((u) => u.reason === REASON.FIXED_CANCELLED),
    "FIXED_CANCELLED review"
  );
  assert(
    !result.assignments.some((a) => a.caddy.id === caddy.id),
    "caddy not redeployed"
  );
  assert(
    !result.regularAssignments.some((a) => a.reservation.id === "CANCEL"),
    "cancelled reservation not in regular"
  );
  assert(
    result.regularAssignments.some((a) => a.reservation.id === "KEEP"),
    "other reservation regular ok"
  );
}

section("고정/찾근: 배치 후 일반 순번 정상");
{
  const date = "2026-10-06";
  const available = makeCaddies(5, 1);
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    fixedAssignments: [
      {
        caddyId: 4000,
        reservationId: "FX",
        type: "FIXED",
      },
    ],
    caddyDirectory: [
      { id: 4000, name: "고정자", team: "9조", teamOrder: 1 },
    ],
    reservations: [
      {
        id: "FX",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "06:30",
        teamName: "fx",
        rawRowIndex: 2,
      },
      {
        id: "G1",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "g1",
        rawRowIndex: 3,
      },
      {
        id: "G2",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "g2",
        rawRowIndex: 4,
      },
    ],
  });
  assert(result.fixedAssignments.length === 1, "1 fixed");
  assert(result.regularAssignments.length === 2, "2 regular");
  assert(
    result.regularAssignments[0].caddy.id === ordered[0].id,
    "pointer starts 0"
  );
  assert(
    result.regularAssignments[1].caddy.id === ordered[1].id,
    "pointer continues"
  );
  assert(result.meta.availableCount === 5, "fixed caddy not in available pool");
}

section("reflow: 일반 예약 1건 캔슬 → 뒤 순번 밀림");
{
  const date = "2026-10-10";
  const pool = makeCaddies(5, 1);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      {
        id: "R1",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "a",
        rawRowIndex: 2,
      },
      {
        id: "R2",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
        teamName: "b",
        rawRowIndex: 3,
      },
      {
        id: "R3",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:16",
        teamName: "c",
        rawRowIndex: 4,
      },
    ],
  });
  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [{ type: "CANCEL_RESERVATION", reservationId: "R1" }],
  });
  assert(reflow.reason === REASON.REGULAR_CANCEL_REFLOW, "CANCEL_REFLOW");
  assert(reflow.after.regularAssignments.length === 2, "2 left");
  assert(
    reflow.after.regularAssignments[0].caddy.id === ordered[0].id &&
      reflow.after.regularAssignments[0].reservation.id === "R2",
    "first caddy → R2"
  );
  assert(
    reflow.changes.some(
      (c) =>
        c.caddy.id === ordered[0].id && c.kind === "movedBackward"
    ),
    "cancelled slot caddy movedBackward"
  );
  assert(
    reflow.changes.some(
      (c) => c.caddy.id === ordered[2].id && c.kind === "becameUnassigned"
    ),
    "last becameUnassigned"
  );
}

section("reflow: 일반 예약 1건 추가 → 앞 순번 당김");
{
  const date = "2026-10-11";
  const pool = makeCaddies(5, 1);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      {
        id: "R2",
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "08:00",
        teamName: "b",
        rawRowIndex: 2,
      },
      {
        id: "R3",
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "08:08",
        teamName: "c",
        rawRowIndex: 3,
      },
    ],
  });
  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [
      {
        type: "ADD_RESERVATION",
        reservation: {
          id: "R1",
          date,
          course: "OCEAN",
          shift: "1부",
          teeTime: "07:50",
          teamName: "new",
          rawRowIndex: 1,
        },
      },
    ],
  });
  assert(reflow.reason === REASON.REGULAR_ADD_REFLOW, "ADD_REFLOW");
  assert(reflow.after.regularAssignments.length === 3, "3 assigned");
  assert(
    reflow.after.regularAssignments[0].reservation.id === "R1",
    "new earliest first"
  );
  assert(
    reflow.changes.some(
      (c) => c.caddy.id === ordered[0].id && c.kind === "movedForward"
    ),
    "first caddy pulled forward to earlier tee"
  );
  assert(
    reflow.changes.some((c) => c.kind === "newlyAssigned"),
    "newlyAssigned appears"
  );
}

section("reflow: 1부 변경 → 2부 포인터 영향 / 2부 → 3부");
{
  const date = "2026-10-12";
  const pool = makeCaddies(6, 1);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      {
        id: "S1A",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "1a",
        rawRowIndex: 2,
      },
      {
        id: "S1B",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "1b",
        rawRowIndex: 3,
      },
      {
        id: "S2A",
        date,
        course: "LAKE",
        shift: "2부",
        teeTime: "13:00",
        teamName: "2a",
        rawRowIndex: 4,
      },
      {
        id: "S3A",
        date,
        course: "LAKE",
        shift: "3부",
        teeTime: "16:00",
        teamName: "3a",
        rawRowIndex: 5,
      },
    ],
  });
  // before: seq0,1 → 1부 / seq2 → 2부 / seq3 → 3부
  assert(
    previous.regularAssignments.find((a) => a.reservation.id === "S2A")?.caddy
      .id === ordered[2].id,
    "2부 starts at seq2"
  );

  const afterCancel1 = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [{ type: "CANCEL_RESERVATION", reservationId: "S1A" }],
  });
  assert(
    afterCancel1.after.regularAssignments.find((a) => a.reservation.id === "S2A")
      ?.caddy.id === ordered[1].id,
    "1부 캔슬 후 2부 시작 포인터 당김"
  );
  assert(
    afterCancel1.after.regularAssignments.find((a) => a.reservation.id === "S3A")
      ?.caddy.id === ordered[2].id,
    "3부 포인터도 재계산"
  );

  const afterCancel2 = reflowRegularAssignments({
    previous: afterCancel1.after,
    regularCaddyPool: pool,
    events: [{ type: "CANCEL_RESERVATION", reservationId: "S2A" }],
  });
  assert(
    afterCancel2.after.regularAssignments.find((a) => a.reservation.id === "S3A")
      ?.caddy.id === ordered[1].id,
    "2부 캔슬 후 3부 시작 포인터 갱신"
  );
}

section("reflow: special 배치 영향 없음 + 고정캔슬 재투입 금지");
{
  const date = "2026-10-13";
  const pool = makeCaddies(4, 1);
  const fixedCaddy = {
    id: 5001,
    name: "고정",
    team: "1조",
    teamOrder: 1,
  };
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    caddyDirectory: [
      fixedCaddy,
      { id: 5003, name: "캔슬찾근", team: "3조", teamOrder: 1 },
    ],
    fiftyFourHole: [
      { id: 5002, name: "오십사", team: "2조", teamOrder: 1 },
    ],
    fixedAssignments: [
      { caddyId: fixedCaddy.id, reservationId: "FX", type: "FIXED" },
      {
        caddyId: 5003,
        reservationId: "CX",
        type: "마샬찾근",
        cancelled: true,
      },
    ],
    reservations: [
      {
        id: "FX",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "06:30",
        teamName: "fx",
        rawRowIndex: 2,
      },
      {
        id: "CX",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "06:40",
        teamName: "cx",
        rawRowIndex: 3,
      },
      {
        id: "G1",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "g1",
        rawRowIndex: 4,
      },
      {
        id: "G2",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
        teamName: "g2",
        rawRowIndex: 5,
      },
      {
        id: "F54A",
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "10:00",
        teamName: "54a",
        rawRowIndex: 6,
      },
      {
        id: "F54B",
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "16:00",
        teamName: "54b",
        rawRowIndex: 7,
      },
    ],
  });

  const fixedBefore = previous.fixedAssignments.map((a) => ({
    id: a.caddy.id,
    res: a.reservation.id,
  }));
  const fiftyBefore = previous.fiftyFourHoleAssignments.map((a) => ({
    id: a.caddy.id,
    res: a.reservation.id,
  }));

  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [
      { type: "CANCEL_RESERVATION", reservationId: "G1" },
      { type: "CANCEL_RESERVATION", reservationId: "FX" },
      { type: "CANCEL_RESERVATION", reservationId: "CX" },
    ],
  });

  assert(
    JSON.stringify(
      reflow.after.fixedAssignments.map((a) => ({
        id: a.caddy.id,
        res: a.reservation.id,
      }))
    ) === JSON.stringify(fixedBefore),
    "fixed preserved"
  );
  assert(
    JSON.stringify(
      reflow.after.fiftyFourHoleAssignments.map((a) => ({
        id: a.caddy.id,
        res: a.reservation.id,
      }))
    ) === JSON.stringify(fiftyBefore),
    "54 preserved"
  );
  assert(
    !reflow.after.regularAssignments.some((a) => a.caddy.id === 5003),
    "cancelled fixed caddy not in regular"
  );
  assert(
    !reflow.after.regularAssignments.some((a) => a.caddy.id === fixedCaddy.id),
    "fixed caddy not in regular"
  );
  assert(reflow.summary.specialPreserved >= 1, "specialPreserved");
}

section("reflow: 연속 여러 건 캔슬/추가 + 인접 teeTime");
{
  const date = "2026-10-14";
  const pool = makeCaddies(8, 1);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      {
        id: "T1",
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "07:00",
        teamName: "t1",
        rawRowIndex: 2,
      },
      {
        id: "T2",
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "07:07",
        teamName: "t2",
        rawRowIndex: 3,
      },
      {
        id: "T3",
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "07:14",
        teamName: "t3",
        rawRowIndex: 4,
      },
      {
        id: "T4",
        date,
        course: "VERTHILL",
        shift: "1부",
        teeTime: "07:21",
        teamName: "t4",
        rawRowIndex: 5,
      },
    ],
  });

  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [
      { type: "CANCEL_RESERVATION", reservationId: "T2" },
      { type: "CANCEL_RESERVATION", reservationId: "T4" },
      {
        type: "ADD_RESERVATION",
        reservation: {
          id: "T15",
          date,
          course: "VERTHILL",
          shift: "1부",
          teeTime: "07:10",
          teamName: "mid",
          rawRowIndex: 6,
        },
      },
      {
        type: "ADD_RESERVATION",
        reservation: {
          id: "T05",
          date,
          course: "VERTHILL",
          shift: "1부",
          teeTime: "07:03",
          teamName: "early",
          rawRowIndex: 7,
        },
      },
    ],
  });
  assert(reflow.reason === REASON.REGULAR_MIXED_REFLOW, "MIXED_REFLOW");
  const tees = reflow.after.regularAssignments.map((a) => a.reservation.teeTime);
  assert(
    tees.join(",") === ["07:00", "07:03", "07:10", "07:14"].join(","),
    "teeTime sort kept after multi events"
  );
  assert(
    reflow.after.regularAssignments.map((a) => a.reservation.id).join(",") ===
      "T1,T05,T15,T3",
    "ids order by tee"
  );
  assert(reflow.summary.movedBackward + reflow.summary.movedForward + reflow.summary.unchanged + reflow.summary.newlyAssigned + reflow.summary.becameUnassigned === reflow.changes.length, "change kinds cover all");
}

section("슬롯 큐: shift → teeTime → courseOrder (베→스→오→레)");
{
  const date = "2026-10-01";
  const available = makeCaddies(20);
  const reservations: AutoAssignReservation[] = [
    { date, course: "LAKE", shift: "1부", teeTime: "06:30", teamName: "L1", rawRowIndex: 1 },
    { date, course: "SKY", shift: "1부", teeTime: "06:37", teamName: "S2", rawRowIndex: 2 },
    { date, course: "VERTHILL", shift: "1부", teeTime: "06:44", teamName: "V2", rawRowIndex: 3 },
    { date, course: "OCEAN", shift: "1부", teeTime: "06:30", teamName: "O1", rawRowIndex: 4 },
    { date, course: "SKY", shift: "1부", teeTime: "06:30", teamName: "S1", rawRowIndex: 5 },
    { date, course: "VERTHILL", shift: "1부", teeTime: "06:30", teamName: "V1", rawRowIndex: 6 },
    { date, course: "VERTHILL", shift: "2부", teeTime: "13:00", teamName: "V3", rawRowIndex: 7 },
    { date, course: "SKY", shift: "2부", teeTime: "12:50", teamName: "S3", rawRowIndex: 8 },
  ];
  const result = computeAutoAssignmentsV1({ date, available, reservations });
  const keys = result.assignments.map(
    (a) => `${a.shift}|${a.reservation.teeTime}|${a.reservation.course}`
  );
  assert(
    keys.join(",") ===
      [
        "1부|06:30|VERTHILL",
        "1부|06:30|SKY",
        "1부|06:30|OCEAN",
        "1부|06:30|LAKE",
        "1부|06:37|SKY",
        "1부|06:44|VERTHILL",
        "2부|12:50|SKY",
        "2부|13:00|VERTHILL",
      ].join(","),
    "shift→teeTime→courseOrder"
  );
  assert(COURSE_ORDER.join(",") === "VERTHILL,SKY,OCEAN,LAKE", "COURSE_ORDER fixed");
  const sorted = [...reservations].sort(compareReservationOrder);
  assert(sorted[0].teamName === "V1", "06:30 V first");
  assert(sorted[1].teamName === "S1", "06:30 S second");
  assert(sorted[2].teamName === "O1", "06:30 O third");
  assert(sorted[3].teamName === "L1", "06:30 L fourth");
  assert(sorted[4].teamName === "S2", "06:37 S next");
}

section("코스 Open/Close: 4코스 모두 ON");
{
  const date = "2026-10-02";
  const available = makeCaddies(12);
  const reservations: AutoAssignReservation[] = [
    { date, course: "VERTHILL", shift: "1부", teeTime: "07:00", teamName: "V" },
    { date, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "S" },
    { date, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "O" },
    { date, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "L" },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
  });
  assert(result.assignments.length === 4, "all 4 assigned");
  assert(result.closedCourseReservations.length === 0, "none closed");
  assert(result.openCourses.length === 4, "4 open");
  assert(normalizeOpenCourses(null).length === 4, "default all open");
}

section("코스 Open/Close: 베르힐+스카이만 ON");
{
  const date = "2026-10-03";
  const available = makeCaddies(10);
  const reservations: AutoAssignReservation[] = [
    { date, course: "VERTHILL", shift: "1부", teeTime: "07:00", teamName: "V" },
    { date, course: "SKY", shift: "1부", teeTime: "07:08", teamName: "S" },
    { date, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "O" },
    { date, course: "LAKE", shift: "2부", teeTime: "13:00", teamName: "L" },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    openCourses: ["VERTHILL", "SKY"],
  });
  assert(result.assignments.length === 2, "2 assigned");
  assert(
    result.assignments.every((a) =>
      ["VERTHILL", "SKY"].includes(a.reservation.course)
    ),
    "only V/S"
  );
  assert(result.closedCourseReservations.length === 2, "2 closed");
  assert(
    result.closedCourseReservations.every((u) => u.reason === REASON.CLOSED_COURSE),
    "CLOSED_COURSE reason"
  );
  assert(result.meta.closedCourseCount === 2, "meta closed count");
}

section("코스 Open/Close: 오션만 OFF");
{
  const date = "2026-10-04";
  const available = makeCaddies(10);
  const reservations: AutoAssignReservation[] = [
    { date, course: "VERTHILL", shift: "1부", teeTime: "07:00", teamName: "V" },
    { date, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "S" },
    { date, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "O" },
    { date, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "L" },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    openCourses: ["VERTHILL", "SKY", "LAKE"],
  });
  assert(result.assignments.length === 3, "3 assigned");
  assert(result.closedCourseReservations.length === 1, "1 closed");
  assert(
    result.closedCourseReservations[0].reservation.course === "OCEAN",
    "ocean closed"
  );
  assert(
    !result.assignments.some((a) => a.reservation.course === "OCEAN"),
    "no ocean in assignments"
  );
}

section("코스 Open/Close: 1개 코스만 ON");
{
  const date = "2026-10-05";
  const available = makeCaddies(5);
  const reservations: AutoAssignReservation[] = [
    { date, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "L1" },
    { date, course: "LAKE", shift: "1부", teeTime: "07:08", teamName: "L2" },
    { date, course: "VERTHILL", shift: "1부", teeTime: "07:00", teamName: "V" },
    { date, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "S" },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    openCourses: ["LAKE"],
  });
  assert(result.assignments.length === 2, "2 lake assigned");
  assert(
    result.assignments.every((a) => a.reservation.course === "LAKE"),
    "only lake"
  );
  assert(result.closedCourseReservations.length === 2, "2 closed others");
  assert(
    result.assignments[0].reservation.teeTime === "07:00" &&
      result.assignments[1].reservation.teeTime === "07:08",
    "same course teeTime asc"
  );
}

section("닫힌 코스에 special/고정 배치 금지");
{
  const date = "2026-10-06";
  const available = makeCaddies(8);
  const special = [{ id: 101, name: "특A", team: "1조", teamOrder: 1 }];
  const fiftyFourHole = [{ id: 102, name: "오십사", team: "2조", teamOrder: 1 }];
  const reservations: AutoAssignReservation[] = [
    {
      id: "closed-fixed",
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "07:00",
      teamName: "닫힌고정",
    },
    {
      id: "open-reg",
      date,
      course: "VERTHILL",
      shift: "1부",
      teeTime: "07:00",
      teamName: "열린일반",
    },
    {
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "07:08",
      teamName: "닫힌54후보1",
    },
    {
      date,
      course: "OCEAN",
      shift: "2부",
      teeTime: "13:10",
      teamName: "닫힌54후보2",
    },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    special,
    fiftyFourHole,
    reservations,
    openCourses: ["VERTHILL", "SKY", "LAKE"],
    fixedAssignments: [
      { caddyId: 101, reservationId: "closed-fixed", type: "FIXED" },
    ],
  });
  assert(
    !result.assignments.some((a) => a.reservation.course === "OCEAN"),
    "no ocean assignments incl special"
  );
  assert(
    result.fixedAssignments.length === 0,
    "fixed not applied on closed course"
  );
  assert(
    result.fiftyFourHoleAssignments.length === 0,
    "54hole not on closed course"
  );
  assert(
    result.closedCourseReservations.some(
      (u) => u.reservation.id === "closed-fixed"
    ),
    "closed fixed reservation kept in closed list"
  );
  assert(
    result.assignments.some((a) => a.reservation.id === "open-reg"),
    "open course still assigned"
  );
}

section("HOUSE 스페어: 100명 / 1부40 → spare 41,42 / 2부 시작 41");
{
  const date = "2026-10-10";
  const available = makeCaddies(100).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: makeReservations(date, [
      { shift: "1부", count: 40 },
      { shift: "2부", count: 5 },
    ]),
  });
  const s1 = result.sparesByShift.find((s) => s.shift === "1부")!;
  assert(s1.spare1?.caddyId === ordered[40].id, "spare1 = 41st HOUSE");
  assert(s1.spare2?.caddyId === ordered[41].id, "spare2 = 42nd HOUSE");
  const shift2 = result.assignments.filter((a) => a.shift === "2부");
  assert(shift2[0].caddy.id === ordered[40].id, "2부 first = spare1 (41)");
  assert(shift2[1].caddy.id === ordered[41].id, "2부 second overlaps spare2");
}

section("스페어 이동: 1부 팀수 39/40/41");
{
  const date = "2026-10-11";
  const available = makeCaddies(100).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const ordered = [...available].sort(compareCaddyOrder);
  for (const n of [39, 40, 41] as const) {
    const result = computeAutoAssignmentsV1({
      date,
      available,
      reservations: makeReservations(date, [{ shift: "1부", count: n }]),
    });
    const s1 = result.sparesByShift.find((s) => s.shift === "1부")!;
    assert(
      s1.spare1?.caddyId === ordered[n].id,
      `1부 ${n}팀 spare1 = index ${n}`
    );
    assert(
      s1.spare2?.caddyId === ordered[n + 1].id,
      `1부 ${n}팀 spare2 = index ${n + 1}`
    );
  }
}

section("3부: HOUSE80 사용 후 spare→THIRD→남은 HOUSE");
{
  const date = "2026-10-12";
  const house = makeCaddies(100).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const third = [
    { id: 501, name: "T1", team: "1조", teamOrder: 1, caddyType: "THIRD" },
    { id: 502, name: "T2", team: "1조", teamOrder: 2, caddyType: "THIRD" },
    { id: 503, name: "T3", team: "2조", teamOrder: 1, caddyType: "THIRD" },
  ];
  const orderedHouse = [...house].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available: [...house, ...third],
    reservations: makeReservations(date, [
      { shift: "1부", count: 40 },
      { shift: "2부", count: 40 },
      { shift: "3부", count: 8 },
    ]),
  });
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  assert(s3[0].caddy.id === orderedHouse[80].id, "3부1 = HOUSE81 (2부 spare1)");
  assert(s3[1].caddy.id === orderedHouse[81].id, "3부2 = HOUSE82 (2부 spare2)");
  assert(s3[2].caddy.id === 501, "3부3 = THIRD first");
  assert(s3[3].caddy.id === 502, "3부4 = THIRD second");
  assert(s3[4].caddy.id === 503, "3부5 = THIRD third");
  assert(s3[5].caddy.id === orderedHouse[82].id, "3부6 = HOUSE83");
  assert(s3[6].caddy.id === orderedHouse[83].id, "3부7 = HOUSE84");
  assert(result.meta.thirdPoolCount === 3, "third pool count");
  assert(result.meta.housePoolCount === 100, "house pool count");
}

section("3부 THIRD 0명");
{
  const date = "2026-10-13";
  const house = makeCaddies(20).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const ordered = [...house].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available: house,
    reservations: makeReservations(date, [
      { shift: "1부", count: 4 },
      { shift: "2부", count: 4 },
      { shift: "3부", count: 4 },
    ]),
  });
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  assert(s3[0].caddy.id === ordered[8].id, "no THIRD: starts at spare1");
  assert(s3[1].caddy.id === ordered[9].id, "then spare2");
  assert(s3[2].caddy.id === ordered[10].id, "then remaining HOUSE");
  assert(result.meta.thirdPoolCount === 0, "third 0");
}

section("special 캐디는 spare/HOUSE 순번에서 제외");
{
  const date = "2026-10-14";
  const available = makeCaddies(10).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const ordered = [...available].sort(compareCaddyOrder);
  const fiftyFourHole = [ordered[0]];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    fiftyFourHole,
    reservations: [
      ...makeReservations(date, [{ shift: "1부", count: 3, teeStart: "06:00" }]),
      {
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "06:00",
        teamName: "54a",
        rawRowIndex: 90,
      },
      {
        date,
        course: "SKY",
        shift: "2부",
        teeTime: "13:00",
        teamName: "54b",
        rawRowIndex: 91,
      },
    ],
  });
  const s1 = result.sparesByShift.find((s) => s.shift === "1부")!;
  const regularIds = new Set(
    result.regularAssignments.map((a) => a.caddy.id)
  );
  assert(!regularIds.has(ordered[0].id), "special not in regular");
  assert(
    s1.spare1 && s1.spare1.caddyId !== ordered[0].id,
    "spare excludes special"
  );
  assert(
    result.regularAssignments.every((a) => a.caddy.id !== ordered[0].id),
    "HOUSE pool excluded special"
  );
}

section("닫힌 코스는 팀수/spare 계산 제외");
{
  const date = "2026-10-15";
  const available = makeCaddies(50).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const ordered = [...available].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    openCourses: ["VERTHILL"],
    reservations: [
      ...makeReservations(date, [{ shift: "1부", count: 5 }]),
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "닫힘1",
        rawRowIndex: 200,
      },
      {
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:08",
        teamName: "닫힘2",
        rawRowIndex: 201,
      },
    ],
  });
  assert(result.meta.byShift["1부"].assigned === 5, "only open teams count");
  assert(result.closedCourseReservations.length === 2, "2 closed excluded");
  const s1 = result.sparesByShift.find((s) => s.shift === "1부")!;
  assert(s1.spare1?.caddyId === ordered[5].id, "spare after 5 open teams");
  assert(s1.spare2?.caddyId === ordered[6].id, "spare2 after open only");
}

section("DRIVING은 3부 HOUSE 순번에 섞지 않음");
{
  const date = "2026-10-16";
  const house = makeCaddies(6).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const driving = [
    { id: 900, name: "드라이브", team: "1조", teamOrder: 1, caddyType: "DRIVING" },
  ];
  const ordered = [...house].sort(compareCaddyOrder);
  const result = computeAutoAssignmentsV1({
    date,
    available: [...house, ...driving],
    reservations: makeReservations(date, [
      { shift: "1부", count: 2 },
      { shift: "2부", count: 2 },
      { shift: "3부", count: 3 },
    ]),
  });
  assert(
    !result.assignments.some((a) => a.caddy.id === 900),
    "DRIVING not auto-assigned in regular"
  );
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  assert(s3.every((a) => a.caddy.id !== 900), "3부 no DRIVING");
  assert(s3[0].caddy.id === ordered[4].id, "3부 uses HOUSE spare");
  assert(result.meta.drivingPoolCount === 1, "driving pool tracked");
}

section("reflow 후 spare/3부 순서 재계산");
{
  const date = "2026-10-17";
  const house = makeCaddies(30).map((c) => ({ ...c, caddyType: "HOUSE" }));
  const third = [
    { id: 701, name: "TH1", team: "3조", teamOrder: 1, caddyType: "THIRD" },
  ];
  const ordered = [...house].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: [...house, ...third],
    reservations: makeReservations(date, [
      { shift: "1부", count: 5 },
      { shift: "2부", count: 5 },
      { shift: "3부", count: 4 },
    ]),
  });
  assert(
    previous.sparesByShift.find((s) => s.shift === "1부")!.spare1?.caddyId ===
      ordered[5].id,
    "before: 1부 spare1 = 6th"
  );
  const first1 = previous.regularAssignments.find((a) => a.shift === "1부")!;
  const reflow2 = reflowRegularAssignments({
    previous,
    regularCaddyPool: [...house, ...third],
    events: [
      {
        type: "CANCEL_RESERVATION",
        reservationKey: reservationKey(first1.reservation),
      },
    ],
  });
  assert(reflow2.after.meta.byShift["1부"].assigned === 4, "1부 4 after cancel");
  const spareAfter = reflow2.after.sparesByShift.find((s) => s.shift === "1부")!;
  assert(
    spareAfter.spare1?.caddyId === ordered[4].id,
    "reflow spare1 moves to index 4"
  );
  assert(
    spareAfter.spare2?.caddyId === ordered[5].id,
    "reflow spare2 moves to index 5"
  );
  const s2first = reflow2.after.regularAssignments.find((a) => a.shift === "2부")!;
  assert(s2first.caddy.id === ordered[4].id, "2부 starts at new spare1");
  const s3 = reflow2.after.regularAssignments.filter((a) => a.shift === "3부");
  // 1부4 + 2부5 → houseStart 9 for 3부; spare1/2 = 9,10 then THIRD
  assert(s3[0].caddy.id === ordered[9].id, "3부 recalc spare1");
  assert(s3[1].caddy.id === ordered[10].id, "3부 recalc spare2");
  assert(s3[2].caddy.id === 701, "3부 THIRD after spares");
}

section("동일 시각 4코스: spare1/2 = 다음 부 첫 슬롯 베→스");
{
  const date = "2026-11-01";
  const available = makeCaddies(40);
  const reservations: AutoAssignReservation[] = [];
  // 1부 4슬롯 → spare1/2 확정
  for (const [course, tee] of [
    ["VERTHILL", "06:30"],
    ["SKY", "06:30"],
    ["OCEAN", "06:30"],
    ["LAKE", "06:30"],
  ] as const) {
    reservations.push({
      date,
      course,
      shift: "1부",
      teeTime: tee,
      teamName: `1-${course}`,
    });
  }
  // 2부: 11:30 4코스 + 11:37 4코스
  for (const tee of ["11:30", "11:37"] as const) {
    for (const course of COURSE_ORDER) {
      reservations.push({
        date,
        course,
        shift: "2부",
        teeTime: tee,
        teamName: `2-${tee}-${course}`,
      });
    }
  }
  const result = computeAutoAssignmentsV1({ date, available, reservations });
  const s2queue = result.regularAssignments.filter((a) => a.shift === "2부");
  assert(s2queue.length === 8, "2부 8 slots");
  assert(
    s2queue.map((a) => `${a.reservation.teeTime}|${a.reservation.course}`).join(",") ===
      [
        "11:30|VERTHILL",
        "11:30|SKY",
        "11:30|OCEAN",
        "11:30|LAKE",
        "11:37|VERTHILL",
        "11:37|SKY",
        "11:37|OCEAN",
        "11:37|LAKE",
      ].join(","),
    "2부 queue tee then course"
  );
  const spare1 = result.sparesByShift.find((s) => s.shift === "1부")?.spare1;
  assert(spare1 != null, "1부 spare1 exists");
  assert(s2queue[0].caddy.id === spare1!.caddyId, "spare1 → 11:30 VERTHILL");
  assert(s2queue[1].reservation.course === "SKY", "spare2 slot → 11:30 SKY");
  assert(s2queue[2].reservation.course === "OCEAN", "next → 11:30 OCEAN");
  assert(s2queue[3].reservation.course === "LAKE", "next → 11:30 LAKE");
  assert(s2queue[4].reservation.teeTime === "11:37", "then 11:37 VERTHILL");
  assert(s2queue[4].reservation.course === "VERTHILL", "11:37 starts VERTHILL");
}

section("일부 코스 예약 없음 / Close 시 슬롯 스킵");
{
  const date = "2026-11-02";
  const available = makeCaddies(30);
  const reservations: AutoAssignReservation[] = [
    { date, course: "VERTHILL", shift: "1부", teeTime: "06:30", teamName: "v" },
    { date, course: "SKY", shift: "1부", teeTime: "06:30", teamName: "s" },
    // 2부: 11:30에 OCEAN 없음, LAKE Close
    { date, course: "VERTHILL", shift: "2부", teeTime: "11:30", teamName: "v2" },
    { date, course: "SKY", shift: "2부", teeTime: "11:30", teamName: "s2" },
    { date, course: "LAKE", shift: "2부", teeTime: "11:30", teamName: "l2" },
    { date, course: "VERTHILL", shift: "2부", teeTime: "11:37", teamName: "v3" },
    { date, course: "OCEAN", shift: "2부", teeTime: "11:37", teamName: "o3" },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    openCourses: ["VERTHILL", "SKY", "OCEAN"], // LAKE close
  });
  const s2 = result.regularAssignments.filter((a) => a.shift === "2부");
  assert(
    s2.map((a) => `${a.reservation.teeTime}|${a.reservation.course}`).join(",") ===
      ["11:30|VERTHILL", "11:30|SKY", "11:37|VERTHILL", "11:37|OCEAN"].join(","),
    "skip missing OCEAN@11:30 and closed LAKE"
  );
  assert(
    result.closedCourseReservations.some(
      (u) => u.reservation.course === "LAKE"
    ),
    "LAKE closed recorded"
  );
}

section("reflow 후에도 teeTime→courseOrder 유지");
{
  const date = "2026-11-03";
  const available = makeCaddies(30);
  const reservations: AutoAssignReservation[] = [];
  for (const course of COURSE_ORDER) {
    reservations.push({
      date,
      course,
      shift: "1부",
      teeTime: "06:30",
      teamName: `1-${course}`,
      id: `1-${course}`,
    });
  }
  for (const tee of ["11:30", "11:37"] as const) {
    for (const course of COURSE_ORDER) {
      reservations.push({
        date,
        course,
        shift: "2부",
        teeTime: tee,
        teamName: `2-${tee}-${course}`,
        id: `2-${tee}-${course}`,
      });
    }
  }
  const previous = computeAutoAssignmentsV1({ date, available, reservations });
  const cancelId = previous.regularAssignments.find(
    (a) => a.shift === "1부" && a.reservation.course === "SKY"
  )!.reservation.id!;
  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: available,
    events: [{ type: "CANCEL_RESERVATION", reservationId: cancelId }],
  });
  const s2 = reflow.after.regularAssignments.filter((a) => a.shift === "2부");
  assert(
    s2.map((a) => `${a.reservation.teeTime}|${a.reservation.course}`).join(",") ===
      [
        "11:30|VERTHILL",
        "11:30|SKY",
        "11:30|OCEAN",
        "11:30|LAKE",
        "11:37|VERTHILL",
        "11:37|SKY",
        "11:37|OCEAN",
        "11:37|LAKE",
      ].join(","),
    "reflow keeps teeTime→course queue"
  );
  const spare1 = reflow.after.sparesByShift.find((s) => s.shift === "1부")?.spare1;
  assert(s2[0].caddy.id === spare1?.caddyId, "reflow spare1 → 11:30 V");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
