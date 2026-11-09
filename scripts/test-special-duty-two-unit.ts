/**
 * 특수근무 2부 단독: 지정 코스+시간 정확 일치 (DB 없음)
 * 실행: npx tsx scripts/test-special-duty-two-unit.ts
 */
import {
  computeAutoAssignmentsV1,
  REASON,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignmentRow,
} from "../src/lib/autoAssignEngine";
import {
  assignTwoOnlyExactSlots,
  matchesExactShift2Reservation,
  TWO_ONLY_REASON,
  type TwoOnlyCandidate,
} from "../src/lib/specialDutyTwo";
import { buildEngineSpecialBundles, DAILY_SPECIAL_KIND_LABELS } from "../src/lib/dailySpecialDuty";
import fs from "node:fs";

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

function caddy(
  id: number,
  extra: Partial<AutoAssignCaddy> = {}
): AutoAssignCaddy {
  return {
    id,
    name: extra.name || `캐디${id}`,
    team: extra.team || "7조",
    teamOrder: extra.teamOrder ?? 1,
    caddyType: extra.caddyType || "HOUSE",
  };
}

function res(
  extra: Partial<AutoAssignReservation> & { teeTime: string; course: string }
): AutoAssignReservation {
  return {
    date: extra.date || "2026-09-16",
    course: extra.course,
    shift: extra.shift || "2부",
    teeTime: extra.teeTime,
    teamName: extra.teamName || extra.teeTime,
  };
}

function twoCand(
  id: number,
  course: string,
  teeTime: string,
  extra: Partial<AutoAssignCaddy> = {}
): TwoOnlyCandidate {
  return { ...caddy(id, extra), course, teeTime };
}

section("라벨 · 정확 일치만");
{
  assert(DAILY_SPECIAL_KIND_LABELS.TWO === "2부", "2부 라벨");
  const hit = res({ course: "VERTHILL", teeTime: "12:30", shift: "2부" });
  assert(
    matchesExactShift2Reservation(hit, { course: "VERTHILL", teeTime: "12:30" }),
    "동일 코스·시간 일치"
  );
  assert(
    !matchesExactShift2Reservation(hit, { course: "VERTHILL", teeTime: "12:31" }),
    "1분 차이 불일치"
  );
  assert(
    !matchesExactShift2Reservation(hit, { course: "SKY", teeTime: "12:30" }),
    "다른 코스 불일치"
  );
  assert(
    !matchesExactShift2Reservation(
      { ...hit, shift: "1부" },
      { course: "VERTHILL", teeTime: "12:30" }
    ),
    "1부 불일치"
  );
}

section("지정 예약만 배치 · 근접 대체 없음");
{
  const date = "2026-09-16";
  const remaining = [
    res({ course: "VERTHILL", teeTime: "12:22", shift: "2부" }),
    res({ course: "VERTHILL", teeTime: "12:30", shift: "2부" }),
    res({ course: "SKY", teeTime: "12:30", shift: "2부" }),
    res({ course: "VERTHILL", teeTime: "12:38", shift: "2부" }),
  ];
  const placed = assignTwoOnlyExactSlots({
    date,
    candidates: [twoCand(71, "VERTHILL", "12:30", { name: "신정훈" })],
    remaining,
  });
  assert(placed.assignments.length === 1, "1명 배치");
  assert(placed.assignments[0]?.reservation.course === "VERTHILL", "베르힐");
  assert(placed.assignments[0]?.reservation.teeTime === "12:30", "12:30만");
  assert(placed.assignments[0]?.kind === "two", "kind=two");
  assert(placed.assignments[0]?.locked === true, "LOCK");
  assert(
    placed.assignments[0]?.reason === TWO_ONLY_REASON.PRIORITY,
    "TWO_ONLY_PRIORITY"
  );
  assert(
    !placed.remainingReservations.some(
      (r) => r.course === "VERTHILL" && r.teeTime === "12:30"
    ),
    "지정 슬롯 remaining에서 제거"
  );
  assert(
    placed.remainingReservations.some((r) => r.teeTime === "12:38"),
    "가까운 12:38은 남김"
  );
}

section("지정 예약 없음 → 미배치 경고");
{
  const placed = assignTwoOnlyExactSlots({
    date: "2026-09-16",
    candidates: [twoCand(71, "VERTHILL", "12:30", { name: "신정훈" })],
    remaining: [
      res({ course: "VERTHILL", teeTime: "12:22", shift: "2부" }),
      res({ course: "SKY", teeTime: "12:38", shift: "2부" }),
    ],
  });
  assert(placed.assignments.length === 0, "배치 없음");
  assert(
    placed.specialUnassigned[0]?.reason === TWO_ONLY_REASON.MISSING_RESERVATION,
    "MISSING_RESERVATION"
  );
  assert(
    String(placed.specialUnassigned[0]?.note || "").includes("12:30"),
    "경고에 지정 시간"
  );
}

section("점유 예약 · 동일 캐디 중복은 충돌");
{
  const date = "2026-09-16";
  const slot = res({ course: "VERTHILL", teeTime: "12:30", shift: "2부" });
  const occupied: AutoAssignmentRow[] = [
    {
      date,
      shift: "2부",
      sequenceIndex: 0,
      reason: REASON.FIXED_ASSIGNMENT,
      reservation: slot,
      caddy: caddy(9, { name: "고정" }),
      kind: "fixed",
      locked: true,
    },
  ];
  const conflict = assignTwoOnlyExactSlots({
    date,
    candidates: [twoCand(71, "VERTHILL", "12:30")],
    remaining: [res({ course: "SKY", teeTime: "12:30", shift: "2부" })],
    occupiedReservations: occupied,
  });
  assert(
    conflict.specialUnassigned[0]?.reason === TWO_ONLY_REASON.RESERVATION_CONFLICT,
    "점유 충돌"
  );

  const dupCaddy = assignTwoOnlyExactSlots({
    date,
    candidates: [
      twoCand(71, "VERTHILL", "12:30"),
      twoCand(71, "SKY", "12:30"),
    ],
    remaining: [
      res({ course: "VERTHILL", teeTime: "12:30", shift: "2부" }),
      res({ course: "SKY", teeTime: "12:30", shift: "2부" }),
    ],
  });
  assert(dupCaddy.assignments.length === 1, "첫 슬롯만 배치");
  assert(
    dupCaddy.specialUnassigned.some(
      (u) => u.reason === TWO_ONLY_REASON.CADDY_CONFLICT
    ),
    "같은 캐디 둘째는 충돌"
  );
}

section("엔진 본선: 지정 시간만 · 다른 특수 우선순위 유지");
{
  const date = "2026-09-16";
  const houses = Array.from({ length: 12 }, (_, i) =>
    caddy(i + 1, { name: `H${i + 1}`, team: `${(i % 8) + 1}조`, teamOrder: 1 })
  );
  const shin = twoCand(71, "VERTHILL", "12:30", { name: "신정훈", team: "7조" });
  const reservations: AutoAssignReservation[] = [];
  for (const shift of ["1부", "2부", "3부"] as const) {
    const start = shift === "1부" ? 6 : shift === "2부" ? 12 : 16;
    for (let i = 0; i < 8; i++) {
      const mm = String((i % 4) * 8).padStart(2, "0");
      const hh = String(start + Math.floor(i / 4)).padStart(2, "0");
      reservations.push({
        date,
        course: (["VERTHILL", "SKY", "OCEAN", "LAKE"] as const)[i % 4],
        shift,
        teeTime: `${hh}:${mm}`,
        teamName: `${shift}-${i}`,
      });
    }
  }
  reservations.push({
    date,
    course: "VERTHILL",
    shift: "2부",
    teeTime: "12:30",
    teamName: "지정팀",
  });
  const result = computeAutoAssignmentsV1({
    date,
    available: [...houses, shin],
    twoCandidates: [shin],
    reservations,
  });
  const hit = result.twoAssignments.find((a) => a.caddy.id === 71);
  assert(!!hit, "twoAssignments에 신정훈");
  assert(hit?.reservation.teeTime === "12:30", "12:30");
  assert(hit?.reservation.course === "VERTHILL", "VERTHILL");
  assert(
    result.assignments.filter((a) => a.caddy.id === 71).length === 1,
    "중복배치 없음"
  );
}

section("번들: TWO 후보가 엔진 입력으로 연결");
{
  const bundles = buildEngineSpecialBundles(
    [
      {
        kind: "TWO",
        caddyId: 71,
        sortOrder: 1,
        name: "신정훈",
        team: "7조",
        teamOrder: 1,
        course: "VERTHILL",
        teeTime: "12:30",
      },
    ],
    new Map()
  );
  assert(bundles.twoCandidates?.[0]?.id === 71, "TWO 후보");
  assert(bundles.twoCandidates?.[0]?.specialCourse === "VERTHILL", "코스 유지");
  assert(bundles.twoCandidates?.[0]?.specialTeeTime === "12:30", "시간 유지");
}

section("UI 소스: 2부 단독 등록");
{
  const panel = fs.readFileSync(
    "src/app/manage/assignments/SpecialDutyPanel.tsx",
    "utf8"
  );
  assert(panel.includes("shift2Options"), "2부 시간 옵션");
  assert(panel.includes("updateSlot"), "지정 예약 수정");
  assert(panel.includes("지정한 2부 코스"), "안내 문구");
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nALL PASSED ${passed}`);
