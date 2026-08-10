/**
 * 자동배치 v1 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-auto-assign-unit.ts
 */

import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
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

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
