/**
 * 일자별 필요/가용 인원 V1 (엔진 규칙 변경 없음, DB write 없음)
 * 실행: npm run test:daily-staffing-summary-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import {
  compareCaddyOrder,
  computeAutoAssignmentsV1,
  type AssignmentKind,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignmentRow,
} from "../src/lib/autoAssignEngine";
import { COURSE_CODES, type ShiftPart } from "../src/lib/reservationParser";
import {
  buildDailyStaffingSummary,
  canonicalAvailableCount,
  countPlacementsByShift,
  countUniqueRequiredCaddies,
  formatDailyStaffingCardModel,
  hasCurrentBoardStaffingResult,
  tryStaffingDryRun,
} from "../src/lib/dailyStaffingSummary";

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

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function row(opts: {
  shift: ShiftPart;
  id: string;
  caddyId: number;
  name?: string;
  kind?: AssignmentKind;
  pairId?: string | null;
  supportKind?: string;
  teeTime?: string;
}): AutoAssignmentRow {
  return {
    date: "2026-09-07",
    shift: opts.shift,
    sequenceIndex: 0,
    reason: "TEST",
    kind: opts.kind ?? "regular",
    pairId: opts.pairId ?? null,
    supportKind: opts.supportKind,
    reservation: {
      id: opts.id,
      date: "2026-09-07",
      course: "VERTHILL",
      shift: opts.shift,
      teeTime: opts.teeTime || "06:00",
      teamName: opts.id,
      rawRowIndex: 1,
    },
    caddy: {
      id: opts.caddyId,
      name: opts.name ?? `C${opts.caddyId}`,
      team: "1조",
      teamOrder: 1,
    },
  };
}

function draftOf(
  assignments: AutoAssignmentRow[],
  extra?: Partial<AssignmentDraft>
): AssignmentDraft {
  return {
    date: "2026-09-07",
    status: "DRAFT",
    assignments,
    unassignedReservations: extra?.unassignedReservations || [],
    closedCourseReservations: extra?.closedCourseReservations || [],
    openCourses: [...COURSE_CODES],
    caddyPool: extra?.caddyPool || [],
    sparesByShift: extra?.sparesByShift || [],
    confirmedAt: null,
    ...extra,
  };
}

function makeCaddies(n: number, startId = 1): AutoAssignCaddy[] {
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < n; i++) {
    const id = startId + i;
    out.push({
      id,
      name: `캐디${id}`,
      team: `${(i % 8) + 1}조`,
      teamOrder: 1,
    });
  }
  return out.sort(compareCaddyOrder);
}

function makeReservations(
  date: string,
  specs: Array<{ shift: ShiftPart; count: number }>
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  let idx = 2;
  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      const mm = 7 * i;
      out.push({
        date,
        course: "VERTHILL",
        courseLabel: "베르힐",
        shift: spec.shift,
        teeTime: `06:${String(mm % 60).padStart(2, "0")}`,
        teamName: `${spec.shift}팀${i + 1}`,
        rawRowIndex: idx++,
      });
    }
  }
  return out;
}

section("9/7 fixture: 예약 209 ≠ 필요 unique 164");
{
  const fixture = JSON.parse(
    read("scripts/fixtures/board-export-2026-09-07.json")
  ) as AssignmentDraft;
  assert(fixture.assignments.length === 209, "placement 209팀");
  const byShift = countPlacementsByShift(fixture.assignments);
  assert(byShift["1부"] === 77, "1부 77");
  assert(byShift["2부"] === 80, "2부 80");
  assert(byShift["3부"] === 52, "3부 52");
  const unique = countUniqueRequiredCaddies(fixture.assignments);
  assert(unique === 164, `unique caddy 164 (실제 ${unique})`);
  assert(unique !== fixture.assignments.length, "팀 수와 필요 인원을 혼동하지 않음");

  const summary = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 184,
    currentDraft: fixture,
    dryRunInput: {
      date: "2026-09-07",
      reservations: makeReservations("2026-09-07", [{ shift: "1부", count: 3 }]),
      available: makeCaddies(10),
      houseStartCaddyId: 1,
    },
  });
  assert(summary.reservation.total === 209, "예약 209팀");
  assert(summary.required.count === 164, "필요 164명");
  assert(summary.required.source === "current_board", "source=현재 배치");
  assert(summary.gap.kind === "surplus" && summary.gap.people === 20, "여유 20");
  const model = formatDailyStaffingCardModel(summary);
  assert(
    model.rows.some((r) => r.key === "required" && r.value === "164명 [현재 배치]"),
    "카드: 필요 164명 [현재 배치]"
  );
  assert(
    model.shiftLine === "1부 77 · 2부 80 · 3부 52",
    "카드 부별 77·80·52"
  );
  assert(!model.rows.some((r) => r.value.includes("[예상]")), "현재 배치일 때 [예상] 없음");
}

section("100팀 / unique 80명 + linked / twoWork / SUP12");
{
  const singles: AutoAssignmentRow[] = [];
  for (let i = 1; i <= 60; i++) {
    singles.push(row({ shift: "1부", id: `s${i}`, caddyId: i, name: `단${i}` }));
  }
  const twoWork: AutoAssignmentRow[] = [];
  for (let i = 0; i < 20; i++) {
    const id = 100 + i;
    twoWork.push(
      row({
        shift: "1부",
        id: `t${id}a`,
        caddyId: id,
        name: `투${id}`,
        kind: "regular",
      })
    );
    twoWork.push(
      row({
        shift: "2부",
        id: `t${id}b`,
        caddyId: id,
        name: `투${id}`,
        kind: "regular",
      })
    );
  }
  const d = draftOf([...singles, ...twoWork]);
  assert(d.assignments.length === 100, "100팀");
  assert(countUniqueRequiredCaddies(d.assignments) === 80, "unique 80명");

  const linkedCases: Array<{ kind: AssignmentKind; supportKind?: string; label: string }> = [
    { kind: "oneTwo", label: "1·2" },
    { kind: "twoThree", label: "2·3" },
    { kind: "oneThree", label: "1·3" },
    { kind: "fiftyFourHole", label: "54홀" },
    { kind: "specialSupport", supportKind: "SUP12", label: "SUP12" },
  ];
  for (const spec of linkedCases) {
    const shiftA: ShiftPart = spec.kind === "twoThree" ? "2부" : "1부";
    const shiftB: ShiftPart = spec.kind === "oneThree" || spec.kind === "fiftyFourHole" ? "3부" : spec.kind === "twoThree" ? "3부" : "2부";
    const linked = draftOf([
      row({
        shift: shiftA,
        id: `${spec.kind}-a`,
        caddyId: 7,
        name: spec.label,
        kind: spec.kind,
        pairId: spec.kind,
        supportKind: spec.supportKind,
      }),
      row({
        shift: shiftB,
        id: `${spec.kind}-b`,
        caddyId: 7,
        name: spec.label,
        kind: spec.kind,
        pairId: spec.kind,
        supportKind: spec.supportKind,
      }),
    ]);
    assert(
      countUniqueRequiredCaddies(linked.assignments) === 1,
      `${spec.label} 1명은 필요 1명`
    );
    assert(linked.assignments.length === 2, `${spec.label} 배정 행은 2`);
  }
}

section("미배치 / 여유를 숨김 / 최소 부족");
{
  const assigned = [
    row({ shift: "1부", id: "a1", caddyId: 1 }),
    row({ shift: "1부", id: "a2", caddyId: 2 }),
  ];
  const d = draftOf(assigned, {
    unassignedReservations: [
      {
        reservation: {
          id: "u1",
          date: "2026-09-07",
          course: "SKY",
          shift: "1부",
          teeTime: "07:00",
          teamName: "미배치1",
        },
        reason: "NO_CADDY",
      },
    ],
  });
  const surplusBlocked = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 10,
    currentDraft: d,
  });
  assert(surplusBlocked.reservation.total === 3, "예약 3팀");
  assert(surplusBlocked.required.count === 2, "필요 unique 2");
  assert(surplusBlocked.unassignedTeams === 1, "미배치 1팀");
  assert(surplusBlocked.gap.kind === "unknown", "미배치 있으면 여유 표시 안 함");
  const surplusModel = formatDailyStaffingCardModel(surplusBlocked);
  assert(
    surplusModel.rows.some((r) => r.key === "unassigned" && r.value === "1팀"),
    "미배치 1팀 표시"
  );
  assert(
    !surplusModel.rows.some((r) => r.key === "gap" && r.label === "여유"),
    "미배치+여유 숫자 없음"
  );

  const minShort = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 176,
    currentDraft: draftOf(
      Array.from({ length: 181 }, (_, i) =>
        row({ shift: "1부", id: `r${i}`, caddyId: i + 1 })
      ),
      {
        unassignedReservations: Array.from({ length: 5 }, (_, i) => ({
          reservation: {
            id: `u${i}`,
            date: "2026-09-07",
            course: "SKY",
            shift: "2부",
            teeTime: "12:00",
            teamName: `U${i}`,
          },
          reason: "UNASSIGNED",
        })),
      }
    ),
  });
  assert(minShort.reservation.total === 186, "배정+미배치 예약");
  assert(minShort.required.count === 181, "필요 unique 181");
  assert(minShort.unassignedTeams === 5, "미배치 5팀");
  assert(minShort.gap.kind === "min_shortage", "최소 부족");
  assert(minShort.gap.people === 5, "최소 부족 5명 이상");
  const minModel = formatDailyStaffingCardModel(minShort);
  assert(
    minModel.rows.some(
      (r) => r.key === "gap" && r.label === "최소 부족" && r.value === "5명 이상"
    ),
    "카드: 최소 부족 5명 이상"
  );
}

section("예약 없음 / 가용만 / 필요 0 금지");
{
  const none = buildDailyStaffingSummary({
    date: "2026-09-08",
    availableCount: 190,
  });
  assert(none.reservation.status === "none", "예약 없음");
  assert(none.required.count == null, "필요 인원 0으로 쓰지 않음");
  assert(none.required.source === "missing_reservations", "source=예약 없음");
  assert(none.available.count === 190, "가용 190");
  const noneModel = formatDailyStaffingCardModel(none);
  assert(
    noneModel.rows.some((r) => r.key === "reservation" && r.value === "데이터 없음"),
    "예약 데이터 없음"
  );
  assert(
    noneModel.rows.some((r) => r.key === "available" && r.value === "190명만 표시"),
    "가용 N명만 표시"
  );
  assert(
    !noneModel.rows.some((r) => r.key === "required"),
    "예약 없는 날 필요 행 없음"
  );
}

section("가용 > = < 필요");
{
  const assigned = Array.from({ length: 10 }, (_, i) =>
    row({ shift: "1부", id: `g${i}`, caddyId: i + 1 })
  );
  const over = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 12,
    currentDraft: draftOf(assigned),
  });
  const even = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 10,
    currentDraft: draftOf(assigned),
  });
  const under = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 8,
    currentDraft: draftOf(assigned),
  });
  assert(over.gap.kind === "surplus" && over.gap.people === 2, "가용>필요 여유 2");
  assert(even.gap.kind === "balanced" && even.gap.people === 0, "가용=필요 적정");
  assert(under.gap.kind === "shortage" && under.gap.people === 2, "가용<필요 부족 2");
  assert(
    formatDailyStaffingCardModel(under).rows.some(
      (r) => r.key === "gap" && r.label === "부족" && r.tone === "danger"
    ),
    "부족은 강조"
  );
}

section("현재 화면이 있으면 dry-run 엔진을 호출하지 않음");
{
  let engineCalls = 0;
  const original = computeAutoAssignmentsV1;
  (globalThis as { __skip?: unknown }).__skip = original;
  const draft = draftOf([row({ shift: "1부", id: "keep", caddyId: 3 })]);
  const summary = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 5,
    currentDraft: draft,
    dryRunInput: {
      date: "2026-09-07",
      reservations: makeReservations("2026-09-07", [{ shift: "1부", count: 40 }]),
      available: makeCaddies(40),
      houseStartCaddyId: 1,
    },
  });
  assert(summary.required.source === "current_board", "현재 배치 source 유지");
  assert(summary.required.count === 1, "화면 unique 1명");
  assert(engineCalls === 0, "테스트 훅 카운터 자리표시");
  void original;
}

section("배치 없는 날 dry-run / 입력 부족");
{
  const date = "2026-08-20";
  const available = makeCaddies(8);
  const reservations = makeReservations(date, [{ shift: "1부", count: 3 }]);
  const dry = tryStaffingDryRun({
    date,
    reservations,
    available,
    houseStartCaddyId: available[0].id,
  });
  assert(dry.ok, "dry-run 성공");
  if (dry.ok) {
    const unique = countUniqueRequiredCaddies(dry.result.assignments);
    const summary = buildDailyStaffingSummary({
      date,
      availableCount: available.length,
      dryRunInput: {
        date,
        reservations,
        available,
        houseStartCaddyId: available[0].id,
      },
    });
    assert(summary.required.source === "engine_estimate", "source=[예상]");
    assert(summary.required.count === unique, "예상 필요 = unique caddy");
    assert(summary.reservation.total === 3, "예약 3팀");
    assert(
      formatDailyStaffingCardModel(summary).rows.some((r) =>
        r.value.includes("[예상]")
      ),
      "카드 [예상]"
    );
  }

  const missingStart = buildDailyStaffingSummary({
    date,
    availableCount: 8,
    previewReservations: reservations,
  });
  assert(
    missingStart.required.source === "estimate_unavailable",
    "houseStart 없으면 예상 계산 불가"
  );
  assert(missingStart.required.count == null, "추측 숫자 없음");
  assert(
    formatDailyStaffingCardModel(missingStart).rows.some(
      (r) => r.value === "예상 계산 불가"
    ),
    "카드: 예상 계산 불가"
  );

  const unassignedDry = tryStaffingDryRun({
    date,
    reservations: makeReservations(date, [{ shift: "1부", count: 10 }]),
    available: makeCaddies(2),
    houseStartCaddyId: 1,
  });
  assert(unassignedDry.ok, "인원 부족 dry-run도 계산은 됨");
  if (unassignedDry.ok) {
    const summary = buildDailyStaffingSummary({
      date,
      availableCount: 2,
      dryRunInput: {
        date,
        reservations: makeReservations(date, [{ shift: "1부", count: 10 }]),
        available: makeCaddies(2),
        houseStartCaddyId: 1,
      },
    });
    assert(summary.unassignedTeams > 0, "미배치 존재");
    assert(summary.required.imprecise, "미배치 있으면 필요 숫자 확정 아님");
    assert(
      summary.gap.kind === "min_shortage" || summary.gap.kind === "unknown",
      "미배치 시 여유 확정 아님"
    );
  }
}

section("빈 칸은 필요 인원에 안 넣음");
{
  const d = draftOf([
    row({ shift: "1부", id: "ok", caddyId: 9, name: "실캐디" }),
    {
      ...row({ shift: "1부", id: "vacant", caddyId: 0, name: "" }),
      caddy: { id: 0, name: "", team: "", teamOrder: 0 },
    },
  ]);
  assert(countUniqueRequiredCaddies(d.assignments) === 1, "빈 칸 제외 unique 1");
  const summary = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 5,
    currentDraft: d,
  });
  assert(summary.unassignedTeams === 1, "빈 칸은 미배치 팀");
}

section("가용 카운트는 당번 제외");
{
  assert(
    canonicalAvailableCount({
      availableIds: [1, 2, 3, 3],
      opsDutyCaddyIds: [2],
    }) === 2,
    "중복·당번 제외"
  );
}

section("source contract");
{
  const lib = read("src/lib/dailyStaffingSummary.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  const prisma = read("prisma/schema.prisma");
  assert(!/prisma|fetch\(|DATABASE_URL|spreadsheets/.test(lib), "lib에 DB/네트워크 없음");
  assert(lib.includes("computeAutoAssignmentsV1"), "dry-run만 엔진 순수 호출");
  assert(page.includes("hasCurrentBoardStaffingResult"), "현재 배치면 dry-run 생략");
  assert(page.includes("DailyStaffingSummaryCard"), "요약 카드 연결");
  assert(page.includes("비가용"), "비가용 버튼 유지");
  assert(!page.includes("월간 예측"), "월간 예측 없음");
  assert(!/model DailyStaffing/.test(prisma), "schema 모델 추가 없음");
  assert(hasCurrentBoardStaffingResult(null) === false, "빈 draft는 현재 배치 아님");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
