/**
 * 특수지원 v1 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-daily-special-support-unit.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareReservationOrder,
  computeAutoAssignmentsV1,
  REASON,
  reflowRegularAssignments,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import { createDraftFromAutoResult as draftFromResult } from "../src/lib/assignmentDraft";
import {
  buildPublishedPayloadFromDraft,
} from "../src/lib/dailyBoardPublished";
import { assignmentDraftToPayload } from "../src/lib/dailyBoardDraft";
import {
  emptySpecialSupportByShift,
  filterSupportQueueForShift,
  hasHardExclusionReason,
  isEligibleSpecialSupportCandidate,
  isHardExcludedSpecialSupport,
  isReservedSupportTailSlot,
  specialSupportCaddyIds,
  unusedSupportCount,
} from "../src/lib/dailySpecialSupport";
import { boardAssignmentMarks } from "../src/lib/assignmentBoardView";

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
    team: "1조",
    teamOrder: order,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function third(id: number, order: number): AutoAssignCaddy {
  return {
    id,
    name: `T${id}`,
    team: "9조",
    teamOrder: order,
    caddyType: "THIRD",
    employmentStatus: "ACTIVE",
  };
}

function supportCaddy(id: number, name: string, team = "7조"): AutoAssignCaddy {
  return {
    id,
    name,
    team,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
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
    const total = hh * 60 + mm + Math.floor(i / 4) * 7;
    const h = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    out.push(res(date, shift, `${h}:${m}`, courses[i % 4], i + 1));
  }
  return out;
}

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

section("hard exclusion");
{
  assert(isHardExcludedSpecialSupport({ employmentStatus: "LEAVE" }), "LEAVE 차단");
  assert(isHardExcludedSpecialSupport({ employmentStatus: "RETIRED" }), "RETIRED 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["병가"] }), "병가 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["결근"] }), "결근 차단");
  assert(isHardExcludedSpecialSupport({ excludedReasons: ["장기병가"] }), "장기병가 차단");
  assert(
    isHardExcludedSpecialSupport({
      employmentStatus: "ACTIVE",
      excludedReasons: ["휴무", "병가"],
    }),
    "겹치면 hard exclusion 우선"
  );
  assert(
    isEligibleSpecialSupportCandidate({
      id: 1,
      name: "휴무자",
      team: "7조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["휴무"],
    }),
    "휴무자는 지원 가능"
  );
  assert(
    isEligibleSpecialSupportCandidate({
      id: 2,
      name: "마샬",
      team: "9조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["조출마샬"],
    }),
    "마샬은 지원 가능"
  );
  assert(
    !isEligibleSpecialSupportCandidate({
      id: 3,
      name: "병가",
      team: "1조",
      employmentStatus: "ACTIVE",
      excludedReasons: ["병가"],
    }),
    "병가는 목록에서 제외"
  );
  assert(hasHardExclusionReason(["미출근"]), "미출근 hard");
}

section("filterSupportQueue: normal pool이어도 지원 유지, hard-block만 제거");
{
  const x = house(90, 7);
  const kept = filterSupportQueueForShift({
    queue: [x],
    shift: "1부",
    normalIds: [90, 1, 2],
    usedInShift: [],
  });
  assert(kept.length === 1 && kept[0].id === 90, "normal.has만으로 지원 큐에서 제거하지 않음");
  const sick = filterSupportQueueForShift({
    queue: [{ ...x, excludedReasons: ["병가"] }],
    shift: "1부",
    normalIds: [],
    usedInShift: [],
  });
  assert(sick.length === 0, "SICK는 지원 큐에서 제거");
  const ids = specialSupportCaddyIds({
    ...emptySpecialSupportByShift(),
    "1부": [x],
    "2부": [house(91, 8)],
  });
  assert(ids.has(90) && ids.has(91), "등록된 지원 id 집합");
}

section("capacity 꼬리 슬롯 예약");
{
  assert(
    isReservedSupportTailSlot({ remainingIncludingCurrent: 1, supportLeft: 1 }),
    "마지막 1자리는 지원 1명"
  );
  assert(
    isReservedSupportTailSlot({ remainingIncludingCurrent: 2, supportLeft: 2 }),
    "마지막 2자리는 지원 2명"
  );
  assert(
    !isReservedSupportTailSlot({ remainingIncludingCurrent: 3, supportLeft: 1 }),
    "앞자리는 정상 HOUSE"
  );
  assert(
    unusedSupportCount(
      [supportCaddy(90, "X"), supportCaddy(91, "Y")],
      [90]
    ) === 1,
    "이미 쓴 지원자는 남은 큐에서 제외"
  );
}

section("정상 HOUSE 6 + 지원 1 + capacity 6 → normal 5 + support 1");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    house(5, 5),
    house(6, 6),
  ];
  const off = supportCaddy(90, "휴무지원");
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 6),
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const s1 = withSupport.assignments
    .filter((a) => a.shift === "1부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  const regular = s1.filter((a) => a.kind === "regular");
  const supportRows = s1.filter((a) => a.kind === "specialSupport");
  assert(s1.length === 6, "capacity 6 유지");
  assert(regular.length === 5, "normal 5명");
  assert(supportRows.length === 1 && supportRows[0].caddy.id === 90, "support 1명");
  assert(s1[5].kind === "specialSupport", "지원은 꼬리");
  assert(
    regular.every((a, i) => a.caddy.id === without.assignments.filter((x) => x.shift === "1부")[i].caddy.id),
    "앞 5명 정상 순번 유지"
  );
  assert(
    !regular.some((a) => a.caddy.id === 6),
    "마지막 normal 1명(H6) 미소모"
  );
  assert(
    !s1.some((a) => a.kind === "regular" && a.caddy.id === 90),
    "지원자가 regular와 중복되지 않음"
  );
  const spWithout = without.sparesByShift.find((s) => s.shift === "1부");
  const spWith = withSupport.sparesByShift.find((s) => s.shift === "1부");
  assert(spWith?.spare1?.caddyId === 6, "미소모 H6이 1부 spare1");
  assert(spWith?.spare1?.caddyId !== spWithout?.spare1?.caddyId, "소비량 감소로 spare 시작점 앞당겨짐");
  assert(spWith?.spare1?.caddyId !== 90 && spWith?.spare2?.caddyId !== 90, "지원자는 spare 아님");
}

section("특수지원 2명이면 normal 소비 2명 감소");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    house(5, 5),
    house(6, 6),
  ];
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [supportCaddy(90, "X"), supportCaddy(91, "Y")],
    },
  });
  const s1 = withSupport.assignments
    .filter((a) => a.shift === "1부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  assert(
    s1.filter((a) => a.kind === "regular").length === 4,
    "normal 4명"
  );
  assert(
    s1.slice(4).every((a) => a.kind === "specialSupport"),
    "꼬리 2명 지원"
  );
  assert(
    s1[4].caddy.id === 90 && s1[5].caddy.id === 91,
    "지원 큐 순서 X,Y"
  );
  assert(
    !s1.some((a) => a.caddy.id === 5 || a.caddy.id === 6),
    "E,F 미소모"
  );
  const ids = s1.map((a) => a.caddy.id);
  assert(new Set(ids).size === ids.length, "지원/regular 중복 없음");
}

section("지원 없으면 기존 regular 순번/스페어 동일");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    house(5, 5),
    house(6, 6),
  ];
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 4),
  ];
  const omitted = computeAutoAssignmentsV1({ date, available, reservations });
  const emptyQueue = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: emptySpecialSupportByShift(),
  });
  const snap = (result: typeof omitted) =>
    result.assignments
      .map((a) => `${a.shift}:${a.reservation.teeTime}:${a.caddy.id}:${a.kind}`)
      .join("|");
  const spare = (result: typeof omitted) =>
    (result.sparesByShift || [])
      .map((s) => `${s.shift}:${s.spare1?.caddyId ?? "-"}:${s.spare2?.caddyId ?? "-"}`)
      .join("|");
  assert(snap(omitted) === snap(emptyQueue), "지원 큐 없으면 배치 identical");
  assert(spare(omitted) === spare(emptyQueue), "지원 큐 없으면 스페어 identical");
}

section("휴무자 1부 지원은 정상 후보 뒤에만");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = [
    ...shiftRes(date, "1부", 3),
    ...shiftRes(date, "1부", 1, "06:21").map((r, i) => ({
      ...r,
      rawRowIndex: 40 + i,
      teamName: "extra-1",
    })),
  ];
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const s1Without = without.assignments.filter((a) => a.shift === "1부");
  const s1With = withSupport.assignments.filter((a) => a.shift === "1부");
  assert(s1Without.length === 3, "지원 없으면 정상 3명만");
  assert(s1With.length === 4, "지원 있으면 4번째 메움");
  assert(
    s1With.slice(0, 3).every((a) => a.kind === "regular"),
    "앞 3자리는 정상"
  );
  const tail = s1With[3];
  assert(tail.kind === "specialSupport" && tail.caddy.id === 90, "마지막만 휴무 지원");
  assert(tail.reason === REASON.SPECIAL_SUPPORT, "SPECIAL_SUPPORT reason");
  assert(tail.locked === false, "지원은 LOCK 아님");
}

section("마샬 3부 지원 / 조장·당번 특정 부 / 여러 부");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), third(11, 1)];
  const marshal = supportCaddy(91, "마샬지원", "9조");
  const leader = supportCaddy(92, "조장지원", "8조");
  const duty = supportCaddy(93, "당번지원", "6조");
  const reservations = [
    ...shiftRes(date, "1부", 3),
    ...shiftRes(date, "2부", 3),
    ...shiftRes(date, "3부", 5),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: {
      "1부": [duty],
      "2부": [leader],
      "3부": [marshal, leader],
    },
  });
  const byShiftKind = (shift: "1부" | "2부" | "3부") =>
    result.assignments.filter((a) => a.shift === shift && a.kind === "specialSupport");
  assert(byShiftKind("1부").every((a) => a.caddy.id === 93), "1부 당번 지원");
  assert(byShiftKind("2부").every((a) => a.caddy.id === 92), "2부 조장 지원");
  assert(
    byShiftKind("3부").some((a) => a.caddy.id === 91),
    "3부 마샬 지원"
  );
  assert(
    result.assignments.filter((a) => a.caddy.id === 92).length >= 2,
    "조장은 여러 부 지원 가능"
  );
}

section("실제 웹형: available.all에 X가 있어도 specialSupport");
{
  const date = "2026-08-26";
  const a = house(1, 1);
  const b = house(2, 2);
  const c = house(3, 3);
  const d = house(4, 4);
  const e = house(5, 5);
  const f = house(6, 6);
  const x = house(90, 7);
  x.name = "X";
  const available = [a, b, c, d, e, f, x];
  const without = computeAutoAssignmentsV1({
    date,
    available: [a, b, c, d, e, f],
    reservations: shiftRes(date, "1부", 6),
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [x] },
  });
  const s1 = withSupport.assignments
    .filter((row) => row.shift === "1부")
    .sort((left, right) =>
      left.reservation.teeTime.localeCompare(right.reservation.teeTime)
    );
  const regular = s1.filter((row) => row.kind === "regular");
  const supportRows = s1.filter((row) => row.kind === "specialSupport");
  assert(s1.length === 6, "capacity 6 유지");
  assert(
    regular.map((row) => row.caddy.id).join(",") === "1,2,3,4,5",
    "regular는 A~E만"
  );
  assert(
    supportRows.length === 1 &&
      supportRows[0].caddy.id === 90 &&
      s1[5].kind === "specialSupport",
    "X는 꼬리 specialSupport"
  );
  assert(
    s1.filter((row) => row.caddy.id === 90).length === 1,
    "X 중복 없음"
  );
  assert(
    !s1.some((row) => row.caddy.id === 6),
    "F는 미소모"
  );
  const spare = withSupport.sparesByShift.find((row) => row.shift === "1부");
  const spareWithout = without.sparesByShift.find((row) => row.shift === "1부");
  assert(spare?.spare1?.caddyId === 6, "spare/cursor는 미소모 F부터");
  assert(
    spare?.spare1?.caddyId !== spareWithout?.spare1?.caddyId,
    "지원 소비 감소로 spare 시작점이 앞당겨짐"
  );
  assert(
    spare?.spare1?.caddyId !== 90 && spare?.spare2?.caddyId !== 90,
    "X는 spare 아님"
  );
}

section("available에 있어도 휴무 지원 가능 / SICK·결근은 불가");
{
  const date = "2026-08-26";
  const off = {
    ...house(90, 7),
    name: "휴무X",
    extraFlags: ["OFF"],
    excludedReasons: ["휴무"],
  };
  const offResult = computeAutoAssignmentsV1({
    date,
    available: [
      house(1, 1),
      house(2, 2),
      house(3, 3),
      house(4, 4),
      house(5, 5),
      house(6, 6),
      off,
    ],
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const offRow = offResult.assignments.find((row) => row.caddy.id === 90);
  assert(offRow?.kind === "specialSupport", "OFF 휴무는 지원 가능");
  assert(
    !offResult.assignments.some(
      (row) => row.kind === "regular" && row.caddy.id === 90
    ),
    "휴무 지원자는 regular 아님"
  );

  const sick = {
    ...house(80, 8),
    name: "병가",
    excludedReasons: ["병가"],
  };
  const noshow = {
    ...house(81, 9),
    name: "결근",
    excludedReasons: ["결근"],
  };
  const blocked = computeAutoAssignmentsV1({
    date,
    available: [
      house(1, 1),
      house(2, 2),
      house(3, 3),
      house(4, 4),
      house(5, 5),
      house(6, 6),
      sick,
      noshow,
    ],
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [sick, noshow],
    },
  });
  assert(
    !blocked.assignments.some((row) => [80, 81].includes(row.caddy.id)),
    "SICK/결근은 지원 불가"
  );
  assert(
    blocked.assignments.filter((row) => row.kind === "specialSupport").length ===
      0,
    "hard-block 지원 row 없음"
  );
  assert(
    blocked.assignments
      .filter((row) => row.shift === "1부" && row.kind === "regular")
      .map((row) => row.caddy.id)
      .join(",") === "1,2,3,4,5,6",
    "hard-block이면 기존 A~F regular 유지"
  );
}

section("실제 웹형 지원 2명: available에 X,Y 포함해도 normal 2명 감소");
{
  const date = "2026-08-26";
  const x = { ...house(90, 7), name: "X" };
  const y = { ...house(91, 8), name: "Y" };
  const result = computeAutoAssignmentsV1({
    date,
    available: [
      house(1, 1),
      house(2, 2),
      house(3, 3),
      house(4, 4),
      house(5, 5),
      house(6, 6),
      x,
      y,
    ],
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [x, y],
    },
  });
  const s1 = result.assignments
    .filter((row) => row.shift === "1부")
    .sort((left, right) =>
      left.reservation.teeTime.localeCompare(right.reservation.teeTime)
    );
  assert(
    s1.map((row) => `${row.caddy.id}:${row.kind}`).join(",") ===
      "1:regular,2:regular,3:regular,4:regular,90:specialSupport,91:specialSupport",
    "A B C D X Y"
  );
  assert(
    !s1.some((row) => row.caddy.id === 5 || row.caddy.id === 6),
    "E,F 미소모"
  );
}

section("지원자 때문에 다음 부 normal cursor가 변하지 않음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const baseRes = [...shiftRes(date, "1부", 3), ...shiftRes(date, "2부", 3)];
  const extra = res(date, "1부", "06:28", "VERTHILL", 99);
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations: baseRes,
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [...baseRes, extra],
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const first2Without = without.assignments.find((a) => a.shift === "2부")?.caddy.id;
  const first2With = withSupport.assignments.find((a) => a.shift === "2부")?.caddy.id;
  assert(first2Without === first2With, "2부 첫 정상 캐디 동일");
  assert(
    withSupport.assignments.some(
      (a) => a.shift === "1부" && a.kind === "specialSupport" && a.caddy.id === 90
    ),
    "1부 extra는 지원자가 메움"
  );
}

section("지원자 때문에 THIRD 앞 순번은 유지되고 꼬리만 지원");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    third(11, 1),
    third(12, 2),
  ];
  const marshal = supportCaddy(91, "마샬3부", "9조");
  const reservations = [
    ...shiftRes(date, "1부", 2),
    ...shiftRes(date, "2부", 2),
    ...shiftRes(date, "3부", 3),
  ];
  const without = computeAutoAssignmentsV1({ date, available, reservations });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "3부": [marshal] },
  });
  const thirdWithout = without.assignments
    .filter((a) => a.shift === "3부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  const thirdWith = withSupport.assignments
    .filter((a) => a.shift === "3부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  assert(thirdWith.length === 3, "3부 capacity 유지");
  assert(thirdWith[2].kind === "specialSupport" && thirdWith[2].caddy.id === 91, "3부 꼬리 지원");
  assert(
    thirdWith[0].caddy.id === thirdWithout[0].caddy.id &&
      thirdWith[1].caddy.id === thirdWithout[1].caddy.id,
    "앞 2명 regular THIRD 자리 동일"
  );
}

section("지원 포함 시 그 부 spare는 줄어든 HOUSE 소비 기준");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3), house(4, 4), house(5, 5)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = shiftRes(date, "1부", 3);
  const without = computeAutoAssignmentsV1({ date, available, reservations });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const spWithout = without.sparesByShift.find((s) => s.shift === "1부");
  const spWith = withSupport.sparesByShift.find((s) => s.shift === "1부");
  const s1 = withSupport.assignments
    .filter((a) => a.shift === "1부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  assert(s1.filter((a) => a.kind === "regular").length === 2, "3자리 중 normal 2");
  assert(s1[2].kind === "specialSupport", "3번째가 지원");
  assert(spWith?.spare1?.caddyId === 3, "미소모 3번째 HOUSE가 spare1");
  assert(spWithout?.spare1?.caddyId === 4, "지원 없으면 spare1은 4번째");
  assert(spWith?.spare1?.caddyId !== 90 && spWith?.spare2?.caddyId !== 90, "지원자는 spare 아님");
}

section("1막 / 1·2 / 1·3 / 54홀 우선순위 유지");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3), house(4, 4)];
  const oneMak = { id: 61, name: "막A", team: "2조", teamOrder: 8, inputOrder: 1 };
  const off = supportCaddy(90, "휴무지원");
  const result = computeAutoAssignmentsV1({
    date,
    available,
    oneMakCandidates: [oneMak],
    reservations: shiftRes(date, "1부", 6),
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const firstMak = result.assignments.find((a) => a.kind === "oneMak");
  const supportRow = result.assignments.find((a) => a.kind === "specialSupport");
  assert(firstMak?.caddy.id === 61, "1막이 먼저 배치");
  assert(supportRow?.caddy.id === 90, "지원은 남은 자리");
  const makTee = firstMak?.reservation.teeTime || "";
  const supportTee = supportRow?.reservation.teeTime || "";
  assert(makTee <= supportTee, "1막 티타임이 지원보다 앞이거나 같음");
}

section("WEEKEND 평일 규칙 유지");
{
  const date = "2026-08-26";
  const weekend: AutoAssignCaddy = {
    id: 77,
    name: "주말반",
    team: "9조",
    teamOrder: 9,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKEND",
    employmentStatus: "ACTIVE",
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2), weekend],
    reservations: [
      ...shiftRes(date, "1부", 2),
      ...shiftRes(date, "2부", 2),
      ...shiftRes(date, "3부", 2),
    ],
    protectedTailCount: 0,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [supportCaddy(90, "휴무3부")],
    },
  });
  assert(
    !result.assignments.some((a) => a.shift === "3부" && a.caddy.id === 77),
    "평일 3부에 WEEKEND 없음"
  );
}

section("Mode A/B 뒤에만 지원");
{
  const date = "2026-08-26";
  const available = [
    house(1, 1),
    house(2, 2),
    house(3, 3),
    house(4, 4),
    third(11, 1),
  ];
  const marshal = supportCaddy(91, "마샬3");
  const reservations = [
    ...shiftRes(date, "1부", 2),
    ...shiftRes(date, "2부", 2),
    ...shiftRes(date, "3부", 8),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "3부": [marshal] },
  });
  const s3 = result.assignments.filter((a) => a.shift === "3부");
  const supportIdx = s3.findIndex((a) => a.kind === "specialSupport");
  const lastNormal = s3.reduce(
    (idx, a, i) => (a.kind !== "specialSupport" ? i : idx),
    -1
  );
  assert(supportIdx === -1 || supportIdx > lastNormal, "3부 지원은 Mode A/B 뒤");
}

section("reflow 시 지정 부에만 남음");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = [
    ...shiftRes(date, "1부", 4),
    ...shiftRes(date, "2부", 2),
  ];
  const previous = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const cancel = previous.assignments.find(
    (a) => a.shift === "1부" && a.kind === "regular"
  );
  assert(!!cancel, "취소 대상 있음");
  const after = reflowRegularAssignments({
    previous,
    regularCaddyPool: available,
    events: [
      {
        type: "CANCEL_RESERVATION",
        reservationKey: reservationKey(cancel!.reservation),
      },
    ],
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    after.after.assignments.every(
      (a) => a.caddy.id !== 90 || a.shift === "1부"
    ),
    "지원자가 2부로 누수되지 않음"
  );
  assert(
    after.after.assignments.filter((a) => a.caddy.id === 90).every(
      (a) => a.kind === "specialSupport"
    ),
    "지원 배정은 specialSupport 유지"
  );
}

section("Draft round-trip / Published snapshot");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2)];
  const off = supportCaddy(90, "휴무지원");
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: shiftRes(date, "1부", 3),
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  const draft = draftFromResult(result, available);
  assert(
    !draft.caddyPool.some((c) => c.id === 90),
    "caddyPool에 지원자 넣지 않음"
  );
  const payload = assignmentDraftToPayload(draft);
  const published = buildPublishedPayloadFromDraft(payload);
  const supportPlacement = published.placements.find((p) => p.caddyId === 90);
  assert(supportPlacement?.specialSupport === true, "Published에 지원 보존");
  assert(supportPlacement?.kind === "specialSupport", "Published kind 보존");
  assert(supportPlacement?.chageun === false, "찾근으로 취급하지 않음");
  assert(supportPlacement?.locked === false, "LOCK 아님");
  const marks = boardAssignmentMarks(
    result.assignments.find((a) => a.caddy.id === 90)!,
    result.assignments
  );
  assert(marks.specialSupport === true && marks.chageun === false, "관리 보드 지원 표시");
}

section("OFF/DUTY/MARSHAL 지원은 지정 부에 포함되고 타부로 새지 않음");
{
  const date = "2026-08-26";
  const off = {
    ...supportCaddy(4, "박서진2"),
    extraFlags: ["OFF"],
    employmentStatus: "ACTIVE" as const,
  };
  const duty = {
    ...supportCaddy(190, "강보미"),
    extraFlags: ["DUTY"],
    employmentStatus: "ACTIVE" as const,
  };
  const marshal = {
    ...supportCaddy(91, "마샬3", "9조"),
    extraFlags: ["MARSHAL"],
    employmentStatus: "ACTIVE" as const,
  };
  const overflow = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2), third(11, 1)],
    reservations: [
      ...shiftRes(date, "1부", 3),
      ...shiftRes(date, "2부", 3),
      ...shiftRes(date, "3부", 4),
    ],
    protectedTailCount: 0,
    specialSupportByShift: {
      "1부": [off],
      "2부": [duty],
      "3부": [marshal],
    },
  });
  const supportOf = (shift: "1부" | "2부" | "3부", id: number) =>
    overflow.assignments.some(
      (a) => a.shift === shift && a.kind === "specialSupport" && a.caddy.id === id
    );
  assert(supportOf("1부", 4), "OFF ACTIVE + 1부 support → 1부 포함");
  assert(supportOf("2부", 190), "DUTY ACTIVE + 2부 support → 2부 포함");
  assert(supportOf("3부", 91), "MARSHAL ACTIVE + 3부 support → 3부 포함");
  assert(
    overflow.assignments.every((a) => a.caddy.id !== 4 || a.shift === "1부"),
    "1부 지원은 다른 부에 배치되지 않음"
  );
  assert(
    overflow.assignments.every((a) => a.caddy.id !== 190 || a.shift === "2부"),
    "2부 지원은 다른 부에 배치되지 않음"
  );
  assert(
    overflow.assignments.every((a) => a.caddy.id !== 91 || a.shift === "3부"),
    "3부 지원은 다른 부에 배치되지 않음"
  );

  const enough = computeAutoAssignmentsV1({
    date,
    available: [
      house(1, 1),
      house(2, 2),
      house(3, 3),
      house(14, 4),
      third(11, 1),
      third(12, 2),
      third(13, 3),
    ],
    reservations: [
      ...shiftRes(date, "1부", 2),
      ...shiftRes(date, "2부", 2),
      ...shiftRes(date, "3부", 2),
    ],
    protectedTailCount: 0,
    specialSupportByShift: {
      "1부": [off],
      "2부": [duty],
      "3부": [marshal],
    },
  });
  assert(
    enough.assignments.some((a) => a.shift === "1부" && a.kind === "specialSupport" && a.caddy.id === 4),
    "HOUSE가 충분해도 1부 지원은 capacity에 포함"
  );
  assert(
    enough.assignments.some((a) => a.shift === "2부" && a.kind === "specialSupport" && a.caddy.id === 190),
    "HOUSE가 충분해도 2부 지원은 capacity에 포함"
  );
  assert(
    enough.assignments.some((a) => a.shift === "3부" && a.kind === "specialSupport" && a.caddy.id === 91),
    "THIRD가 충분해도 3부 지원은 capacity에 포함"
  );
}

section("SICK / RETIRED / LEAVE는 support로도 배치되지 않음");
{
  const date = "2026-08-26";
  const sick = {
    ...supportCaddy(80, "병가"),
    employmentStatus: "ACTIVE" as const,
    excludedReasons: ["병가"],
  };
  const retired = {
    ...supportCaddy(81, "퇴사"),
    employmentStatus: "RETIRED" as const,
  };
  const leave = {
    ...supportCaddy(82, "휴직"),
    employmentStatus: "LEAVE" as const,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1)],
    reservations: [
      ...shiftRes(date, "1부", 3),
      ...shiftRes(date, "2부", 2),
      ...shiftRes(date, "3부", 2),
    ],
    protectedTailCount: 0,
    specialSupportByShift: {
      "1부": [sick],
      "2부": [retired],
      "3부": [leave],
    },
  });
  assert(
    !result.assignments.some((a) => [80, 81, 82].includes(a.caddy.id)),
    "SICK/RETIRED/LEAVE는 지원으로도 배치되지 않음"
  );
  assert(
    result.assignments.filter((a) => a.kind === "specialSupport").length === 0,
    "hard exclusion 지원 배정 0"
  );
}

section("N=10 R=3 AUTO: 특수지원은 뒤 일반순번 보호 직전");
{
  const date = "2026-09-06";
  const available = Array.from({ length: 12 }, (_, i) => house(i + 1, i + 1));
  const oneThree = { ...house(501, 1), name: "13C", inputOrder: 1 };
  const oneMak = { ...house(601, 1), name: "1MC", inputOrder: 1 };
  const sx = { ...supportCaddy(901, "SX"), extraFlags: ["OFF"] };
  const sy = { ...supportCaddy(902, "SY"), extraFlags: ["OFF"] };
  const reservations = shiftRes(date, "1부", 10, "07:00");
  const shared = {
    date,
    available,
    oneThreeCandidates: [oneThree],
    oneMakCandidates: [oneMak],
    placementMode: "AUTO" as const,
    protectedTailCount: 3,
    reservations,
  };
  const without = computeAutoAssignmentsV1({
    ...shared,
    specialSupportByShift: emptySpecialSupportByShift(),
  });
  const withSupport = computeAutoAssignmentsV1({
    ...shared,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [sx, sy],
    },
  });
  const shift1 = (result: ReturnType<typeof computeAutoAssignmentsV1>) =>
    result.assignments
      .filter((a) => a.shift === "1부")
      .sort((a, b) => compareReservationOrder(a.reservation, b.reservation));
  const noS = shift1(without);
  const yesS = shift1(withSupport);
  assert(noS.length === 10 && yesS.length === 10, "1부 capacity 10");
  assert(
    noS.map((a) => a.kind).join(",") ===
      "regular,regular,regular,regular,regular,oneThree,oneMak,regular,regular,regular",
    "지원 없음: 기존 1·3/1막/R3 보호 불변"
  );
  assert(
    yesS.map((a) => a.kind).join(",") ===
      "regular,regular,regular,oneThree,oneMak,specialSupport,specialSupport,regular,regular,regular",
    "앞 regular → 1·3 → 1막 → 지원2 → 보호 regular3"
  );
  assert(
    yesS.slice(7).every((a) => a.kind === "regular"),
    "마지막 3슬롯 regular"
  );
  assert(
    yesS.slice(7).map((a) => a.caddy.id).join(",") ===
      noS.slice(7).map((a) => a.caddy.id).join(","),
    "보호 R팀 identity 유지"
  );
  assert(yesS[5]!.caddy.id === 901 && yesS[6]!.caddy.id === 902, "지원은 R 직전");
  const unconsumed = noS
    .filter((a) => a.kind === "regular")
    .map((a) => a.caddy.id)
    .filter((id) => !yesS.some((a) => a.kind === "regular" && a.caddy.id === id));
  const protectedIds = new Set(noS.slice(7).map((a) => a.caddy.id));
  assert(unconsumed.length === 2, "지원 2명만큼 normal 미소모");
  assert(
    unconsumed.every((id) => !protectedIds.has(id)),
    "미소모는 보호 R팀이 아님"
  );
  assert(
    unconsumed.includes(noS[3]!.caddy.id) && unconsumed.includes(noS[4]!.caddy.id),
    "미소모는 보호구간 앞쪽 normal 2명"
  );
}

section("source / UI / migration / 권한");
{
  const sql = readSrc(
    "prisma/migrations/20260827120000_daily_special_support/migration.sql"
  );
  const schema = readSrc("prisma/schema.prisma");
  const panel = readSrc("src/app/manage/assignments/SpecialDutyPanel.tsx");
  const supportUi = readSrc(
    "src/app/manage/assignments/SpecialSupportPanel.tsx"
  );
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const route = readSrc("src/app/api/daily-special-supports/route.ts");
  const engine = readSrc("src/lib/autoAssignEngine.ts");
  const preview = readSrc("src/app/api/assignments/preview/route.ts");
  const reflow = readSrc("src/app/api/assignments/reflow/route.ts");
  const apply = readSrc("src/app/api/assignments/reflow/apply/route.ts");
  const publishedView = readSrc("src/components/board/PublishedBoardView.tsx");

  assert(/CREATE TABLE "DailySpecialSupport"/.test(sql), "additive CREATE TABLE");
  assert(
    /UNIQUE INDEX "DailySpecialSupport_date_caddyId_shift_key"/.test(sql),
    "(date,caddyId,shift) unique"
  );
  assert(!/DROP TABLE/.test(sql), "no DROP");
  assert(!/ALTER TABLE "DailySpecialDuty"/.test(sql), "DailySpecialDuty 미변경");
  assert(!/DROP TYPE "DailySpecialKind"/.test(sql), "CHAGEUN enum 유지");
  assert(/model DailySpecialSupport/.test(schema), "schema model");
  assert(/createdByUserId\s+Int\?/.test(schema), "nullable createdByUserId");
  assert(/DAILY_SPECIAL_KIND_UI\.map/.test(panel), "찾근 탭 제거");
  assert(/특수지원 등록/.test(supportUi), "특수지원 등록 액션");
  assert(/const \[busy, setBusy\]/.test(supportUi), "저장 busy state");
  assert(/1부 지원/.test(supportUi), "부별 인원 요약");
  assert(/ss-kinds/.test(supportUi), "mobile 3부 탭");
  assert(/SpecialSupportPanel/.test(page), "날짜 설정에 특수지원");
  assert(
    !/\/api\/daily-special-supports/.test(page),
    "assignments page는 특수지원 GET을 중복하지 않음 (패널 1회)"
  );
  assert(/reservationsFromAssignmentDraft/.test(page), "엑셀 없이 Draft 예약으로 재실행");
  assert(/onLoaded=\{onSpecialSupportLoaded\}/.test(page), "패널 onLoaded로 큐 전달");
  assert(
    /isThirdBandTeam, THIRD_BAND_TEAMS/.test(page),
    "THIRD_BAND_TEAMS import 유지"
  );
  assert(/requireAdmin/.test(route), "API requireAdmin");
  assert(/includeCandidates/.test(route), "후보 목록은 includeCandidates일 때만");
  assert(
    /qs\.set\("includeCandidates", "1"\)/.test(supportUi),
    "모달 열 때만 후보 재조회"
  );
  assert(/kind: "specialSupport"/.test(engine), "assignment kind");
  assert(/S: shift1Support.length/.test(engine), "1부 AUTO 창에 특수지원 S 포함");
  assert(/shift1SupportHouseSkip/.test(engine), "보호구간 앞 HOUSE skip");
  assert(/isReservedSupportTailSlot/.test(engine), "부 capacity 꼬리에 지원 예약");
  assert(/specialSupportCaddyIds/.test(engine), "지원 id를 regular pool에서 제외");
  assert(/specialSupportIds.has\(caddy.id\)/.test(engine), "available에서 지원 id 제거");
  const supportDomain = readSrc("src/lib/dailySpecialSupport.ts");
  assert(
    !/used.has\(caddy.id\) \|\| normal.has\(caddy.id\)/.test(supportDomain),
    "normal.has만으로 지원 큐에서 제거하지 않음"
  );
  assert(/pickNextSpecialSupport/.test(engine), "지원 큐 사용");
  assert(/houseAssigned \+= 1/.test(engine), "정상 houseAssigned 유지");
  assert(
    /specialSupportByShift: await loadSpecialSupportQueuesForDate/.test(preview),
    "preview는 서버에서 특수지원을 다시 읽음"
  );
  assert(
    /loadSpecialSupportQueuesForDate/.test(reflow) &&
      /loadSpecialSupportQueuesForDate/.test(apply),
    "reflow/apply도 서버에서 다시 읽음"
  );
  assert(/bc-badge support/.test(publishedView), "Published 지원 뱃지");
  assert(
    !/DailySpecialKind/.test(supportDomain) &&
      !/kind:\s*"CHAGEUN"/.test(engine) &&
      /kind: "specialSupport"/.test(engine),
    "특수지원이 CHAGEUN을 재사용하지 않음"
  );
}

console.log(`\nOK ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
