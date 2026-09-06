/**
 * 1·3부/1막 1부 AUTO 창 · MANUAL 격리 · reflow
 * 실행: npx tsx scripts/test-special-placement-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeShift1SpecialWindow,
  inferComputePlacementMode,
  parseProtectedTailCount,
  resolveStoredPlacementPolicy,
  SPECIAL_WINDOW_OVERFLOW,
} from "../src/lib/specialPlacement";
import {
  compareReservationOrder,
  computeAutoAssignmentsV1,
  REASON,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  autoResultFromDraft,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  makeAddReservationChange,
  previewLiveAssignmentChange,
} from "../src/lib/assignmentChange";

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

const COURSES = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;

function board(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  teeStart: string
): AutoAssignReservation[] {
  const [hh, mm] = teeStart.split(":").map(Number);
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < count; i++) {
    const wave = Math.floor(i / 4);
    const total = hh * 60 + mm + wave * 8;
    const h = String(Math.floor(total / 60)).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    out.push({
      date,
      id: `${shift}-${i + 1}`,
      course: COURSES[i % 4],
      shift,
      teeTime: `${h}:${m}`,
      teamName: `${shift}-${i + 1}`,
      rawRowIndex: i + 1,
    });
  }
  return out;
}

function housePool(n: number, startId = 101): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `H${i + 1}`,
    team: `${(i % 8) + 1}조`,
    teamOrder: i + 1,
  }));
}

function applicants(kind: "13" | "1m", n: number, startId: number): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `${kind}${i + 1}`,
    team: "1조",
    teamOrder: i + 1,
    inputOrder: i + 1,
  }));
}

function shift1Names(
  result: ReturnType<typeof computeAutoAssignmentsV1>,
  kind: "oneThree" | "oneMak"
) {
  return result.assignments
    .filter((a) => a.shift === "1부" && a.kind === kind)
    .sort((a, b) => compareReservationOrder(a.reservation, b.reservation))
    .map((a) => a.reservation.teamName);
}

section("공식");
{
  const w = computeShift1SpecialWindow({ N: 50, R: 3, A: 5, B: 2 });
  assert(w.ok && w.oneThreeStart === 41 && w.oneThreeEnd === 45, "R3 1·3 41~45");
  assert(w.ok && w.oneMakStart === 46 && w.oneMakEnd === 47, "R3 1막 46~47");
  const r2 = computeShift1SpecialWindow({ N: 50, R: 2, A: 5, B: 2 });
  assert(r2.ok && r2.oneThreeStart === 42 && r2.oneMakEnd === 48, "R2 42~46 / 47~48");
  const r4 = computeShift1SpecialWindow({ N: 50, R: 4, A: 5, B: 2 });
  assert(r4.ok && r4.oneThreeStart === 40 && r4.oneMakEnd === 46, "R4 40~44 / 45~46");
  const r0 = computeShift1SpecialWindow({ N: 50, R: 0, A: 5, B: 2 });
  assert(r0.ok && r0.specialEnd === 50 && r0.oneMakEnd === 50, "R0 끝까지");
  const rN = computeShift1SpecialWindow({ N: 50, R: 50, A: 0, B: 0 });
  assert(rN.ok && rN.neededCount === 0 && rN.availableCount === 0, "R=N + 신청 0");
  const rNblock = computeShift1SpecialWindow({ N: 50, R: 50, A: 1, B: 0 });
  assert(!rNblock.ok && rNblock.availableCount === 0, "R=N + 신청 있으면 blocking");
  const rOverN = computeShift1SpecialWindow({ N: 50, R: 51, A: 1, B: 0 });
  assert(!rOverN.ok && rOverN.availableCount === 0, "R>N + 신청은 blocking");
  assert(parseProtectedTailCount(21).ok === false, "R 21 거부");
  assert(parseProtectedTailCount(-1).ok === false, "R 음수 거부");
  const a0 = computeShift1SpecialWindow({ N: 50, R: 4, A: 0, B: 2 });
  assert(a0.ok && a0.oneThreeStart == null && a0.oneMakStart === 45, "A=0 1막만");
  const b0 = computeShift1SpecialWindow({ N: 50, R: 4, A: 5, B: 0 });
  assert(b0.ok && b0.oneMakStart == null && b0.oneThreeEnd === 46, "B=0 1·3만");
  const none = computeShift1SpecialWindow({ N: 50, R: 4, A: 0, B: 0 });
  assert(none.ok && none.neededCount === 0, "A=B=0");
  const noneS = computeShift1SpecialWindow({ N: 10, R: 3, A: 1, B: 1, S: 0 });
  assert(
    noneS.ok && noneS.specialStart === 6 && noneS.oneMakEnd === 7,
    "S=0이면 기존 1·3/1막 창"
  );
  const withS = computeShift1SpecialWindow({ N: 10, R: 3, A: 1, B: 1, S: 2 });
  assert(withS.ok && withS.specialStart === 4 && withS.specialEnd === 7, "S 포함 창 4~7");
  assert(withS.ok && withS.oneThreeStart === 4 && withS.oneMakStart === 5, "1·3 다음 1막");
  assert(withS.ok && withS.supportStart === 6 && withS.supportEnd === 7, "지원은 R 직전");
  const overflowS = computeShift1SpecialWindow({ N: 10, R: 3, A: 4, B: 3, S: 2 });
  assert(!overflowS.ok && overflowS.code === SPECIAL_WINDOW_OVERFLOW, "A+B+S > N-R blocking");
}

section("설정 없는 날짜 하위호환");
{
  const withAnchor = resolveStoredPlacementPolicy({
    setting: null,
    hasAnchor: true,
  });
  assert(withAnchor.mode === "MANUAL" && withAnchor.source === "implicit-manual", "anchor 있음 → MANUAL");
  const noAnchor = resolveStoredPlacementPolicy({
    setting: null,
    hasAnchor: false,
  });
  assert(noAnchor.mode === "AUTO" && noAnchor.protectedTailCount === 4, "anchor 없음 → AUTO R4");
  assert(
    inferComputePlacementMode({ placementMode: "AUTO", hasAnchor: true }) === "AUTO",
    "명시 AUTO는 stale anchor 무시"
  );
  assert(
    inferComputePlacementMode({ placementMode: null, hasAnchor: true }) === "MANUAL",
    "엔진 입력에 anchor 있으면 MANUAL"
  );
}

section("AUTO 50/R3/A5/B2 실제 슬롯");
{
  const date = "2026-09-01";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(80),
    oneThreeCandidates: applicants("13", 5, 501),
    oneMakCandidates: applicants("1m", 2, 601),
    placementMode: "AUTO",
    protectedTailCount: 3,
    oneThreeAnchor: { course: "LAKE", teeTime: "06:00" },
    reservations: [...board(date, "1부", 50, "05:00"), ...board(date, "3부", 20, "16:00")],
  });
  const s13 = result.assignments
    .filter((a) => a.shift === "1부" && a.kind === "oneThree")
    .sort((a, b) => String(a.reservation.teamName).localeCompare(String(b.reservation.teamName), "ko"));
  const s1m = result.assignments.filter((a) => a.shift === "1부" && a.kind === "oneMak");
  assert(s13.length === 5 && s1m.length === 2, "5+2 전부 배치");
  assert(
    s13.map((a) => a.reservation.teamName).join(",") ===
      "1부-41,1부-42,1부-43,1부-44,1부-45",
    "41~45 ONE_THREE"
  );
  assert(
    s1m
      .map((a) => a.reservation.teamName)
      .sort()
      .join(",") === "1부-46,1부-47",
    "46~47 ONE_MAK"
  );
  assert(
    !result.assignments.some(
      (a) =>
        a.shift === "1부" &&
        (a.kind === "oneThree" || a.kind === "oneMak") &&
        ["1부-48", "1부-49", "1부-50"].includes(String(a.reservation.teamName))
    ),
    "48~50 특수 제외"
  );
  assert(s13.every((a) => a.locked === false), "AUTO 1·3 locked=false");
  assert(result.specialPlacement?.mode === "AUTO", "결과 mode AUTO");
  assert(
    result.assignments.some(
      (a) => a.shift === "3부" && a.kind === "oneThree" && a.caddy.name.startsWith("13")
    ),
    "성공 1부 1·3이 3부 oneThreeForThird"
  );
}

section("AUTO N=10 R=3: 특수지원은 뒤 일반순번 보호 직전");
{
  const date = "2026-09-06";
  const available = housePool(12);
  const oneThree = applicants("13", 1, 501);
  const oneMak = applicants("1m", 1, 601);
  const support = [
    {
      id: 901,
      name: "SX",
      team: "7조",
      teamOrder: 1,
      extraFlags: ["OFF"],
    },
    {
      id: 902,
      name: "SY",
      team: "7조",
      teamOrder: 2,
      extraFlags: ["OFF"],
    },
  ];
  const reservations = board(date, "1부", 10, "07:00");
  const shared = {
    date,
    available,
    oneThreeCandidates: oneThree,
    oneMakCandidates: oneMak,
    placementMode: "AUTO" as const,
    protectedTailCount: 3,
    reservations,
  };
  const without = computeAutoAssignmentsV1({
    ...shared,
    specialSupportByShift: { "1부": [], "2부": [], "3부": [] },
  });
  const withSupport = computeAutoAssignmentsV1({
    ...shared,
    specialSupportByShift: { "1부": support, "2부": [], "3부": [] },
  });
  const shift1 = (
    result: ReturnType<typeof computeAutoAssignmentsV1>
  ) =>
    result.assignments
      .filter((a) => a.shift === "1부")
      .sort((a, b) => compareReservationOrder(a.reservation, b.reservation));
  const noS = shift1(without);
  const yesS = shift1(withSupport);
  assert(noS.length === 10 && yesS.length === 10, "1부 capacity 10");
  assert(
    noS.map((a) => a.kind).join(",") ===
      "regular,regular,regular,regular,regular,oneThree,oneMak,regular,regular,regular",
    "지원 없음: 기존 1·3/1막/R 보호"
  );
  assert(
    yesS.map((a) => a.kind).join(",") ===
      "regular,regular,regular,oneThree,oneMak,specialSupport,specialSupport,regular,regular,regular",
    "regular → 1·3 → 1막 → 지원2 → 보호 regular3"
  );
  assert(
    yesS.slice(7).every((a) => a.kind === "regular"),
    "마지막 R=3은 모두 regular"
  );
  assert(
    yesS.slice(7).map((a) => a.caddy.id).join(",") ===
      noS.slice(7).map((a) => a.caddy.id).join(","),
    "보호 R팀 캐디 identity 불변"
  );
  assert(yesS[3]!.caddy.id === 501 && yesS[4]!.caddy.id === 601, "1·3 다음 1막");
  assert(yesS[5]!.caddy.id === 901 && yesS[6]!.caddy.id === 902, "지원 2명 R 직전");
  const noSRegularIds = noS.filter((a) => a.kind === "regular").map((a) => a.caddy.id);
  const yesSRegularIds = new Set(
    yesS.filter((a) => a.kind === "regular").map((a) => a.caddy.id)
  );
  const unconsumed = noSRegularIds.filter((id) => !yesSRegularIds.has(id));
  const protectedIds = new Set(noS.slice(7).map((a) => a.caddy.id));
  assert(unconsumed.length === 2, "지원 2명만큼 normal 미소모");
  assert(
    unconsumed.every((id) => !protectedIds.has(id)),
    "미소모 normal은 보호 R팀이 아니라 앞쪽"
  );
  assert(
    unconsumed.includes(noS[3]!.caddy.id) && unconsumed.includes(noS[4]!.caddy.id),
    "미소모는 기존 앞쪽 regular 2명"
  );
}

section("AUTO는 저장 anchor 무시 / MANUAL은 기존 결과");
{
  const date = "2026-09-02";
  const reservations = [
    ...board(date, "1부", 8, "06:00"),
    ...board(date, "3부", 6, "16:00"),
  ];
  const auto = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 1, 701),
    placementMode: "AUTO",
    protectedTailCount: 4,
    oneThreeAnchor: { course: "VERTHILL", teeTime: "06:00" },
    reservations,
  });
  const auto1 = auto.assignments.find((a) => a.shift === "1부" && a.kind === "oneThree");
  assert(auto1?.reservation.teamName === "1부-4", "AUTO는 마지막 4 앞 (4번째)");
  assert(auto1?.reservation.course !== "VERTHILL" || auto1.reservation.teeTime !== "06:00" || auto1.reservation.teamName === "1부-4", "AUTO가 첫 슬롯 anchor를 쓰지 않음");
  const manual = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 1, 701),
    placementMode: "MANUAL",
    oneThreeAnchor: { course: "VERTHILL", teeTime: "06:00" },
    reservations,
  });
  const man1 = manual.assignments.find((a) => a.shift === "1부" && a.kind === "oneThree");
  assert(man1?.reservation.course === "VERTHILL" && man1.reservation.teeTime === "06:00", "MANUAL 기존 anchor");
  assert(man1?.locked === true, "MANUAL locked=true");
}

section("충돌은 뒤로 밀지 않고 blocking");
{
  const date = "2026-09-03";
  const reservations = [
    ...board(date, "1부", 10, "06:00"),
    ...board(date, "3부", 8, "16:00"),
  ];
  const fifty = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    fiftyFourHole: [{ id: 1, name: "54", team: "1조", teamOrder: 1, inputOrder: 1 }],
    oneThreeCandidates: applicants("13", 8, 801),
    placementMode: "AUTO",
    protectedTailCount: 0,
    reservations,
  });
  assert(
    fifty.specialPlacement?.block?.code === REASON.SPECIAL_WINDOW_COLLISION,
    "54홀이 창을 점유하면 collision"
  );
  assert(
    fifty.assignments.filter((a) => a.shift === "1부" && a.kind === "oneThree").length === 0,
    "54홀 충돌 시 부분 배치 없음"
  );
  assert(
    (fifty.specialPlacement?.block?.collisions.length || 0) > 0,
    "충돌 reservation/kind 포함"
  );

  const oneTwo = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneTwoCandidates: [{ id: 2, name: "12", team: "1조", teamOrder: 1, inputOrder: 1 }],
    oneThreeCandidates: applicants("13", 8, 811),
    placementMode: "AUTO",
    protectedTailCount: 0,
    reservations: [
      ...board(date, "1부", 10, "06:00"),
      ...board(date, "2부", 6, "12:00"),
    ],
  });
  assert(
    oneTwo.specialPlacement?.block?.code === REASON.SPECIAL_WINDOW_COLLISION,
    "1·2가 창을 점유하면 collision"
  );
  assert(
    oneTwo.assignments.filter((a) => a.shift === "1부" && a.kind === "oneThree").length === 0,
    "1·2 충돌 시 부분 배치 없음"
  );

  const lockSlot = reservations.find((r) => r.teamName === "1부-8")!;
  const fixed = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 2, 821),
    oneMakCandidates: applicants("1m", 1, 831),
    placementMode: "AUTO",
    protectedTailCount: 2,
    fixedAssignments: [
      {
        caddyId: 101,
        reservationMatch: {
          course: lockSlot.course,
          shift: "1부",
          teeTime: lockSlot.teeTime,
        },
        type: "FIXED",
      },
    ],
    caddyDirectory: housePool(20),
    reservations,
  });
  assert(
    fixed.specialPlacement?.block?.code === REASON.SPECIAL_WINDOW_COLLISION,
    "FIXED가 창을 점유하면 collision"
  );
  assert(
    fixed.assignments.filter((a) => a.shift === "1부" && a.kind === "oneThree").length === 0,
    "FIXED 충돌 시 부분 배치 없음"
  );

  const overflow = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 5, 841),
    oneMakCandidates: applicants("1m", 3, 851),
    placementMode: "AUTO",
    protectedTailCount: 4,
    reservations,
  });
  assert(
    overflow.specialPlacement?.block?.code === REASON.SPECIAL_WINDOW_OVERFLOW,
    "엔진 A+B > N-R 전체 blocking"
  );
  assert(
    overflow.assignments.filter((a) => a.shift === "1부" && (a.kind === "oneThree" || a.kind === "oneMak")).length === 0,
    "overflow 부분 배치 없음"
  );

  const a0 = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneMakCandidates: applicants("1m", 2, 861),
    placementMode: "AUTO",
    protectedTailCount: 4,
    reservations,
  });
  assert(
    shift1Names(a0, "oneThree").length === 0 &&
      shift1Names(a0, "oneMak").join(",") === "1부-5,1부-6",
    "엔진 A=0 1막만"
  );
  const b0 = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 2, 871),
    placementMode: "AUTO",
    protectedTailCount: 4,
    reservations,
  });
  assert(
    shift1Names(b0, "oneMak").length === 0 &&
      shift1Names(b0, "oneThree").join(",") === "1부-5,1부-6",
    "엔진 B=0 1·3만"
  );
  const none = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    placementMode: "AUTO",
    protectedTailCount: 4,
    reservations,
  });
  assert(
    shift1Names(none, "oneThree").length === 0 &&
      shift1Names(none, "oneMak").length === 0,
    "엔진 A=B=0"
  );
}

section("마지막 R에 FIXED가 있어도 HOUSE로 덮지 않음");
{
  const date = "2026-09-04";
  const reservations = board(date, "1부", 10, "06:00");
  const last = reservations[9];
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(16),
    oneThreeCandidates: applicants("13", 1, 841),
    placementMode: "AUTO",
    protectedTailCount: 4,
    fixedAssignments: [
      {
        caddyId: 999,
        reservationMatch: {
          course: last.course,
          shift: "1부",
          teeTime: last.teeTime,
        },
        type: "FIXED",
      },
    ],
    caddyDirectory: [
      ...housePool(16),
      { id: 999, name: "고정", team: "1조", teamOrder: 1 },
    ],
    reservations,
  });
  const lastRow = result.assignments.find(
    (a) => a.reservation.teamName === "1부-10"
  );
  assert(lastRow?.kind === "fixed" && lastRow.caddy.id === 999, "마지막 R FIXED 유지");
  assert(lastRow?.caddy.name !== "H1", "마지막 R을 HOUSE로 덮지 않음");
}

section("reflow 창 이동 / freeze");
{
  const date = "2026-09-05";
  const previous = computeAutoAssignmentsV1({
    date,
    available: housePool(80),
    oneThreeCandidates: applicants("13", 5, 851),
    oneMakCandidates: applicants("1m", 2, 861),
    placementMode: "AUTO",
    protectedTailCount: 3,
    reservations: [
      ...board(date, "1부", 50, "05:00"),
      ...board(date, "2부", 20, "12:00"),
      ...board(date, "3부", 20, "16:00"),
    ],
  });
  assert(
    shift1Names(previous, "oneThree").join(",") ===
      "1부-41,1부-42,1부-43,1부-44,1부-45",
    "before 41~45"
  );
  const added = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: housePool(80),
    change: makeAddReservationChange({
      date,
      course: "LAKE",
      shift: "1부",
      teeTime: "18:00",
      teamName: "당추51",
    }),
  });
  assert(
    !added.warnings.some((w) => w.level === "error") &&
      shift1Names(added.after, "oneThree").join(",") ===
        "1부-42,1부-43,1부-44,1부-45,1부-46",
    "50→51 당추 후 창이 1칸 뒤"
  );
  const tail = previous.assignments.find(
    (a) => a.reservation.teamName === "1부-50"
  );
  const cancelled = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: housePool(80),
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: tail ? reservationKey(tail.reservation) : "id:1부-50",
      cause: "CANCEL",
    },
  });
  assert(
    !cancelled.warnings.some((w) => w.level === "error") &&
      shift1Names(cancelled.after, "oneThree").join(",") ===
        "1부-40,1부-41,1부-42,1부-43,1부-44",
    "50→49 취소 후 창이 1칸 앞"
  );
  const move1 = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: housePool(80),
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: reservationKey(
        previous.assignments.find((a) => a.reservation.teamName === "1부-10")!
          .reservation
      ),
      to: { course: "LAKE", shift: "2부", teeTime: "15:50" },
    },
  });
  assert(
    !move1.warnings.some((w) => w.level === "error"),
    "1부 포함 MOVE는 재계산 허용"
  );
  const twoOnly = previous.assignments.find(
    (a) => a.shift === "2부" && a.kind === "regular"
  );
  const destFree = "15:51";
  const move2 = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: housePool(80),
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: twoOnly
        ? reservationKey(twoOnly.reservation)
        : "id:2부-1",
      to: { course: "LAKE", shift: "2부", teeTime: destFree },
    },
  });
  assert(
    shift1Names(move2.after, "oneThree").join(",") ===
      shift1Names(previous, "oneThree").join(","),
    "2부-only MOVE는 1부 특수 위치 불변"
  );
  const threeOnly = previous.assignments.find(
    (a) => a.shift === "3부" && a.kind === "regular"
  );
  const move3 = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: housePool(80),
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: threeOnly
        ? reservationKey(threeOnly.reservation)
        : "id:3부-1",
      to: { course: "LAKE", shift: "3부", teeTime: "23:51" },
    },
  });
  assert(
    !move3.warnings.some((w) => w.level === "error") &&
      shift1Names(move3.after, "oneThree").join(",") ===
        shift1Names(previous, "oneThree").join(","),
    "3부-only MOVE는 1부 특수 위치 불변"
  );

  const lockTail = previous.assignments.find(
    (a) => a.reservation.teamName === "1부-48"
  );
  assert(!!lockTail && lockTail.kind === "regular", "1부-48은 마지막 R regular");
  const afterSetLock = {
    ...previous,
    assignments: previous.assignments.map((row) =>
      row.reservation.teamName === "1부-48" ? { ...row, locked: true } : row
    ),
  };
  const lockAdd = previewLiveAssignmentChange({
    previous: afterSetLock,
    regularCaddyPool: housePool(80),
    change: makeAddReservationChange({
      date,
      course: "LAKE",
      shift: "1부",
      teeTime: "18:00",
      teamName: "당추51",
    }),
  });
  assert(
    lockAdd.warnings.some((w) => w.code === REASON.SPECIAL_WINDOW_COLLISION) &&
      shift1Names(lockAdd.after, "oneThree").join(",") ===
        shift1Names(previous, "oneThree").join(","),
    "SET_LOCK이 새 창을 점유하면 뒤로 밀지 않고 blocking"
  );
}

section("AUTO↔MANUAL 전환 후 stale anchor 오염 없음");
{
  const date = "2026-09-06";
  const reservations = [
    ...board(date, "1부", 8, "06:00"),
    ...board(date, "3부", 6, "16:00"),
  ];
  const stale = { course: "VERTHILL", teeTime: "06:00" } as const;
  const auto1 = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 1, 901),
    placementMode: "AUTO",
    protectedTailCount: 4,
    oneThreeAnchor: stale,
    reservations,
  });
  const manual = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 1, 901),
    placementMode: "MANUAL",
    oneThreeAnchor: stale,
    reservations,
  });
  const auto2 = computeAutoAssignmentsV1({
    date,
    available: housePool(20),
    oneThreeCandidates: applicants("13", 1, 901),
    placementMode: "AUTO",
    protectedTailCount: 4,
    oneThreeAnchor: stale,
    reservations,
  });
  const autoName = auto1.assignments.find((a) => a.shift === "1부" && a.kind === "oneThree")
    ?.reservation.teamName;
  const manName = manual.assignments.find((a) => a.shift === "1부" && a.kind === "oneThree")
    ?.reservation.teamName;
  const auto2Name = auto2.assignments.find((a) => a.shift === "1부" && a.kind === "oneThree")
    ?.reservation.teamName;
  assert(autoName === "1부-4" && auto2Name === "1부-4", "AUTO→MANUAL→AUTO도 AUTO 창");
  assert(manName === "1부-1", "MANUAL은 예전 anchor 유지");
  assert(autoName !== manName, "stale anchor가 AUTO를 오염하지 않음");
  const drafted = autoResultFromDraft(
    createDraftFromAutoResult(auto1, housePool(20)),
    auto1
  );
  assert(drafted.specialPlacement?.mode === "AUTO", "draft도 날짜 설정 mode 유지");
}

section("UI/API 문자열");
{
  const src = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/SpecialDutyPanel.tsx"),
    "utf8"
  );
  const api = readFileSync(
    join(process.cwd(), "src/app/api/daily-special-duties/route.ts"),
    "utf8"
  );
  const preview = readFileSync(
    join(process.cwd(), "src/app/api/assignments/preview/route.ts"),
    "utf8"
  );
  assert(src.includes("자동 배치") && src.includes("수동 위치 지정"), "AUTO/MANUAL 라디오");
  assert(src.includes("뒤 일반순번 보호"), "R 입력");
  assert(src.includes('placementMode === "MANUAL"'), "MANUAL에서만 anchor");
  assert(api.includes('action === "placement"'), "placement API");
  assert(
    preview.includes('placement.mode === "AUTO"') &&
      preview.includes("oneThreeAnchor = null"),
    "Preview AUTO는 클라이언트/저장 anchor 무시"
  );
  assert(
    preview.includes("placementMode: placement.mode") ||
      preview.includes("placementMode,"),
    "Preview는 서버 날짜 설정으로 mode 결정"
  );
  assert(src.includes("action: \"placement\""), "설정은 날짜별 서버 저장");
  assert(
    src.includes('placementMode === "MANUAL"') &&
      src.includes("ANCHOR_SPECIAL_KINDS") &&
      !/placementMode === "AUTO"[\s\S]*ONE_THREE 시작/.test(src),
    "AUTO에서 anchor UI 숨김"
  );
  assert(
    !src.includes("employment=all"),
    "특수근무 검색은 기본 ACTIVE만"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
