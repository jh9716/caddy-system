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
  moveItemIndex,
  nextSortOrder,
  renumberSortOrders,
  resolvePastedSpecialNames,
  splitPastedSpecialNames,
  type SpecialDutyRecord,
} from "../src/lib/dailySpecialDuty";
import {
  computeAutoAssignmentsV1,
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
    { date, course: "SKY", shift: "1부", teeTime: "06:00", teamName: "a", rawRowIndex: 1 },
    { date, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "b", rawRowIndex: 2 },
    { date, course: "SKY", shift: "1부", teeTime: "09:30", teamName: "c", rawRowIndex: 3 },
    { date, course: "SKY", shift: "2부", teeTime: "13:30", teamName: "d", rawRowIndex: 4 },
    { date, course: "SKY", shift: "2부", teeTime: "14:30", teamName: "e", rawRowIndex: 5 },
    { date, course: "SKY", shift: "2부", teeTime: "15:30", teamName: "f", rawRowIndex: 6 },
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

section("찾근은 일반 가용에서 제외, 1막은 엔진 미연결");
{
  const rows = [
    rec("CHAGEUN", 8, 1, "찾근D", "1조", 1),
    rec("ONE_MAK", 9, 1, "1막E", "1조", 2),
  ];
  const bundles = buildEngineSpecialBundles(rows, new Map());
  assert(bundles.extraSpecial.map((c) => c.name).join(",") === "찾근D", "찾근 special");
  assert(bundles.skipFromAvailableIds.includes(8), "찾근은 available에서 제외");
  assert(!bundles.skipFromAvailableIds.includes(9), "1막은 기존 파이프라인 없음");
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
    pools.available.map((c) => c.id).join(",") === "9,10",
    "찾근만 available에서 제거"
  );
}

section("nextSortOrder");
{
  assert(nextSortOrder([]) === 1, "빈 목록은 1");
  assert(nextSortOrder([1, 2, 4]) === 5, "max+1");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
