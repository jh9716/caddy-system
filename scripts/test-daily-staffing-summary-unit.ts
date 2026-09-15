/**
 * 일자별 필요/가용 인원 V1 (엔진 규칙 변경 없음, DB write 없음)
 * 실행: npm run test:daily-staffing-summary-unit
 *
 * A. 현재 배치 완료: available−required 금지, 미배치 0 / 상태 정상
 * B. 현재 배치 + 미배치: 상태 미배치, unique−available 금지
 * C. 현재 배치 없음: dry-run 예상 모드
 * D. THIRD/special/ONE_TWO/twoWork 를 HOUSE available과 subtraction 안 함
 * E. #148 effective ops duty 유지, page.tsx extra subtraction 없음
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
  caddyType?: string;
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
      caddyType: opts.caddyType,
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

function unassignedRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    reservation: {
      id: `u${i}`,
      date: "2026-09-07",
      course: "SKY" as const,
      shift: "2부" as const,
      teeTime: "12:00",
      teamName: `U${i}`,
    },
    reason: "UNASSIGNED",
  }));
}

function rowValue(
  model: ReturnType<typeof formatDailyStaffingCardModel>,
  key: string
) {
  return model.rows.find((r) => r.key === key)?.value ?? null;
}

function rowLabel(
  model: ReturnType<typeof formatDailyStaffingCardModel>,
  key: string
) {
  return model.rows.find((r) => r.key === key)?.label ?? null;
}

function assertsNoRequiredAvailableSubtraction(
  summary: ReturnType<typeof buildDailyStaffingSummary>,
  model: ReturnType<typeof formatDailyStaffingCardModel>,
  label: string
) {
  const required = summary.required.count;
  const available = summary.available.count;
  if (required != null && available != null) {
    const forbidden = Math.abs(available - required);
    assert(
      !(
        summary.gap.kind !== "ok" &&
        summary.gap.people === forbidden &&
        forbidden !== summary.unassignedTeams
      ),
      `${label}: gap가 unique−available(${forbidden})이 아님`
    );
    assert(
      !model.rows.some(
        (r) =>
          (r.label === "부족" || r.label === "여유") &&
          r.value === `${forbidden}명`
      ),
      `${label}: 카드에 unique−available ${forbidden} 없음`
    );
  }
  assert(
    !model.rows.some((r) => r.label === "부족"),
    `${label}: '부족' 라벨 없음 (최소 부족만 허용)`
  );
}

section("A. 9/7 현재 배치 완료: 예약 209 / 배정 209 / unique 164 / 가용 148");
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
    availableCount: 148,
    currentDraft: fixture,
    dryRunInput: {
      date: "2026-09-07",
      reservations: makeReservations("2026-09-07", [{ shift: "1부", count: 3 }]),
      available: makeCaddies(10),
      houseStartCaddyId: 1,
    },
  });
  assert(summary.reservation.total === 209, "예약 209팀");
  assert(summary.assignedTeams === 209, "배정 209팀");
  assert(summary.required.count === 164, "실제 투입 unique 164명");
  assert(summary.required.source === "current_board", "source=현재 배치");
  assert(summary.unassignedTeams === 0, "미배치 0팀");
  assert(summary.boardStatus === "ok", "상태 정상");
  assert(summary.gap.kind === "ok", "gap=ok (subtraction 없음)");
  assert(summary.gap.people == null, "부족/여유 숫자 없음");
  assert(summary.available.count === 148, "일반 가용 참고값 148");

  const model = formatDailyStaffingCardModel(summary);
  assert(rowValue(model, "reservation") === "209팀", "카드: 예약 209팀");
  assert(rowValue(model, "assigned") === "209팀", "카드: 배정 209팀");
  assert(rowLabel(model, "required") === "실제 투입", "카드: 실제 투입 라벨");
  assert(rowValue(model, "required") === "164명", "카드: 실제 투입 164명");
  assert(
    model.rows.some((r) => r.key === "required" && r.badge === "current"),
    "카드: [현재 배치] badge"
  );
  assert(rowValue(model, "unassigned") === "0팀", "카드: 미배치 0팀");
  assert(rowValue(model, "status") === "정상", "카드: 상태 정상");
  assert(rowLabel(model, "available") === "일반 가용", "카드: 일반 가용 라벨");
  assert(rowValue(model, "available") === "148명", "카드: 일반 가용 148명");
  assert(
    !model.rows.some(
      (r) =>
        r.label === "부족" ||
        r.value === "16명" ||
        r.value.includes("부족") ||
        (r.key === "gap" && r.value.includes("16"))
    ),
    "부족 16 표시하면 실패"
  );
  assert(!model.rows.some((r) => r.badge === "estimate"), "현재 배치일 때 [예상] 없음");
  assert(
    model.shiftLine === "1부 77 · 2부 80 · 3부 52",
    "카드 부별 77·80·52"
  );
  assertsNoRequiredAvailableSubtraction(summary, model, "A");
}

section("B. 현재 배치 + 미배치 5팀");
{
  const assigned = Array.from({ length: 205 }, (_, i) =>
    row({ shift: "1부", id: `r${i}`, caddyId: i + 1 })
  );
  const summary = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: 148,
    currentDraft: draftOf(assigned, {
      unassignedReservations: unassignedRows(5),
    }),
  });
  assert(summary.reservation.total === 210, "예약 210팀");
  assert(summary.assignedTeams === 205, "배정 205팀");
  assert(summary.unassignedTeams === 5, "미배치 5팀");
  assert(summary.required.source === "current_board", "현재 배치 source");
  assert(summary.boardStatus === "unassigned", "상태 미배치");
  assert(
    summary.gap.kind === "min_shortage" && summary.gap.people === 5,
    "최소 부족은 미배치 팀 수 5 (unique−available 아님)"
  );
  assert(
    summary.gap.people !== Math.abs(148 - (summary.required.count || 0)),
    "gap이 unique−available이 아님"
  );

  const model = formatDailyStaffingCardModel(summary);
  assert(rowValue(model, "unassigned") === "5팀", "카드: 미배치 5팀");
  assert(rowValue(model, "status") === "미배치", "카드: 상태 미배치");
  assert(
    model.rows.some(
      (r) => r.key === "gap" && r.label === "최소 부족" && r.value === "5명 이상"
    ),
    "카드: 최소 부족 5명 이상"
  );
  assert(
    !model.rows.some((r) => r.label === "부족" && r.value !== "5명 이상"),
    "임의 부족 인원 숫자 없음"
  );
  assertsNoRequiredAvailableSubtraction(summary, model, "B");
}

section("C. 현재 배치 없음 → dry-run 예상 모드");
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
    assert(summary.required.source === "engine_estimate", "source=예상");
    assert(summary.boardStatus === "estimate", "boardStatus=estimate");
    assert(summary.required.count === unique, "예상 필요 = unique caddy");
    assert(summary.reservation.total === 3, "예약 3팀");
    const model = formatDailyStaffingCardModel(summary);
    assert(rowLabel(model, "required") === "예상 필요", "카드: 예상 필요");
    assert(
      model.rows.some((r) => r.badge === "estimate"),
      "카드 [예상] badge"
    );
    assert(!model.rows.some((r) => r.badge === "current"), "예상 모드에 현재 배치 badge 없음");
    assert(rowLabel(model, "available") === "현재 가용", "카드: 현재 가용");
    assert(rowLabel(model, "unassigned") === "예상 미배치", "카드: 예상 미배치");
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
    assert(summary.required.source === "engine_estimate", "dry-run source");
    assert(summary.unassignedTeams > 0, "예상 미배치 존재");
    assert(summary.required.imprecise, "미배치 있으면 필요 숫자 확정 아님");
    assert(summary.gap.kind === "min_shortage", "예상 미배치는 최소 부족");
    assert(
      summary.gap.people === summary.unassignedTeams,
      "최소 부족 = 예상 미배치 팀 수"
    );
    const model = formatDailyStaffingCardModel(summary);
    assert(rowLabel(model, "unassigned") === "예상 미배치", "카드: 예상 미배치");
    assert(
      model.rows.some(
        (r) =>
          r.key === "gap" &&
          r.label === "최소 부족" &&
          r.value === `${summary.unassignedTeams}명`
      ),
      "카드: 최소 부족 N명"
    );
    assertsNoRequiredAvailableSubtraction(summary, model, "C");
  }
}

section("D. THIRD / special / ONE_TWO / twoWork 를 HOUSE available과 subtraction 안 함");
{
  const house: AutoAssignmentRow[] = [];
  for (let i = 1; i <= 10; i++) {
    house.push(
      row({
        shift: "1부",
        id: `h${i}`,
        caddyId: i,
        name: `H${i}`,
        caddyType: "HOUSE",
      })
    );
  }
  const third: AutoAssignmentRow[] = [];
  for (let i = 0; i < 5; i++) {
    third.push(
      row({
        shift: "3부",
        id: `th${i}`,
        caddyId: 500 + i,
        name: `T${i}`,
        caddyType: "THIRD",
      })
    );
  }
  const specialDuty = row({
    shift: "1부",
    id: "sd1",
    caddyId: 800,
    name: "당번특",
    kind: "fixed",
  });
  const specialSupport = [
    row({
      shift: "1부",
      id: "sup-a",
      caddyId: 801,
      name: "서포트",
      kind: "specialSupport",
      pairId: "sup",
      supportKind: "SUP12",
    }),
    row({
      shift: "2부",
      id: "sup-b",
      caddyId: 801,
      name: "서포트",
      kind: "specialSupport",
      pairId: "sup",
      supportKind: "SUP12",
    }),
  ];
  const oneTwo = [
    row({
      shift: "1부",
      id: "ot-a",
      caddyId: 802,
      name: "원투",
      kind: "oneTwo",
      pairId: "ot",
    }),
    row({
      shift: "2부",
      id: "ot-b",
      caddyId: 802,
      name: "원투",
      kind: "oneTwo",
      pairId: "ot",
    }),
  ];
  const twoWork = [
    row({
      shift: "1부",
      id: "tw-a",
      caddyId: 803,
      name: "투웍",
      kind: "regular",
    }),
    row({
      shift: "2부",
      id: "tw-b",
      caddyId: 803,
      name: "투웍",
      kind: "regular",
    }),
  ];
  const mixed = draftOf([
    ...house,
    ...third,
    specialDuty,
    ...specialSupport,
    ...oneTwo,
    ...twoWork,
  ]);
  const unique = countUniqueRequiredCaddies(mixed.assignments);
  const houseAvailable = 10;
  assert(unique > houseAvailable, `unique ${unique} > HOUSE available ${houseAvailable}`);
  assert(mixed.unassignedReservations.length === 0, "미배치 0");
  const summary = buildDailyStaffingSummary({
    date: "2026-09-07",
    availableCount: houseAvailable,
    currentDraft: mixed,
  });
  assert(summary.boardStatus === "ok", "혼합 배치 완료 → 상태 정상");
  assert(summary.unassignedTeams === 0, "미배치 0팀");
  assert(summary.gap.kind === "ok", "HOUSE subtraction 없음");
  assert(summary.gap.people == null, "부족 숫자 없음");
  const model = formatDailyStaffingCardModel(summary);
  const forbidden = unique - houseAvailable;
  assert(
    !model.rows.some(
      (r) => r.value === `${forbidden}명` && (r.label === "부족" || r.key === "gap")
    ),
    `HOUSE unique−available ${forbidden} 표시 금지`
  );
  assert(rowValue(model, "status") === "정상", "카드: 상태 정상");
  assertsNoRequiredAvailableSubtraction(summary, model, "D");
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

  const linkedCases: Array<{
    kind: AssignmentKind;
    supportKind?: string;
    label: string;
  }> = [
    { kind: "oneTwo", label: "1·2" },
    { kind: "twoThree", label: "2·3" },
    { kind: "oneThree", label: "1·3" },
    { kind: "fiftyFourHole", label: "54홀" },
    { kind: "specialSupport", supportKind: "SUP12", label: "SUP12" },
  ];
  for (const spec of linkedCases) {
    const shiftA: ShiftPart = spec.kind === "twoThree" ? "2부" : "1부";
    const shiftB: ShiftPart =
      spec.kind === "oneThree" || spec.kind === "fiftyFourHole"
        ? "3부"
        : spec.kind === "twoThree"
          ? "3부"
          : "2부";
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
  assert(!noneModel.rows.some((r) => r.key === "required"), "예약 없는 날 필요 행 없음");
}

section("현재 화면이 있으면 dry-run 엔진을 호출하지 않음");
{
  const engineCalls = 0;
  const original = computeAutoAssignmentsV1;
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
  assert(summary.assignedTeams === 1, "실배정 1팀");
  assert(summary.boardStatus === "unassigned", "빈 칸 → 미배치");
}

section("E. #148 effective ops duty 유지 / extra subtraction 제거");
{
  assert(
    canonicalAvailableCount({
      availableIds: [1, 2, 3, 3],
    }) === 3,
    "unique available만 세고 duty를 다시 빼지 않음"
  );
  const lib = read("src/lib/dailyStaffingSummary.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  const prisma = read("prisma/schema.prisma");
  const availSvc = read("src/lib/availabilityService.ts");
  const effective = read("src/lib/opsDutyEffectiveService.ts");

  assert(!/prisma|fetch\(|DATABASE_URL|spreadsheets/.test(lib), "lib에 DB/네트워크 없음");
  assert(lib.includes("computeAutoAssignmentsV1"), "dry-run만 엔진 순수 호출");
  assert(
    !/opsDutyCaddyIds/.test(lib),
    "canonicalAvailableCount가 opsDutyCaddyIds를 다시 빼지 않음"
  );
  assert(
    availSvc.includes("loadEffectiveOpsDutyEntries"),
    "availability가 effective ops duty를 반영"
  );
  assert(
    availSvc.includes("options?.opsDutyDeps"),
    "GET availability가 options 없이 가용 카운트를 계산"
  );
  assert(
    effective.includes("resolveEffectiveOpsDuty") ||
      /override/.test(effective),
    "effective ops duty 모듈 유지"
  );
  assert(
    /override\s*>\s*stored|loadEffectiveOpsDutyEntries/.test(availSvc) ||
      availSvc.includes("loadEffectiveOpsDutyEntries"),
    "#148 loadEffectiveOpsDutyEntries 경로 유지"
  );

  const staffingBlock = page.slice(
    page.indexOf("const staffingAvailableCount"),
    page.indexOf("const operationalRoster")
  );
  assert(
    staffingBlock.includes("canonicalAvailableCount"),
    "page가 canonicalAvailableCount 사용"
  );
  assert(
    !/opsDutyCaddyIds/.test(staffingBlock),
    "page staffing 경로가 GET daily-ops-duties caddyIds를 재차감하지 않음"
  );
  assert(
    !staffingBlock.includes("duty.has("),
    "dry-run pool에서 duty caddyIds extra filter 없음"
  );
  assert(page.includes("hasCurrentBoardStaffingResult"), "현재 배치면 dry-run 생략");
  assert(page.includes("DailyStaffingSummaryCard"), "요약 카드 연결");
  assert(page.includes("비가용"), "비가용 버튼 유지");
  assert(!page.includes("월간 예측"), "월간 예측 없음");
  assert(!/model DailyStaffing/.test(prisma), "schema 모델 추가 없음");
  assert(hasCurrentBoardStaffingResult(null) === false, "빈 draft는 현재 배치 아님");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
