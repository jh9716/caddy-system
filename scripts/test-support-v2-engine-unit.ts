/**
 * 지원근무 V2 단일부 자동배치 엔진 단위 테스트 (DB 없음)
 * 실행: npm run test:support-v2-engine-unit
 */

import {
  compareReservationOrder,
  computeAutoAssignmentsV1,
  SHIFT2_PROTECTED_COUNT,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  boardAssignmentMarks,
} from "../src/lib/assignmentBoardView";
import {
  emptySpecialSupportByShift,
  engineQueuesFromSupportRecords,
  groupSupportRecordsByShift,
  isEngineEligibleSupportRecord,
  supportBoardBadgeLabels,
  type SpecialSupportRecord,
} from "../src/lib/dailySpecialSupport";

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
    team: "7조",
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
    supportKind: kind,
    supportWorkPattern: pattern,
    inputOrder,
  };
}

function rec(
  kind: SpecialSupportRecord["kind"],
  workPattern: SpecialSupportRecord["workPattern"],
  caddyId: number,
  sortOrder: number,
  shift: string
): SpecialSupportRecord {
  return {
    date: "2026-06-10",
    caddyId,
    shift,
    kind,
    workPattern,
    sortOrder,
    name: `C${caddyId}`,
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

section("엔진 적격: 단일부만, 1·2/54/3부마샬 제외");
{
  assert(
    isEngineEligibleSupportRecord(rec("SPECIAL_SUPPORT", "SHIFT_1", 1, 1, "1부")),
    "레거시 특수지원 1부"
  );
  assert(
    isEngineEligibleSupportRecord(rec("MARSHAL_SUPPORT", "SHIFT_1", 2, 1, "1부")),
    "후출마샬 1부"
  );
  assert(
    isEngineEligibleSupportRecord(rec("OFF_SUPPORT", "SHIFT_3", 3, 1, "3부")),
    "휴무지원 3부"
  );
  assert(
    !isEngineEligibleSupportRecord(rec("OFF_SUPPORT", "SHIFT_1", 4, 1, "1부")),
    "휴무지원 1부 미배치"
  );
  assert(
    !isEngineEligibleSupportRecord(rec("MARSHAL_SUPPORT", "SHIFT_3", 5, 1, "3부")),
    "마샬 3부 미배치"
  );
  assert(
    !isEngineEligibleSupportRecord(rec("LEADER_SUPPORT", "SHIFT_1", 6, 1, "1부")),
    "조장 1부 미배치"
  );
  assert(
    !isEngineEligibleSupportRecord(rec("FIFTY_FOUR_SUPPORT", "FIFTY_FOUR", 7, 1, "54")),
    "54지원 미배치"
  );
  assert(
    !isEngineEligibleSupportRecord(rec("SPECIAL_SUPPORT", "ONE_TWO", 8, 1, "1·2부")),
    "ONE_TWO 지원 미배치"
  );
  const legacy: SpecialSupportRecord = { date: "2026-06-10", caddyId: 9, shift: "2부" };
  assert(isEngineEligibleSupportRecord(legacy), "kind 없는 기존 row는 특수지원");
  const queues = engineQueuesFromSupportRecords(
    groupSupportRecordsByShift([
      rec("MARSHAL_SUPPORT", "SHIFT_1", 11, 2, "1부"),
      rec("MARSHAL_SUPPORT", "SHIFT_1", 10, 1, "1부"),
      rec("OFF_SUPPORT", "SHIFT_3", 20, 1, "3부"),
      rec("MARSHAL_SUPPORT", "SHIFT_3", 30, 1, "3부"),
    ])
  );
  assert(
    queues["1부"].map((c) => c.id).join(",") === "10,11",
    "후출마샬 sortOrder 유지"
  );
  assert(queues["3부"].map((c) => c.id).join(",") === "20", "3부 큐는 휴무만 (마샬 3부 제외)");
}

section("1부: 보호1 → 보호2 → 후출마샬 → 이후 기존 흐름");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4, 5, 6].map((n) => house(n, n));
  const m1 = support(101, "후출1", "MARSHAL_SUPPORT", "SHIFT_1", 1);
  const m2 = support(102, "후출2", "MARSHAL_SUPPORT", "SHIFT_1", 2);
  const special = support(110, "특수1", "SPECIAL_SUPPORT", "SHIFT_1", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [
      ...shiftRes(date, "1부", 10),
      ...shiftRes(date, "2부", 6, "12:00"),
      ...shiftRes(date, "3부", 4, "16:00"),
    ],
    protectedTailCount: 2,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [m1, m2, special],
    },
  });
  const s1 = sortedShift(result, "1부");
  assert(s1[0]?.kind === "regular" && s1[1]?.kind === "regular", "1·2번째는 보호 HOUSE");
  assert(
    s1[2]?.kind === "specialSupport" &&
      s1[2]?.caddy.id === 101 &&
      s1[2]?.supportKind === "MARSHAL_SUPPORT" &&
      s1[2]?.supportWorkPattern === "SHIFT_1",
    "3번째가 후출마샬 1 (sortOrder)"
  );
  assert(
    s1[3]?.kind === "specialSupport" && s1[3]?.caddy.id === 102,
    "4번째가 후출마샬 2 (sortOrder)"
  );
  assert(s1[2]?.kind !== "oneMak" && s1[3]?.kind !== "oneMak", "후출마샬은 1막이 아님");
  const badges = supportBoardBadgeLabels(s1[2]?.supportKind, s1[2]?.supportWorkPattern);
  assert(badges.kind === "마" && badges.pattern === "1", "배치표 [마][1]");
  assert(
    boardAssignmentMarks(s1[2] as never, result.assignments).specialSupport,
    "후출마샬은 specialSupport 마크"
  );
  const specialRow = s1.find((a) => a.caddy.id === 110);
  assert(
    specialRow?.kind === "specialSupport" &&
      specialRow.supportKind === "SPECIAL_SUPPORT" &&
      s1.findIndex((a) => a.caddy.id === 110) > 3,
    "특수지원은 후출마샬 이후 기존 AUTO 창"
  );
}

section("2부: 원번 소진 후 지원 → 1·2 투, 조출/조장은 막");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => house(n, n));
  const oneTwo: AutoAssignCaddy = {
    id: 30,
    name: "일이부",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const sp1 = support(21, "특2-1", "SPECIAL_SUPPORT", "SHIFT_2", 1);
  const sp2 = support(22, "특2-2", "SPECIAL_SUPPORT", "SHIFT_2", 2);
  const early = support(41, "조출", "MARSHAL_SUPPORT", "SHIFT_2", 1);
  const leader = support(42, "조장", "LEADER_SUPPORT", "SHIFT_2", 2);
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, oneTwo],
    oneTwoCandidates: [oneTwo],
    reservations: [
      ...shiftRes(date, "1부", 5),
      ...shiftRes(date, "2부", 12, "12:00"),
      ...shiftRes(date, "3부", 4, "16:00"),
    ],
    protectedTailCount: 2,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "2부": [sp1, sp2, early, leader],
    },
  });
  const s2 = sortedShift(result, "2부");
  assert(s2[0]?.kind !== "specialSupport" && s2[1]?.kind !== "specialSupport", "2부 보호 1·2");
  const supportIdx = s2
    .map((a, i) => (a.kind === "specialSupport" ? i : -1))
    .filter((i) => i >= 0);
  const mid = s2.filter(
    (a) =>
      a.kind === "specialSupport" &&
      (a.caddy.id === 21 || a.caddy.id === 22)
  );
  const oneTwoIdx = s2.findIndex((a) => a.kind === "oneTwo");
  const midIdx = s2.findIndex((a) => a.caddy.id === 21);
  const mid2Idx = s2.findIndex((a) => a.caddy.id === 22);
  assert(midIdx === 4 && mid2Idx === 5, `원번 4칸 다음 지원 (${midIdx},${mid2Idx})`);
  assert(
    mid[0]?.caddy.id === 21 && mid[1]?.caddy.id === 22,
    "2부 지원 그룹 sortOrder"
  );
  assert(oneTwoIdx === 6, `지원 다음 1·2 투 (${oneTwoIdx})`);
  assert(s2[oneTwoIdx]?.pairId === "12-30", "1·2 pairId 유지");
  assert(
    s2.slice(0, 4).every((a) => a.caddy.id !== 21 && a.caddy.id !== 22),
    "지원은 원번 중간에 끼지 않음"
  );
  const tail = s2.filter(
    (a) => a.caddy.id === 41 || a.caddy.id === 42
  );
  assert(
    tail.length === 2 &&
      s2[s2.length - 2]?.caddy.id === 41 &&
      s2[s2.length - 1]?.caddy.id === 42,
    "조출마샬·조장은 2부 막 sortOrder"
  );
  assert(
    tail.every((a) => a.kind === "specialSupport" && a.kind !== "oneMak"),
    "조출/조장은 1막이 아님"
  );
  assert(
    supportBoardBadgeLabels(s2[midIdx]?.supportKind, s2[midIdx]?.supportWorkPattern)
      .kind === "특" &&
      supportBoardBadgeLabels(s2[s2.length - 1]?.supportKind, s2[s2.length - 1]?.supportWorkPattern)
        .kind === "조",
    "2부 [특][2] / [조][2]"
  );
  void supportIdx;
}

section("2부 2·3은 보호 다음, pairId 유지");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4].map((n) => house(n, n));
  const twoThree: AutoAssignCaddy = {
    id: 50,
    name: "이삼",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const sp = support(21, "특2", "SPECIAL_SUPPORT", "SHIFT_2", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, twoThree],
    twoThreeCandidates: [twoThree],
    reservations: [
      ...shiftRes(date, "1부", 4),
      ...shiftRes(date, "2부", 8, "12:00"),
      ...shiftRes(date, "3부", 6, "16:00"),
    ],
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "2부": [sp],
    },
  });
  const s2 = sortedShift(result, "2부");
  assert(SHIFT2_PROTECTED_COUNT === 2, "2부 보호 상수");
  assert(s2[2]?.kind === "twoThree" && s2[2]?.pairId === "23-50", "2부 3번째 2·3 pairId");
  const s3 = sortedShift(result, "3부");
  const t3 = s3.find((a) => a.kind === "twoThree");
  assert(t3?.pairId === "23-50", "3부 2·3 pairId 동일");
  const spIdx = s2.findIndex((a) => a.caddy.id === 21);
  assert(spIdx > 2, "2부 지원은 2·3 뒤");
}

section("2부 찾근은 보호 다음, 지원보다 앞");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4, 5, 6].map((n) => house(n, n));
  const chageun: AutoAssignCaddy = {
    id: 60,
    name: "찾근2",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const sp = support(21, "특2", "SPECIAL_SUPPORT", "SHIFT_2", 1);
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 8, "12:00"),
    ...shiftRes(date, "3부", 4, "16:00"),
  ];
  const shift2 = reservations.filter((r) => r.shift === "2부");
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, chageun],
    reservations,
    fixedAssignments: [
      {
        caddyId: 60,
        type: "SPECIAL_CALL",
        reservationMatch: {
          date,
          course: shift2[2]!.course,
          shift: "2부",
          teeTime: shift2[2]!.teeTime,
          teamName: shift2[2]!.teamName,
        },
      },
    ],
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "2부": [sp],
    },
  });
  const s2 = sortedShift(result, "2부");
  assert(s2[0]?.kind !== "specialSupport" && s2[1]?.kind !== "specialSupport", "2부 보호 1·2");
  assert(
    s2[2]?.caddy.id === 60 &&
      s2[2]?.kind === "fixed" &&
      s2[2]?.reason === "SPECIAL_CALL",
    "찾근은 보호 다음 지정 예약"
  );
  const spIdx = s2.findIndex((a) => a.caddy.id === 21);
  assert(spIdx > 2, "지원은 찾근·원번 뒤");
  assert(s2[spIdx]?.kind === "specialSupport", "2부 지원 kind 유지");
}

section("3부: 1·3 → 주말반 → 휴무지원 → 원번 → 2·3 → 찾근 → HOUSE");
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
  const chageun: AutoAssignCaddy = {
    id: 60,
    name: "찾근",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const off1 = support(71, "휴1", "OFF_SUPPORT", "SHIFT_3", 1);
  const off2 = support(72, "휴2", "OFF_SUPPORT", "SHIFT_3", 2);
  const special3 = support(80, "특3", "SPECIAL_SUPPORT", "SHIFT_3", 1);
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 6, "12:00"),
    ...shiftRes(date, "3부", 12, "16:00"),
  ];
  const shift3 = reservations.filter((r) => r.shift === "3부");
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, tA, tB, weekend, oneThree, twoThree, chageun],
    oneThreeCandidates: [oneThree],
    twoThreeCandidates: [twoThree],
    protectedTailCount: 2,
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
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [off1, off2, special3],
    },
  });
  const s3 = sortedShift(result, "3부");
  const ids = s3.map((a) => `${a.kind}:${a.caddy.id}`).join(",");
  const i13 = s3.findIndex((a) => a.kind === "oneThree");
  const iWk = s3.findIndex((a) => a.caddy.id === 301);
  const iOff1 = s3.findIndex((a) => a.caddy.id === 71);
  const iOff2 = s3.findIndex((a) => a.caddy.id === 72);
  const iThird = s3.findIndex((a) => a.caddy.id === 201);
  const i23 = s3.findIndex((a) => a.kind === "twoThree");
  const iCh = s3.findIndex((a) => a.caddy.id === 60);
  const iHouse = s3.findIndex(
    (a) => a.kind === "regular" && a.caddy.caddyType === "HOUSE"
  );
  const iSp3 = s3.findIndex((a) => a.caddy.id === 80);
  assert(i13 === 0, `1·3이 3부 맨 앞 (${ids})`);
  assert(iWk === 1 && s3[iWk]?.reason === "WEEKEND_BAND_PRIORITY", "주말반이 1·3 다음");
  assert(iOff1 === 2 && iOff2 === 3, "휴무지원이 주말반 다음 sortOrder");
  assert(
    s3[iOff1]?.kind === "specialSupport" &&
      s3[iOff1]?.supportKind === "OFF_SUPPORT" &&
      s3[iOff1]?.supportWorkPattern === "SHIFT_3",
    "휴무지원은 OFF_SUPPORT 유지"
  );
  assert(
    supportBoardBadgeLabels(s3[iOff1]?.supportKind, s3[iOff1]?.supportWorkPattern)
      .kind === "휴" &&
      supportBoardBadgeLabels(s3[iOff1]?.supportKind, s3[iOff1]?.supportWorkPattern)
        .pattern === "3",
    "배치표 [휴][3]"
  );
  assert(iThird > iOff2, "3부반 원번은 휴무지원 다음");
  assert(i23 > iThird && s3[i23]?.pairId === "23-50", "2·3은 원번 다음 pairId");
  assert(iCh > i23 && s3[iCh]?.kind === "fixed", "찾근은 2·3 다음");
  assert(iHouse > iCh, "HOUSE는 찾근 다음");
  assert(s3[iOff1]?.kind !== "oneMak", "휴무지원은 1막이 아님");
  assert(iSp3 > iHouse, "특수지원 3부는 기존 용량 꼬리");
}

section("3부 평일: 1·3 없으면 휴무 → 원번 → 2·3 → 찾근");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4].map((n) => house(n, n));
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
  const off = support(71, "휴", "OFF_SUPPORT", "SHIFT_3", 1);
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 5, "12:00"),
    ...shiftRes(date, "3부", 6, "16:00"),
  ];
  const shift3 = reservations.filter((r) => r.shift === "3부");
  const result = computeAutoAssignmentsV1({
    date,
    available: [...available, tA, tB, twoThree, chageun],
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
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [off],
    },
  });
  const s3 = sortedShift(result, "3부");
  const ids = s3.map((a) => `${a.kind}:${a.caddy.id}`).join(",");
  assert(
    ids.startsWith("specialSupport:71,regular:201,regular:202,twoThree:50,fixed:60"),
    `평일 휴무→원번→2·3→찾근 (${ids})`
  );
}

section("미배치 조합은 운영 kind를 바꾸지 않음");
{
  const date = "2026-06-10";
  const available = [1, 2, 3, 4].map((n) => house(n, n));
  const marshal3 = support(91, "마3", "MARSHAL_SUPPORT", "SHIFT_3", 1);
  const leader1 = support(92, "조1", "LEADER_SUPPORT", "SHIFT_1", 1);
  const off1 = support(93, "휴1", "OFF_SUPPORT", "SHIFT_1", 1);
  const fifty = support(94, "54지", "FIFTY_FOUR_SUPPORT", "FIFTY_FOUR", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [
      ...shiftRes(date, "1부", 4),
      ...shiftRes(date, "2부", 4, "12:00"),
      ...shiftRes(date, "3부", 4, "16:00"),
    ],
    specialSupportByShift: {
      "1부": [leader1, off1],
      "2부": [fifty],
      "3부": [marshal3],
    },
  });
  assert(
    !result.assignments.some((a) =>
      [91, 92, 93, 94].includes(a.caddy.id)
    ),
    "미확정 조합은 자동배치하지 않음"
  );
  assert(
    !result.assignments.some(
      (a) => a.kind === "oneMak" && a.supportKind === "MARSHAL_SUPPORT"
    ),
    "마샬지원을 1막으로 변환하지 않음"
  );
}

console.log(`\nOK ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
