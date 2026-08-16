/**
 * 배치 엔진 v2 현장 운영 규칙 Acceptance / business-rule 고정 테스트
 * — Production / autoAssignEngine / schema / DB / UI 수정 없음 (검증만)
 *
 * 실행: npx tsx scripts/test-auto-assign-acceptance-ops-rules.ts
 */

import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  COURSE_ORDER,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type SpareByShift,
} from "../src/lib/autoAssignEngine";

type ShiftPart = "1부" | "2부" | "3부";

let passed = 0;
let failed = 0;
const caseResults: Record<string, { pass: boolean; notes: string[] }> = {};

function assert(cond: unknown, msg: string, caseKey?: string): boolean {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
    return true;
  }
  failed++;
  console.error("  ✗", msg);
  if (caseKey) {
    caseResults[caseKey] ??= { pass: true, notes: [] };
    caseResults[caseKey].pass = false;
    caseResults[caseKey].notes.push(msg);
  }
  return false;
}

function section(title: string) {
  console.log("\n==", title, "==");
}

function padName(prefix: string, n: number, width: number): string {
  return `${prefix}${String(n).padStart(width, "0")}`;
}

function makeHouseCaddies(
  count: number,
  opts: { idStart?: number; nameWidth?: number; namePrefix?: string } = {}
): AutoAssignCaddy[] {
  const idStart = opts.idStart ?? 1;
  const nameWidth = opts.nameWidth ?? 2;
  const namePrefix = opts.namePrefix ?? "H";
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    out.push({
      id: idStart + i,
      name: padName(namePrefix, n, nameWidth),
      team: "1조",
      teamOrder: n,
      caddyType: "HOUSE",
    });
  }
  return out.sort(compareCaddyOrder);
}

function makeThirdCaddies(
  count: number,
  opts: { idStart?: number; nameWidth?: number } = {}
): AutoAssignCaddy[] {
  const idStart = opts.idStart ?? 9001;
  const nameWidth = opts.nameWidth ?? 3;
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    out.push({
      id: idStart + i,
      name: padName("T", n, nameWidth),
      team: "9조",
      teamOrder: n,
      caddyType: "THIRD",
    });
  }
  return out.sort(compareCaddyOrder);
}

/** 부별 예약 — teeTime은 부 윈도우 안에서만 증가 (shift 필드는 명시) */
function makeShiftReservations(
  date: string,
  shift: ShiftPart,
  count: number,
  teeHour: number
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < count; i++) {
    const totalMin = teeHour * 60 + i; // 1분 간격, 같은 부 내 정렬만 필요
    const h = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const m = String(totalMin % 60).padStart(2, "0");
    out.push({
      date,
      course: COURSE_ORDER[i % COURSE_ORDER.length],
      courseLabel: COURSE_ORDER[i % COURSE_ORDER.length],
      shift,
      teeTime: `${h}:${m}`,
      teamName: `${shift}-${i + 1}`,
      rawRowIndex: i + 1,
    });
  }
  return out;
}

function namesOfShift(result: AutoAssignResultV1, shift: ShiftPart): string[] {
  return result.regularAssignments
    .filter((a) => a.shift === shift)
    .map((a) => a.caddy.name);
}

function spareNames(spares: SpareByShift[], shift: ShiftPart): [string | null, string | null] {
  const row = spares.find((s) => s.shift === shift);
  return [row?.spare1?.name ?? null, row?.spare2?.name ?? null];
}

function snapshotTeamOrders(caddies: AutoAssignCaddy[]): Map<number, number> {
  return new Map(caddies.map((c) => [c.id, c.teamOrder]));
}

function assertTeamOrdersUnchanged(
  before: Map<number, number>,
  after: AutoAssignCaddy[],
  caseKey: string
) {
  for (const c of after) {
    assert(
      before.get(c.id) === c.teamOrder,
      `teamOrder 불변 id=${c.id} name=${c.name} before=${before.get(c.id)} after=${c.teamOrder}`,
      caseKey
    );
  }
}

function assertNoDupInShift(
  result: AutoAssignResultV1,
  shift: ShiftPart,
  caseKey: string
) {
  const ids = result.regularAssignments
    .filter((a) => a.shift === shift)
    .map((a) => a.caddy.id);
  assert(
    new Set(ids).size === ids.length,
    `${shift} 동일 Caddy 중복 실제배치 없음 (n=${ids.length})`,
    caseKey
  );
}

function assertSpareNotInShiftAssignees(
  result: AutoAssignResultV1,
  shift: ShiftPart,
  caseKey: string
) {
  const assigned = new Set(
    result.regularAssignments
      .filter((a) => a.shift === shift)
      .map((a) => a.caddy.id)
  );
  const row = result.sparesByShift.find((s) => s.shift === shift);
  if (row?.spare1) {
    assert(
      !assigned.has(row.spare1.caddyId),
      `${shift} Spare1(${row.spare1.name}) ≠ 같은 부 실배치`,
      caseKey
    );
  }
  if (row?.spare2) {
    assert(
      !assigned.has(row.spare2.caddyId),
      `${shift} Spare2(${row.spare2.name}) ≠ 같은 부 실배치`,
      caseKey
    );
  }
}

function assertSparesPresentWhenPoolEnough(
  result: AutoAssignResultV1,
  shifts: ShiftPart[],
  caseKey: string
) {
  for (const shift of shifts) {
    const row = result.sparesByShift.find((s) => s.shift === shift);
    assert(row?.spare1 != null, `${shift} Spare1 null 아님 (풀 충분)`, caseKey);
    assert(row?.spare2 != null, `${shift} Spare2 null 아님 (풀 충분)`, caseKey);
  }
}

function expectSeq(
  actual: string[],
  expected: string[],
  label: string,
  caseKey: string
) {
  const a = actual.join(",");
  const e = expected.join(",");
  assert(a === e, `${label}: expected [${e}] got [${a}]`, caseKey);
}

function rangeNames(
  prefix: string,
  from: number,
  to: number,
  width: number
): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(padName(prefix, n, width));
  return out;
}

function wrapRangeNames(
  prefix: string,
  start: number,
  count: number,
  max: number,
  width: number
): string[] {
  const out: string[] = [];
  let n = start;
  for (let i = 0; i < count; i++) {
    out.push(padName(prefix, n, width));
    n = n === max ? 1 : n + 1;
  }
  return out;
}

function printSeq(label: string, names: string[]) {
  console.log(`  → ${label} (${names.length}): ${names.join(" → ")}`);
}

function printSpare(label: string, s1: string | null, s2: string | null) {
  console.log(`  → ${label}: Spare1=${s1 ?? "null"} Spare2=${s2 ?? "null"}`);
}

function markCaseStart(key: string) {
  caseResults[key] = { pass: true, notes: [] };
}

function finalizeCase(key: string) {
  const r = caseResults[key];
  if (!r) return;
  if (r.pass) console.log(`\n  ★ ${key}: PASS`);
  else {
    console.log(`\n  ★ ${key}: FAIL (${r.notes.length} assertion(s))`);
    for (const n of r.notes) console.log("    -", n);
  }
}

// ─────────────────────────────────────────────────────────────
// CASE A — HOUSE 한 바퀴 미완료 Mode A
// HOUSE H01~H50, start H11, 1부20 / 2부20 / 3부 30 (Mode A 흐름 완전 관측)
// ─────────────────────────────────────────────────────────────
section("acceptance / business-rule CASE A — Mode A (HOUSE 첫 바퀴 미완료)");
{
  const CASE = "CASE_A";
  markCaseStart(CASE);
  const date = "2026-09-01";
  const house = makeHouseCaddies(50, { nameWidth: 2 });
  const third = makeThirdCaddies(20, { idStart: 901, nameWidth: 2 });
  const available = [...house, ...third];
  const teamOrderBefore = snapshotTeamOrders(available);

  const start = house.find((c) => c.name === "H11")!;
  assert(!!start, "fixture: H11 exists", CASE);

  const reservations = [
    ...makeShiftReservations(date, "1부", 20, 6),
    ...makeShiftReservations(date, "2부", 20, 10),
    // H01,H02 + THIRD20 + H03~H10 = 30
    ...makeShiftReservations(date, "3부", 30, 14),
  ];

  const result = computeAutoAssignmentsV1({
    date,
    available,
    special: [],
    reservations,
    houseStartCaddyId: start.id,
  });

  const s1 = namesOfShift(result, "1부");
  const s2 = namesOfShift(result, "2부");
  const s3 = namesOfShift(result, "3부");
  const [sp1a, sp1b] = spareNames(result.sparesByShift, "1부");
  const [sp2a, sp2b] = spareNames(result.sparesByShift, "2부");

  printSeq("1부 실배치", s1);
  printSpare("1부", sp1a, sp1b);
  printSeq("2부 실배치", s2);
  printSpare("2부", sp2a, sp2b);
  printSeq("3부 실배치", s3);

  const expect1 = rangeNames("H", 11, 30, 2);
  const expect2 = rangeNames("H", 31, 50, 2);
  const expect3 = [
    "H01",
    "H02",
    ...rangeNames("T", 1, 20, 2),
    ...rangeNames("H", 3, 10, 2),
  ];

  expectSeq(s1, expect1, "1부 실배치 H11~H30", CASE);
  assert(sp1a === "H31" && sp1b === "H32", `1부 Spare = H31,H32 got ${sp1a},${sp1b}`, CASE);
  expectSeq(s2, expect2, "2부 실배치 H31~H50", CASE);
  assert(sp2a === "H01" && sp2b === "H02", `2부 Spare = H01,H02 got ${sp2a},${sp2b}`, CASE);

  // Mode A: 2부 Spare → 3부반 → 미근무 HOUSE H03~H10
  expectSeq(s3, expect3, "3부 Mode A 흐름 (Spare→THIRD→미근무 HOUSE)", CASE);

  // 공통 불변조건
  assertTeamOrdersUnchanged(teamOrderBefore, available, CASE);
  for (const sh of ["1부", "2부", "3부"] as ShiftPart[]) {
    assertNoDupInShift(result, sh, CASE);
    assertSpareNotInShiftAssignees(result, sh, CASE);
  }
  assertSparesPresentWhenPoolEnough(result, ["1부", "2부", "3부"], CASE);

  // offset으로 누락 없음: 순환큐 H11..H50,H01..H10 중 1·2부 40명 = H11~H50, 미근무 H01~H10
  const worked12 = new Set([...s1, ...s2]);
  for (let n = 11; n <= 50; n++) {
    assert(
      worked12.has(padName("H", n, 2)),
      `첫 캐디 offset 후 HOUSE ${padName("H", n, 2)} 1·2부 누락 없음`,
      CASE
    );
  }
  for (let n = 1; n <= 10; n++) {
    assert(
      !worked12.has(padName("H", n, 2)),
      `Mode A: ${padName("H", n, 2)}는 1·2부 미근무 (한 바퀴 미완료)`,
      CASE
    );
  }
  // wrap: 2부 끝이 H50 다음 Spare가 H01
  assert(sp2a === "H01", "순환큐 wrap: 2부 Spare1 = H01", CASE);

  // Mode A 판정: start ≠ H01 이어도 정상 (H11 시작)
  assert(start.name === "H11", "CASE A start = H11 (≠ H01)", CASE);
  assert(
    s3[0] === "H01" && s3[1] === "H02",
    "Mode A: 3부 선두 = 2부 Spare H01,H02 (start≠H01이어도 정상)",
    CASE
  );

  // special 미사용 — 파이프라인 미개입
  assert(
    result.specialUnassigned.length === 0 &&
      result.fixedAssignments.length === 0 &&
      result.fiftyFourHoleAssignments.length === 0 &&
      result.oneThreeAssignments.length === 0 &&
      result.oneTwoAssignments.length === 0,
    "special priority 경로 미개입 (fixture에 special 없음)",
    CASE
  );

  // 3부 중복/누락
  assert(new Set(s3).size === s3.length, "3부 중복 없음", CASE);
  assert(s3.length === 30, "3부 30팀 전부 배치", CASE);

  finalizeCase(CASE);
}

// ─────────────────────────────────────────────────────────────
// CASE B — HOUSE 첫 바퀴 완료 Mode B
// HOUSE H001~H120, THIRD T001~T060, start H031
// 1부80 / 2부80 / 3부80
// ─────────────────────────────────────────────────────────────
section("acceptance / business-rule CASE B — Mode B (HOUSE 첫 바퀴 완료)");
{
  const CASE = "CASE_B";
  markCaseStart(CASE);
  const date = "2026-09-02";
  const house = makeHouseCaddies(120, { nameWidth: 3 });
  const third = makeThirdCaddies(60, { idStart: 9001, nameWidth: 3 });
  const available = [...house, ...third];
  const teamOrderBefore = snapshotTeamOrders(available);

  const start = house.find((c) => c.name === "H031")!;
  assert(!!start, "fixture: H031 exists", CASE);

  const reservations = [
    ...makeShiftReservations(date, "1부", 80, 5),
    ...makeShiftReservations(date, "2부", 80, 10),
    ...makeShiftReservations(date, "3부", 80, 14),
  ];

  const result = computeAutoAssignmentsV1({
    date,
    available,
    special: [],
    reservations,
    houseStartCaddyId: start.id,
  });

  const s1 = namesOfShift(result, "1부");
  const s2 = namesOfShift(result, "2부");
  const s3 = namesOfShift(result, "3부");
  const [sp1a, sp1b] = spareNames(result.sparesByShift, "1부");
  const [sp2a, sp2b] = spareNames(result.sparesByShift, "2부");

  printSeq("1부 실배치", s1);
  printSpare("1부", sp1a, sp1b);
  printSeq("2부 실배치", s2);
  printSpare("2부", sp2a, sp2b);
  printSeq("3부 실배치 (전체)", s3);
  printSeq("3부 HOUSE 2·3부 투 (뒤 20)", s3.slice(60));

  const expect1 = wrapRangeNames("H", 31, 80, 120, 3); // H031~H110
  const expect2Never = [
    ...rangeNames("H", 111, 120, 3),
    ...rangeNames("H", 1, 30, 3),
  ]; // 40
  const expect2Tour = wrapRangeNames("H", 31, 40, 120, 3); // H031~H070
  const expect2 = [...expect2Never, ...expect2Tour];

  const expect3Third = rangeNames("T", 1, 60, 3);
  const expect3HouseTour = [
    ...rangeNames("H", 113, 120, 3),
    ...rangeNames("H", 1, 12, 3),
  ]; // 20
  const expect3 = [...expect3Third, ...expect3HouseTour];

  expectSeq(s1, expect1, "1부 실배치 H031~H110", CASE);
  assert(
    sp1a === "H111" && sp1b === "H112",
    `1부 Spare = H111,H112 got ${sp1a},${sp1b}`,
    CASE
  );
  expectSeq(s2, expect2, "2부 실배치 (미근무40 + 투40)", CASE);
  assert(
    sp2a === "H071" && sp2b === "H072",
    `2부 Spare = H071,H072 got ${sp2a},${sp2b}`,
    CASE
  );

  // Mode B: 3부 첫 = THIRD (2부 Spare 아님)
  assert(
    s3.slice(0, 60).every((n) => n.startsWith("T")),
    "Mode B: 3부 선두 60 = THIRD (2부 Spare 아님)",
    CASE
  );
  assert(
    s3[0] === "T001" && s3[59] === "T060",
    "Mode B: 3부 THIRD = T001~T060",
    CASE
  );
  assert(
    s3[0] !== "H071" && s3[0] !== "H072",
    "Mode B: 3부 선두 ≠ 2부 Spare",
    CASE
  );

  expectSeq(
    s3.slice(60),
    expect3HouseTour,
    "3부 HOUSE 2·3부 투 20명 = H113~H120 → H001~H012",
    CASE
  );
  expectSeq(s3, expect3, "3부 전체 Mode B", CASE);

  // 1부 Spare H111,H112는 2부 근무 가능하지만 2·3부 투에서 제외
  assert(s2.includes("H111") && s2.includes("H112"), "1부 Spare는 2부 근무 가능", CASE);
  assert(
    !s3.slice(60).includes("H111") && !s3.slice(60).includes("H112"),
    "1부 Spare H111,H112는 HOUSE 2·3부 투 제외",
    CASE
  );

  // 공통 불변조건
  assertTeamOrdersUnchanged(teamOrderBefore, available, CASE);
  for (const sh of ["1부", "2부", "3부"] as ShiftPart[]) {
    assertNoDupInShift(result, sh, CASE);
    assertSpareNotInShiftAssignees(result, sh, CASE);
  }
  assertSparesPresentWhenPoolEnough(result, ["1부", "2부", "3부"], CASE);

  // offset 누락 없음: 순환 H031..H120,H001..H030 — 1부 80명 = H031~H110
  assert(
    s1[0] === "H031" && s1[s1.length - 1] === "H110",
    "첫 캐디 offset wrap: 1부 H031→…→H110",
    CASE
  );
  // HOUSE 전원 1·2부에서 최소 1회 실근무 → Mode B 조건
  const worked12 = new Set([...s1, ...s2]);
  for (let n = 1; n <= 120; n++) {
    assert(
      worked12.has(padName("H", n, 3)),
      `Mode B 조건: HOUSE ${padName("H", n, 3)} 1·2부 최소 1회 실근무`,
      CASE
    );
  }

  assert(start.name === "H031", "CASE B start = H031 (≠ H001)", CASE);
  assert(
    result.specialUnassigned.length === 0 &&
      result.fixedAssignments.length === 0 &&
      result.fiftyFourHoleAssignments.length === 0 &&
      result.oneThreeAssignments.length === 0 &&
      result.oneTwoAssignments.length === 0,
    "special priority 경로 미개입 (fixture에 special 없음)",
    CASE
  );

  finalizeCase(CASE);
}

// ─────────────────────────────────────────────────────────────
console.log("\n======== ACCEPTANCE SUMMARY ========");
for (const key of ["CASE_A", "CASE_B"]) {
  const r = caseResults[key];
  console.log(`${key}: ${r?.pass ? "PASS" : "FAIL"}`);
  if (r && !r.pass) {
    for (const n of r.notes) console.log(`  • ${n}`);
  }
}
console.log(`assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
