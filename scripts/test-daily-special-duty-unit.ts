/**
 * 관리자 날짜별 특수근무 도메인 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-daily-special-duty-unit.ts
 */

import {
  annotateSpecialDutyConflicts,
  applyBundlesToAssignPools,
  buildEngineSpecialBundles,
  detectCrossKindConflicts,
  hasDuplicateKind,
  isSpecialDutyPayloadForSelectedDate,
  appendSpecialDutyPick,
  mergePastedSpecialDutyPicks,
  specialDutyRegisterRequestCount,
  moveItemIndex,
  nextSortOrder,
  renumberSortOrders,
  resolvePastedSpecialNames,
  splitPastedSpecialNames,
  type SpecialDutyRecord,
} from "../src/lib/dailySpecialDuty";
import {
  computeAutoAssignmentsV1,
  applyWeekendBandPriorityIfPresent,
  compareReservationOrder,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function rec(
  kind: SpecialDutyRecord["kind"],
  caddyId: number,
  sortOrder: number,
  name: string,
  team = "3조",
  teamOrder = caddyId
): SpecialDutyRecord {
  return { kind, caddyId, sortOrder, name, team, teamOrder };
}

section("같은 유형 A→B→C 입력 순서 보존");
{
  const rows = [
    rec("ONE_TWO", 1, 1, "김A", "3조", 9),
    rec("ONE_TWO", 2, 2, "김B", "2조", 5),
    rec("ONE_TWO", 3, 3, "김C", "1조", 1),
  ];
  const bundles = buildEngineSpecialBundles(rows, new Map());
  assert(
    bundles.oneTwoCandidates?.map((c) => c.name).join(",") === "김A,김B,김C",
    "엔진 후보 A→B→C (조순 재정렬 없음)"
  );
  assert(
    bundles.oneTwoCandidates?.map((c) => c.inputOrder).join(",") === "1,2,3",
    "inputOrder 1,2,3"
  );
}

section("B 삭제 시 A→C 재번호");
{
  const afterDelete = [
    rec("ONE_TWO", 1, 1, "김A"),
    rec("ONE_TWO", 3, 3, "김C"),
  ];
  const numbered = renumberSortOrders(afterDelete);
  assert(
    numbered.map((r) => `${r.name}:${r.sortOrder}`).join(",") === "김A:1,김C:2",
    "삭제 후 1,2 재번호"
  );
}

section("위/아래 이동 후 엔진 순서");
{
  const rows = [
    rec("ONE_TWO", 1, 1, "김A"),
    rec("ONE_TWO", 2, 2, "김B"),
    rec("ONE_TWO", 3, 3, "김C"),
  ];
  const moved = renumberSortOrders(moveItemIndex(rows, 0, 1));
  assert(
    moved.map((r) => r.name).join(",") === "김B,김A,김C",
    "A 아래로 → B,A,C"
  );
  const bundles = buildEngineSpecialBundles(moved, new Map());
  assert(
    bundles.oneTwoCandidates?.map((c) => c.name).join(",") === "김B,김A,김C",
    "엔진에도 B→A→C"
  );
}

section("duplicate 방지");
{
  const existing = [
    rec("ONE_TWO", 1, 1, "김A"),
    rec("FIFTY_FOUR", 2, 1, "김B"),
  ];
  assert(hasDuplicateKind(existing, "ONE_TWO", 1) === true, "같은 유형 중복");
  assert(hasDuplicateKind(existing, "ONE_TWO", 2) === false, "다른 유형은 중복 아님");
  const cross = detectCrossKindConflicts(existing, "ONE_TWO", 2);
  assert(
    cross.length === 1 && cross[0].code === "CROSS_KIND",
    "교차 유형은 경고만"
  );
}

section("휴무/당번 등 비가용 충돌 — 강행하지 않음");
{
  const rows = [
    rec("ONE_TWO", 1, 1, "휴무A"),
    rec("ONE_TWO", 2, 2, "가용B"),
    rec("CHAGEUN", 3, 1, "퇴사C"),
  ];
  const unavailable = new Map<number, string[]>([
    [1, ["휴무"]],
    [3, ["퇴사(RETIRED)"]],
  ]);
  const annotated = annotateSpecialDutyConflicts(rows, unavailable);
  assert(
    annotated[0].conflicts.some((c) => c.code === "UNAVAILABLE"),
    "휴무 충돌 표시"
  );
  assert(
    annotated[2].conflicts.some((c) => c.code === "INACTIVE"),
    "RETIRED 충돌 표시"
  );
  const bundles = buildEngineSpecialBundles(rows, unavailable);
  assert(
    bundles.oneTwoCandidates?.map((c) => c.name).join(",") === "가용B",
    "비가용 1·2는 엔진 후보에서 제외"
  );
  assert(
    bundles.skippedPlacements.some((s) => s.caddyId === 1),
    "휴무 스킵 기록"
  );
  assert(bundles.extraSpecial.length === 0, "퇴사 찾근은 강행하지 않음");
}

section("날짜별 데이터 분리");
{
  const day1 = [rec("ONE_TWO", 1, 1, "하루A")];
  const day2 = [rec("ONE_TWO", 9, 1, "이틀B")];
  assert(
    buildEngineSpecialBundles(day1, new Map()).oneTwoCandidates?.[0].name ===
      "하루A",
    "day1만"
  );
  assert(
    buildEngineSpecialBundles(day2, new Map()).oneTwoCandidates?.[0].name ===
      "이틀B",
    "day2만"
  );
  assert(
    isSpecialDutyPayloadForSelectedDate({ date: "2026-08-19" }, "2026-08-19"),
    "같은 날짜 payload 허용"
  );
  assert(
    !isSpecialDutyPayloadForSelectedDate({ date: "2026-08-19" }, "2026-08-20"),
    "날짜 A 신청자를 날짜 B UI에 넣지 않음"
  );
  assert(
    !isSpecialDutyPayloadForSelectedDate({ date: "2026-08-19" }, ""),
    "날짜 비면 stale payload 무시"
  );
}

section("특수근무 선택은 서버 없이 목록에 쌓이고 등록은 1회");
{
  let selected = appendSpecialDutyPick([], {
    caddyId: 1,
    name: "김A",
    team: "1조",
    teamOrder: 1,
  }).selected;
  selected = appendSpecialDutyPick(selected, {
    caddyId: 2,
    name: "김B",
    team: "1조",
    teamOrder: 2,
  }).selected;
  const dup = appendSpecialDutyPick(selected, { caddyId: 1, name: "김A" });
  assert(dup.duplicate === true, "중복 선택은 추가하지 않음");
  assert(selected.map((r) => r.name).join(",") === "김A,김B", "선택 2명");
  const pasted = mergePastedSpecialDutyPicks({
    selected,
    namesText: "김C\n없는사람\n김A",
    caddies: [
      { id: 1, name: "김A", employmentStatus: "ACTIVE", team: "1조", teamOrder: 1 },
      { id: 2, name: "김B", employmentStatus: "ACTIVE", team: "1조", teamOrder: 2 },
      { id: 3, name: "김C", employmentStatus: "ACTIVE", team: "2조", teamOrder: 1 },
    ],
  });
  assert(pasted.selected.map((r) => r.name).join(",") === "김A,김B,김C", "붙여넣기 순서 유지");
  assert(pasted.unmatched.includes("없는사람"), "불일치 경고");
  assert(pasted.duplicates.includes("김A"), "중복 경고");
  const counts = specialDutyRegisterRequestCount(pasted.selected.length);
  assert(counts.perPerson === 3, "before: 3회");
  assert(counts.batch === 1, "after: 1회 batch");
}

section("붙여넣기 이름 분리");
{
  assert(
    splitPastedSpecialNames("김A\n김B\n김C").join(",") === "김A,김B,김C",
    "줄바꿈"
  );
  const resolved = resolvePastedSpecialNames("김A\n없는사람", [
    { id: 1, name: "김A", employmentStatus: "ACTIVE" },
    { id: 2, name: "김B", employmentStatus: "ACTIVE" },
  ]);
  assert(resolved.matched.map((m) => m.caddyId).join(",") === "1", "매칭 1명");
  assert(
    resolved.reviews.some((r) => r.status === "review"),
    "미매칭 review"
  );
}

section("엔진: 관리자 순서 전달 (조순과 반대)");
{
  const date = "2026-06-10";
  const a: AutoAssignCaddy = {
    id: 11,
    name: "김A",
    team: "3조",
    teamOrder: 9,
    inputOrder: 1,
  };
  const b: AutoAssignCaddy = {
    id: 12,
    name: "김B",
    team: "2조",
    teamOrder: 5,
    inputOrder: 2,
  };
  const c: AutoAssignCaddy = {
    id: 13,
    name: "김C",
    team: "1조",
    teamOrder: 1,
    inputOrder: 3,
  };
  const house: AutoAssignCaddy[] = [
    { id: 101, name: "일반1", team: "4조", teamOrder: 1 },
    { id: 102, name: "일반2", team: "4조", teamOrder: 2 },
    { id: 103, name: "일반3", team: "4조", teamOrder: 3 },
    { id: 104, name: "일반4", team: "4조", teamOrder: 4 },
    { id: 105, name: "일반5", team: "4조", teamOrder: 5 },
    { id: 106, name: "일반6", team: "4조", teamOrder: 6 },
  ];
  const reservations: AutoAssignReservation[] = [
    { date, course: "VERTHILL", shift: "1부", teeTime: "06:00", teamName: "a", rawRowIndex: 1 },
    { date, course: "SKY", shift: "1부", teeTime: "06:00", teamName: "b", rawRowIndex: 2 },
    { date, course: "OCEAN", shift: "1부", teeTime: "06:00", teamName: "c", rawRowIndex: 3 },
    { date, course: "LAKE", shift: "1부", teeTime: "06:00", teamName: "d", rawRowIndex: 4 },
    { date, course: "VERTHILL", shift: "1부", teeTime: "06:08", teamName: "e", rawRowIndex: 5 },
    { date, course: "SKY", shift: "2부", teeTime: "13:30", teamName: "f", rawRowIndex: 6 },
    { date, course: "OCEAN", shift: "2부", teeTime: "13:30", teamName: "g", rawRowIndex: 7 },
    { date, course: "LAKE", shift: "2부", teeTime: "13:30", teamName: "h", rawRowIndex: 8 },
    { date, course: "VERTHILL", shift: "2부", teeTime: "13:38", teamName: "i", rawRowIndex: 9 },
    { date, course: "SKY", shift: "2부", teeTime: "13:38", teamName: "j", rawRowIndex: 10 },
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: house,
    oneTwoCandidates: [c, b, a],
    reservations,
  });
  const order: number[] = [];
  for (const row of result.oneTwoAssignments) {
    if (!order.includes(row.caddy.id)) order.push(row.caddy.id);
  }
  assert(order.join(",") === "11,12,13", "엔진 배치 순서 A→B→C (inputOrder)");

  const reordered = computeAutoAssignmentsV1({
    date,
    available: house,
    oneTwoCandidates: [
      { ...b, inputOrder: 1 },
      { ...a, inputOrder: 2 },
      { ...c, inputOrder: 3 },
    ],
    reservations,
  });
  const order2: number[] = [];
  for (const row of reordered.oneTwoAssignments) {
    if (!order2.includes(row.caddy.id)) order2.push(row.caddy.id);
  }
  assert(order2.join(",") === "12,11,13", "순서 변경 후 엔진 B→A→C");
}

section("찾근은 일반 가용에서 제외, 1막은 엔진 후보");
{
  const rows = [
    rec("CHAGEUN", 8, 1, "찾근D", "1조", 1),
    rec("ONE_MAK", 9, 1, "1막E", "1조", 2),
  ];
  const bundles = buildEngineSpecialBundles(rows, new Map());
  assert(bundles.extraSpecial.map((c) => c.name).join(",") === "찾근D", "찾근 special");
  assert(bundles.skipFromAvailableIds.includes(8), "찾근은 available에서 제외");
  assert(bundles.skipFromAvailableIds.includes(9), "1막도 available에서 제외");
  assert(bundles.oneMakCandidates?.[0].name === "1막E", "1막 엔진 후보");
  const pools = applyBundlesToAssignPools({
    available: [
      { id: 8, name: "찾근D" },
      { id: 9, name: "1막E" },
      { id: 10, name: "일반" },
    ],
    special: [],
    extraSpecial: bundles.extraSpecial,
    skipFromAvailableIds: bundles.skipFromAvailableIds,
  });
  assert(
    pools.available.map((c) => c.id).join(",") === "10",
    "찾근·1막 available에서 제거"
  );
}

section("nextSortOrder");
{
  assert(nextSortOrder([]) === 1, "빈 목록은 1");
  assert(nextSortOrder([1, 2, 4]) === 5, "max+1");
}

const COURSES = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;

function board(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  teeStart: string,
  rowStart = 1
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
      course: COURSES[i % 4],
      shift,
      teeTime: `${h}:${m}`,
      teamName: `${shift}-${i + 1}`,
      rawRowIndex: rowStart + i,
    });
  }
  return out;
}

function housePool(n: number, startId = 101): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `일반${i + 1}`,
    team: "4조",
    teamOrder: i + 1,
  }));
}

section("54홀 1명 → 1부 세 번째 자리");
{
  const date = "2026-07-01";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    fiftyFourHole: [
      { id: 1, name: "A", team: "1조", teamOrder: 1, inputOrder: 1 },
    ],
    reservations: [
      ...board(date, "1부", 6, "06:00"),
      ...board(date, "2부", 6, "12:10", 20),
    ],
  });
  const s1 = result.fiftyFourHoleAssignments.filter((a) => a.shift === "1부");
  assert(s1.length === 1, "54홀 1부 1자리");
  assert(s1[0].reservation.course === "OCEAN", "세 번째는 오션(전체 index 2)");
  assert(s1[0].reservation.teamName === "1부-3", "1부 3번째 슬롯");
  const s2 = result.fiftyFourHoleAssignments.find((a) => a.shift !== "1부");
  assert(!!s2, "6h 이후 다음 근무");
}

section("54홀 A→B→C → 3/4/5번째 순서보존");
{
  const date = "2026-07-02";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    fiftyFourHole: [
      { id: 11, name: "A", team: "3조", teamOrder: 9, inputOrder: 1 },
      { id: 12, name: "B", team: "2조", teamOrder: 5, inputOrder: 2 },
      { id: 13, name: "C", team: "1조", teamOrder: 1, inputOrder: 3 },
    ],
    reservations: [
      ...board(date, "1부", 8, "06:00"),
      ...board(date, "2부", 8, "12:10", 20),
    ],
  });
  const s1 = result.fiftyFourHoleAssignments.filter((a) => a.shift === "1부");
  assert(
    s1.map((a) => a.caddy.name).join(",") === "A,B,C",
    "1부 54홀 A→B→C"
  );
  assert(
    s1.map((a) => a.reservation.teamName).join(",") === "1부-3,1부-4,1부-5",
    "3/4/5번째 자리"
  );
}

section("54홀 있으면 1·2부는 그 다음부터");
{
  const date = "2026-07-03";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    fiftyFourHole: [
      { id: 21, name: "F", team: "1조", teamOrder: 1, inputOrder: 1 },
    ],
    oneTwoCandidates: [
      { id: 31, name: "T", team: "2조", teamOrder: 1, inputOrder: 1 },
    ],
    reservations: [
      ...board(date, "1부", 6, "06:00"),
      ...board(date, "2부", 8, "12:10", 20),
    ],
  });
  const f1 = result.fiftyFourHoleAssignments.find((a) => a.shift === "1부");
  const t1 = result.oneTwoAssignments.find((a) => a.shift === "1부");
  assert(f1?.reservation.teamName === "1부-3", "54홀이 3번째");
  assert(t1?.reservation.teamName === "1부-4", "1·2는 54홀 다음");
}

section("54홀 없으면 1·2부는 첫 2자리 다음부터");
{
  const date = "2026-07-04";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    oneTwoCandidates: [
      { id: 31, name: "T", team: "2조", teamOrder: 1, inputOrder: 1 },
    ],
    reservations: [
      ...board(date, "1부", 6, "06:00"),
      ...board(date, "2부", 8, "12:10", 20),
    ],
  });
  const t1 = result.oneTwoAssignments.find((a) => a.shift === "1부");
  assert(t1?.reservation.teamName === "1부-3", "54홀 없으면 3번째부터 1·2");
}

section("1·2부 2부 삽입 + 투근무 재개");
{
  const date = "2026-07-05";
  const house = housePool(6, 201);
  const result = computeAutoAssignmentsV1({
    date,
    available: house,
    oneTwoCandidates: [
      { id: 41, name: "일이", team: "1조", teamOrder: 1, inputOrder: 1 },
    ],
    reservations: [
      ...board(date, "1부", 5, "06:00"),
      ...board(date, "2부", 8, "12:10", 20),
    ],
  });
  const t2 = result.oneTwoAssignments.find((a) => a.shift === "2부");
  const shift2Regular = result.regularAssignments
    .filter((a) => a.shift === "2부")
    .sort((a, b) => compareReservationOrder(a.reservation, b.reservation));
  const shift2All = [...result.assignments.filter((a) => a.shift === "2부")].sort(
    (a, b) => compareReservationOrder(a.reservation, b.reservation)
  );
  assert(t2?.reservation.teamName === "2부-3", "첫근무 2명 다음(index 2)에 1·2 삽입");
  assert(shift2All[2].caddy.name === "일이", "2부 3번째가 1·2 신청자");
  assert(shift2Regular[0].caddy.id === house[4].id, "2부 초반 미근무 HOUSE");
  assert(shift2Regular[1].caddy.id === house[5].id, "2부 초반 미근무 HOUSE 2");
  const afterInsert = shift2Regular.filter(
    (a) =>
      compareReservationOrder(a.reservation, t2!.reservation) > 0
  );
  assert(afterInsert[0].caddy.id === house[0].id, "삽입 후 1부 첫 캐디부터 투근무");
  assert(afterInsert[1].caddy.id === house[1].id, "투근무 순번 유지");
}

section("1·3부 1부 anchor + 3부 주말반 훅 이후 앞자리");
{
  const date = "2026-07-06";
  const shift3 = board(date, "3부", 3, "16:00", 30);
  const weekend = applyWeekendBandPriorityIfPresent(shift3);
  assert(
    weekend.map((r) => r.teamName).join(",") ===
      [...shift3].sort(compareReservationOrder).map((r) => r.teamName).join(","),
    "예약 훅은 정렬만 (주말반 캐디 우선은 엔진 3부 queue)"
  );
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    oneThreeCandidates: [
      { id: 51, name: "일삼", team: "1조", teamOrder: 1, inputOrder: 1 },
    ],
    oneThreeAnchor: { course: "LAKE", teeTime: "06:00" },
    reservations: [
      ...board(date, "1부", 6, "06:00"),
      ...board(date, "3부", 3, "16:00", 30),
    ],
  });
  const s1 = result.oneThreeAssignments.find((a) => a.shift === "1부");
  const s3 = result.oneThreeAssignments.find((a) => a.shift === "3부");
  assert(s1?.reservation.course === "LAKE", "1·3 1부는 LAKE 06:00 anchor");
  const s3all = result.assignments
    .filter((a) => a.shift === "3부")
    .sort((a, b) =>
      compareReservationOrder(a.reservation, b.reservation)
    );
  const sp2 = result.sparesByShift.find((s) => s.shift === "2부")!;
  assert(s3all[0].caddy.id === sp2.spare1?.caddyId, "3부 1 = 2부 스페어1");
  assert(s3all[1].caddy.id === sp2.spare2?.caddyId, "3부 2 = 2부 스페어2");
  assert(s3?.caddy.name === "일삼", "1·3 3부는 스페어 다음");
  assert(s3?.reservation.teamName === "3부-3", "1·3 3부는 스페어 소진 후 remaining");
}

section("1막 1부 anchor");
{
  const date = "2026-07-07";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    oneMakCandidates: [
      { id: 61, name: "막A", team: "2조", teamOrder: 8, inputOrder: 1 },
      { id: 62, name: "막B", team: "1조", teamOrder: 1, inputOrder: 2 },
    ],
    oneMakAnchor: { course: "SKY", teeTime: "06:00" },
    reservations: board(date, "1부", 6, "06:00"),
  });
  const s1 = result.oneMakAssignments.filter((a) => a.shift === "1부");
  assert(s1.map((a) => a.caddy.name).join(",") === "막A,막B", "1막 sortOrder 보존");
  assert(s1[0].reservation.course === "SKY", "SKY 06:00부터");
  assert(s1[1].reservation.course === "OCEAN", "연속 다음 자리");
}

section("1·2부 2명이 오늘 1부 첫 캐디여도 배치되고 전체가 abort되지 않음");
{
  const date = "2026-08-27";
  const start: AutoAssignCaddy = {
    id: 167,
    name: "신정훈",
    team: "7조",
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
  const partner: AutoAssignCaddy = {
    id: 114,
    name: "노준영",
    team: "7조",
    teamOrder: 2,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
  const house = [start, partner, ...housePool(8, 201)];
  let threw: unknown = null;
  let result: ReturnType<typeof computeAutoAssignmentsV1> | null = null;
  try {
    result = computeAutoAssignmentsV1({
      date,
      available: house,
      oneTwoCandidates: [
        { ...start, inputOrder: 1 },
        { ...partner, inputOrder: 2 },
      ],
      houseStartCaddyId: 167,
      reservations: [
        ...board(date, "1부", 10, "06:00"),
        ...board(date, "2부", 12, "12:10", 20),
      ],
    });
  } catch (e) {
    threw = e;
  }
  assert(threw == null, "1부 첫 캐디가 1·2부여도 HouseStartCaddyError 없음");
  const oneTwoIds = new Set(
    (result?.oneTwoAssignments || []).map((row) => row.caddy.id)
  );
  assert(oneTwoIds.has(167) && oneTwoIds.has(114), "두 명 모두 oneTwo 배치");
  assert(
    (result?.oneTwoAssignments || []).filter((row) => row.shift === "1부")
      .length === 2,
    "1부 1·2부 2자리"
  );
  assert(
    (result?.oneTwoAssignments || []).filter((row) => row.shift === "2부")
      .length === 2,
    "2부 1·2부 2자리"
  );
  assert(
    !(result?.regularAssignments || []).some(
      (row) => row.caddy.id === 167 || row.caddy.id === 114
    ),
    "1·2부 캐디가 일반 순번에 중복되지 않음"
  );
  const firstRegular = (result?.regularAssignments || []).find(
    (row) => row.shift === "1부"
  );
  assert(
    firstRegular?.caddy.id === 201,
    "특수근무 제외 후 일반 1부는 다음 HOUSE부터"
  );
}

section("특수근무 검색·3부 첫 캐디 후보는 RETIRED/LEAVE 제외");
{
  const specialSrc = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/SpecialDutyPanel.tsx"),
    "utf8"
  );
  const pageSrc = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const caddiesSrc = readFileSync(
    join(process.cwd(), "src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  assert(
    /fetch\(\s*["']\/api\/caddies["']/.test(specialSrc) &&
      !specialSrc.includes("employment=all"),
    "특수근무 검색은 기본 ACTIVE만"
  );
  assert(
    pageSrc.includes("isInactiveEmploymentAvailability"),
    "3부 첫 캐디 후보에서 RETIRED/LEAVE 필터"
  );
  assert(
    caddiesSrc.includes("employment=all"),
    "캐디관리 employment=all은 유지"
  );
  assert(/DAILY_SPECIAL_KIND_UI/.test(specialSrc), "운영 등록 탭은 UI kinds");
  assert(
    /DAILY_SPECIAL_KIND_UI\.map/.test(specialSrc) &&
      !/DAILY_SPECIAL_KINDS\.map/.test(specialSrc),
    "찾근 탭은 등록 modal에서 제거"
  );
  assert(/레거시 찾근/.test(specialSrc), "기존 CHAGEUN row는 레거시로만 표시");
  const engineSrc = readFileSync(
    join(process.cwd(), "src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  assert(
    /export function resolveRegularHouseQueue/.test(engineSrc),
    "1부 첫 캐디가 특수근무여도 원본 HOUSE 회전 후 이어감"
  );
  assert(
    /SPECIAL_DUTY_CHANGED_MESSAGE/.test(specialSrc),
    "특수근무 저장 후 재실행 안내"
  );
  assert(
    /reservationsFromAssignmentDraft/.test(pageSrc),
    "배치 다시 맞추기는 Draft 예약 JSON preview 가능"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
