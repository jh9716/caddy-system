/**
 * 9/7 historical dry-run에 입력이 없어 확인 못한 엔진 규칙 fixture.
 * DB / production write 없음.
 *
 * 실행: npm run test:auto-assign-ops-gap-fixtures-unit
 */
import {
  compareReservationOrder,
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  emptySpecialSupportByShift,
  oneTwoSupportPairId,
} from "../src/lib/dailySpecialSupport";

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

function house(id: number, order: number): AutoAssignCaddy {
  return {
    id,
    name: `H${id}`,
    team: `${((order - 1) % 8) + 1}조`,
    teamOrder: order,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function third(
  id: number,
  order: number,
  extra?: Partial<AutoAssignCaddy>
): AutoAssignCaddy {
  return {
    id,
    name: `T${id}`,
    team: "9조",
    teamOrder: order,
    caddyType: "THIRD",
    employmentStatus: "ACTIVE",
    ...extra,
  };
}

function support(
  id: number,
  name: string,
  kind: string,
  pattern: string,
  inputOrder: number
): AutoAssignCaddy {
  return {
    id,
    name,
    team: "1조",
    teamOrder: id,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
    supportKind: kind,
    supportWorkPattern: pattern,
    inputOrder,
  };
}

function res(
  date: string,
  shift: "1부" | "2부" | "3부",
  tee: string,
  course: "VERTHILL" | "SKY" | "OCEAN" | "LAKE",
  i: number
): AutoAssignReservation {
  return {
    date,
    course,
    courseLabel: course,
    shift,
    teeTime: tee,
    teamName: `${shift}-${course}-${i}`,
    rawRowIndex: i,
  };
}

function shiftRes(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  teeStart = "06:00"
): AutoAssignReservation[] {
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  const [hh, mm] = teeStart.split(":").map(Number);
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < count; i++) {
    const total = hh * 60 + mm + Math.floor(i / 4) * 8;
    const h = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    out.push(res(date, shift, `${h}:${m}`, courses[i % 4], i + 1));
  }
  return out;
}

function sortedShift(
  result: { assignments: Array<{ shift: string; reservation: AutoAssignReservation }> },
  shift: "1부" | "2부" | "3부"
) {
  return result.assignments
    .filter((a) => a.shift === shift)
    .sort((a, b) => compareReservationOrder(a.reservation, b.reservation));
}

section("후출마샬 MARSHAL_SUPPORT+SHIFT_1: 보호 다음, 1막 금지");
{
  const date = "2026-06-10";
  const m1 = support(101, "후출1", "MARSHAL_SUPPORT", "SHIFT_1", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available: [1, 2, 3, 4, 5, 6].map((n) => house(n, n)),
    reservations: [
      ...shiftRes(date, "1부", 8),
      ...shiftRes(date, "2부", 6, "12:00"),
      ...shiftRes(date, "3부", 4, "16:00"),
    ],
    protectedTailCount: 4,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [m1],
    },
  });
  const s1 = sortedShift(result, "1부");
  assert(s1[0]?.kind === "regular" && s1[1]?.kind === "regular", "보호1·2는 HOUSE");
  assert(
    s1[2]?.caddy.id === 101 &&
      s1[2]?.kind === "specialSupport" &&
      s1[2]?.supportKind === "MARSHAL_SUPPORT",
    "3번째가 후출마샬"
  );
  assert(s1[2]?.kind !== "oneMak", "후출마샬을 oneMak로 변환하지 않음");
  assert(
    !result.assignments.some((a) => a.caddy.id === 101 && a.kind === "oneMak"),
    "후출마샬 1막 행 없음"
  );
}

section("휴무지원 OFF_SUPPORT+SHIFT_3: 1·3/주말반 다음, 원번 앞");
{
  const date = "2026-06-13";
  const available = [1, 2, 3, 4].map((n) => house(n, n));
  const tA = third(201, 1);
  const tB = third(202, 2, { team: "10조" });
  const weekend = third(301, 3, { team: "11조", thirdBandSubgroup: "WEEKEND" });
  const oneThree: AutoAssignCaddy = {
    id: 40,
    name: "일삼",
    team: "4조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const twoThree: AutoAssignCaddy = {
    id: 50,
    name: "이삼",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const off = support(71, "휴1", "OFF_SUPPORT", "SHIFT_3", 1);
  const reservations = [
    ...shiftRes(date, "1부", 8),
    ...shiftRes(date, "2부", 6, "12:00"),
    ...shiftRes(date, "3부", 12, "16:00"),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, tA, tB, weekend, oneThree, twoThree],
    oneThreeCandidates: [oneThree],
    twoThreeCandidates: [twoThree],
    protectedTailCount: 2,
    reservations,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [off],
    },
  });
  const s3 = sortedShift(result, "3부");
  const i13 = s3.findIndex((a) => a.kind === "oneThree");
  const iWk = s3.findIndex((a) => a.caddy.id === 301);
  const iOff = s3.findIndex((a) => a.caddy.id === 71);
  const iThird = s3.findIndex((a) => a.caddy.id === 201);
  assert(i13 === 0, "1·3 맨 앞");
  assert(iWk === 1 && s3[iWk]?.reason === "WEEKEND_BAND_PRIORITY", "주말반이 1·3 다음");
  assert(iOff === 2, "휴무지원이 주말반 다음");
  assert(iThird > iOff, "3부 원번은 휴무지원 다음");
  assert(
    s3[iOff]?.kind === "specialSupport" && s3[iOff]?.supportKind === "OFF_SUPPORT",
    "휴무지원은 OFF_SUPPORT 유지"
  );
  assert(s3[iOff]?.kind !== "oneMak", "휴무지원을 SPECIAL/1막으로 변환하지 않음");
}

section("2·3: 3부 원번 뒤, 찾근 앞");
{
  const date = "2026-06-10";
  const tA = third(201, 1);
  const tB = third(202, 2, { team: "10조" });
  const twoThree: AutoAssignCaddy = {
    id: 50,
    name: "이삼",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const chageun: AutoAssignCaddy = {
    id: 60,
    name: "찾근",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 6, "12:00"),
    ...shiftRes(date, "3부", 6, "16:00"),
  ];
  const shift3 = reservations.filter((r) => r.shift === "3부");
  const result = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2), tA, tB, twoThree, chageun],
    twoThreeCandidates: [twoThree],
    thirdStartTeam: "9조",
    reservations,
    fixedAssignments: [
      {
        caddyId: 60,
        type: "SPECIAL_CALL",
        reservationMatch: {
          date,
          course: shift3[0].course,
          shift: "3부",
          teeTime: shift3[0].teeTime,
          teamName: shift3[0].teamName,
        },
      },
    ],
  });
  const s3 = sortedShift(result, "3부");
  const iThirdLast = Math.max(
    s3.findIndex((a) => a.caddy.id === 201),
    s3.findIndex((a) => a.caddy.id === 202)
  );
  const i23 = s3.findIndex((a) => a.kind === "twoThree");
  const iCh = s3.findIndex((a) => a.caddy.id === 60);
  assert(i23 > iThirdLast, "2·3은 3부 원번 완주 뒤");
  assert(iCh > i23, "찾근은 2·3 앞이 아니라 뒤");
  assert(s3[i23]?.pairId === "23-50", "2·3 pairId");
}

section("ONE_TWO 지원: 1부/2부 동일 sortOrder + SUP12");
{
  const date = "2026-06-10";
  const a = support(301, "A", "SPECIAL_SUPPORT", "ONE_TWO", 1);
  const b = support(302, "B", "SPECIAL_SUPPORT", "ONE_TWO", 2);
  const result = computeAutoAssignmentsV1({
    date,
    available: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => house(n, n)),
    reservations: [
      ...shiftRes(date, "1부", 12),
      ...shiftRes(date, "2부", 14, "12:00"),
      ...shiftRes(date, "3부", 4, "16:00"),
    ],
    protectedTailCount: 2,
    oneTwoSupport: [b, a],
  });
  const s1 = sortedShift(result, "1부").filter((row) => [301, 302].includes(row.caddy.id));
  const s2 = sortedShift(result, "2부").filter((row) => [301, 302].includes(row.caddy.id));
  assert(s1.map((row) => row.caddy.id).join(",") === "301,302", "1부 sortOrder A→B");
  assert(s2.map((row) => row.caddy.id).join(",") === "301,302", "2부 동일 sortOrder");
  assert(
    s1[0]?.pairId === oneTwoSupportPairId(301) && s2[0]?.pairId === s1[0]?.pairId,
    "A의 SUP12 pairId 1부=2부"
  );
  assert(
    s1[1]?.pairId === oneTwoSupportPairId(302) && s2[1]?.pairId === s1[1]?.pairId,
    "B의 SUP12 pairId 1부=2부"
  );
  assert(
    s1.every((row) => row.kind === "specialSupport") &&
      s2.every((row) => row.kind === "specialSupport"),
    "특수근무 oneTwo로 변환하지 않음"
  );
}

section("조출마샬/조장 SHIFT_2: 2부 막, 3부 금지");
{
  const date = "2026-06-10";
  const early = support(41, "조출", "MARSHAL_SUPPORT", "SHIFT_2", 1);
  const leader = support(42, "조장", "LEADER_SUPPORT", "SHIFT_2", 2);
  const result = computeAutoAssignmentsV1({
    date,
    available: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => house(n, n)),
    reservations: [
      ...shiftRes(date, "1부", 6),
      ...shiftRes(date, "2부", 10, "12:00"),
      ...shiftRes(date, "3부", 6, "16:00"),
    ],
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "2부": [early, leader],
    },
  });
  const s2 = sortedShift(result, "2부");
  assert(s2[s2.length - 2]?.caddy.id === 41, "조출마샬 2부 막-1");
  assert(s2[s2.length - 1]?.caddy.id === 42, "조장 2부 막");
  assert(
    !result.assignments.some(
      (a) => a.shift === "3부" && (a.caddy.id === 41 || a.caddy.id === 42)
    ),
    "조출마샬/조장 3부 자동배치 금지"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
