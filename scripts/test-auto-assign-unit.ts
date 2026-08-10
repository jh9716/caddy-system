/**
 * 자동배치 v1 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-auto-assign-unit.ts
 */

import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  findEarliest54HolePair,
  findOneThreePair,
  isCompatible54HolePair,
  isCompatibleOneThreePair,
  minutesBetweenReservations,
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

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
