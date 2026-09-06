/**
 * 배치 상호작용 A~D 단위 테스트 (DB write 없음)
 * 실행: npx tsx scripts/test-board-mutation-interaction-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLiveChangePersistPlan,
  makeMoveReservationChange,
  previewLiveAssignmentChange,
} from "../src/lib/assignmentChange";
import {
  confirmedDraftKeepingPlacedUnavailable,
  createDraftFromAutoResult,
  snapshotComputePoolFromDraft,
  applyLiveResultToDraft,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  reflowRegularAssignments,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
} from "../src/lib/autoAssignEngine";
import {
  overlayUnavailableIdsKeepingPlaced,
  overlayUnavailableKeepingShift,
} from "../src/lib/caddyPoolCanonical";
import {
  emptySpecialSupportByShift,
  isSpecialSupportDraftStale,
} from "../src/lib/dailySpecialSupport";
import {
  isDraftVersionConflict,
  resolveRecalcDraftSavePrep,
  shouldAcceptDraftQueue,
  shouldAcceptRecalcDraftQueue,
} from "../src/lib/recalcDraftSave";

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
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function supportCaddy(id: number, name: string): AutoAssignCaddy {
  return {
    id,
    name,
    team: "7조",
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function makeCaddies(n: number, startId = 1): AutoAssignCaddy[] {
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < n; i++) {
    out.push(house(startId + i, i + 1));
  }
  return out.sort(compareCaddyOrder);
}

function res(
  date: string,
  id: string,
  opts: { teeTime: string; shift?: string; course?: string }
): AutoAssignReservation {
  return {
    id,
    date,
    course: opts.course || "SKY",
    shift: opts.shift || "1부",
    teeTime: opts.teeTime,
    teamName: id,
    rawRowIndex: Number(id.replace(/\D/g, "") || 1),
  };
}

function caddyOn(result: AutoAssignResultV1, reservationId: string): number | undefined {
  return result.assignments.find((a) => a.reservation.id === reservationId)?.caddy.id;
}

function laterShiftIds(result: AutoAssignResultV1, caddyId: number): string[] {
  return result.assignments
    .filter((a) => a.caddy.id === caddyId && a.shift !== "1부")
    .map((a) => `${a.shift}:${a.kind}`);
}

function regularSnap(result: AutoAssignResultV1, shift: string): string {
  return result.assignments
    .filter((a) => a.shift === shift && a.kind === "regular")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
}

function spareSnap(result: AutoAssignResultV1): string {
  return (result.sparesByShift || [])
    .map(
      (s) =>
        `${s.shift}:${s.spare1?.caddyId ?? "-"}:${s.spare2?.caddyId ?? "-"}`
    )
    .join("|");
}

section("1. 2부 effective 병가: 1부 유지 + 2·3부 재등장 금지");
{
  const date = "2026-08-27";
  const pool = makeCaddies(10);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부" }),
      res(date, "B3", { teeTime: "12:16", shift: "2부" }),
      res(date, "C1", { teeTime: "16:00", shift: "3부" }),
      res(date, "C2", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const b1Id = caddyOn(previous, "B1")!;
  const shift1Before = previous.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: b1Id, shift: "2부" },
  });
  const shift1After = preview.after.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  assert(shift1After === shift1Before, "2부 병가 후 1부 identity 유지");
  assert(laterShiftIds(preview.after, b1Id).length === 0, "2·3부에 병가 캐디 없음");
  const from = preview.after.unavailableFromShift?.find((row) => row.caddyId === b1Id);
  assert(from?.effectiveFromShift === "2부", "after.unavailableFromShift=2부");
}

section("2. 부분 병가 후 MOVE: later shift regular 재선택 금지");
{
  const date = "2026-08-27";
  const pool = makeCaddies(10);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부", course: "SKY" }),
      res(date, "C1", { teeTime: "16:00", shift: "3부" }),
    ],
  });
  const b1Id = caddyOn(previous, "B1")!;
  const sick = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: b1Id, shift: "2부" },
  });
  const overlay = overlayUnavailableKeepingShift({
    dailyUnavailable: sick.after.unavailableFromShift,
    placedIds: sick.after.assignments.map((row) => row.caddy.id),
  });
  assert(
    overlay.some((row) => row.caddyId === b1Id && row.effectiveFromShift === "2부"),
    "still-placed 2부 병가는 overlay에서 유지"
  );
  const allDayOverlay = overlayUnavailableIdsKeepingPlaced({
    dailyUnavailableIds: [b1Id],
    placedIds: sick.after.assignments.map((row) => row.caddy.id),
  });
  const stillOn1 = sick.after.assignments.some(
    (row) => row.shift === "1부" && row.caddy.id === b1Id
  );
  if (stillOn1) {
    assert(!allDayOverlay.includes(b1Id), "ID-only overlay는 1부 잔존 시 종일로 빼지 않음");
  }
  const b2 = sick.after.assignments.find(
    (row) => row.shift === "2부" && row.reservation.id === "B2"
  );
  assert(!!b2, "MOVE 소스 2부 예약 있음");
  const moved = reflowRegularAssignments({
    previous: {
      ...sick.after,
      unavailableCaddyIds: overlay.map((row) => row.caddyId),
      unavailableFromShift: overlay,
    },
    regularCaddyPool: pool,
    events: [
      {
        type: "MOVE_RESERVATION",
        reservationKey: reservationKey(b2!.reservation),
        to: { course: "VERTHILL", shift: "2부", teeTime: "12:08" },
      },
    ],
  });
  assert(moved.warnings.every((w) => w.level !== "error"), "부분 병가 후 MOVE 성공");
  assert(laterShiftIds(moved.after, b1Id).length === 0, "MOVE 후에도 2·3부 재선택 없음");
}

section("3. 특수지원 재맞추기는 main과 같이 정상 순번/스페어를 유지한다");
{
  const date = "2026-08-26";
  const available = [house(1, 1), house(2, 2), house(3, 3)];
  const off = supportCaddy(90, "휴무지원");
  const reservations = [
    res(date, "A1", { teeTime: "07:00", shift: "1부", course: "SKY" }),
    res(date, "A2", { teeTime: "07:08", shift: "1부", course: "SKY" }),
    res(date, "A3", { teeTime: "07:16", shift: "1부", course: "OCEAN" }),
    res(date, "A4", { teeTime: "07:24", shift: "1부", course: "LAKE" }),
    res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
    res(date, "B2", { teeTime: "12:08", shift: "2부", course: "SKY" }),
  ];
  const without = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations.filter((row) => row.id !== "A4"),
    protectedTailCount: 0,
  });
  const withSupport = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    withSupport.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90 && row.shift === "1부"
    ),
    "재맞추기(compute)는 지원자를 1부 꼬리에 배치"
  );
  assert(
    regularSnap(withSupport, "1부") === regularSnap(without, "1부"),
    "1부 정상 HOUSE identity 유지"
  );
  assert(
    regularSnap(withSupport, "2부") === regularSnap(without, "2부"),
    "2부 정상 HOUSE identity 유지"
  );
  assert(
    spareSnap(withSupport) === spareSnap(without),
    "스페어가 지원자 때문에 바뀌지 않음"
  );
  const draft = createDraftFromAutoResult(withSupport, available);
  const roundTrip = confirmedDraftKeepingPlacedUnavailable(draft);
  assert(
    regularSnap(
      { ...withSupport, assignments: roundTrip.assignments },
      "1부"
    ) === regularSnap(withSupport, "1부"),
    "새로고침 hydrate 후에도 1부 identity 동일"
  );
  assert(
    roundTrip.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90
    ),
    "hydrate 후에도 지원 배치 유지"
  );
  const persistPool = snapshotComputePoolFromDraft(draft, withSupport);
  assert(
    persistPool.some((c) => c.id === 90),
    "main과 같이 assigned seed에 지원 HOUSE가 포함"
  );
  const b1 = withSupport.assignments.find((row) => row.reservation.id === "B1");
  const moved = reflowRegularAssignments({
    previous: withSupport,
    regularCaddyPool: available,
    events: [
      {
        type: "MOVE_RESERVATION",
        reservationKey: reservationKey(b1!.reservation),
        to: { course: "VERTHILL", shift: "2부", teeTime: "12:00" },
      },
    ],
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    moved.after.assignments
      .filter((row) => row.caddy.id === 90)
      .every((row) => row.kind === "specialSupport" && row.shift === "1부"),
    "MOVE 후에도 지원자는 1부 specialSupport"
  );
  assert(
    !moved.after.assignments.some(
      (row) => row.caddy.id === 90 && row.kind === "regular"
    ),
    "available pool 밖 지원자는 regular로 중복되지 않음"
  );
  const sick = previewLiveAssignmentChange({
    previous: withSupport,
    regularCaddyPool: available,
    change: { type: "CADDY_SICK", caddyId: caddyOn(withSupport, "A1")!, shift: "2부" },
  });
  assert(
    sick.after.assignments
      .filter((row) => row.caddy.id === 90)
      .every((row) => row.kind === "specialSupport"),
    "SICK reflow 후에도 지원자는 specialSupport"
  );
}

section("7A. 1·2 regular 투대기 2부 SICK → 1부 유지, 2부 이후만 제외");
{
  const date = "2026-08-27";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부" }),
      res(date, "B3", { teeTime: "12:16", shift: "2부" }),
      res(date, "C1", { teeTime: "16:00", shift: "3부" }),
      res(date, "C2", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const dual = previous.assignments
    .filter((row) => row.kind === "regular" && row.caddy.caddyType === "HOUSE")
    .reduce<number | null>((found, row) => {
      if (found) return found;
      const other = previous.assignments.some(
        (alt) =>
          alt.caddy.id === row.caddy.id &&
          alt.shift === "2부" &&
          row.shift === "1부" &&
          alt.kind === "regular"
      );
      return other ? row.caddy.id : null;
    }, null);
  assert(!!dual, "1·2 regular HOUSE 투대기 캐디 존재");
  const shift1Before = previous.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: dual!, shift: "2부" },
  });
  const shift1After = preview.after.assignments
    .filter((a) => a.shift === "1부")
    .map((a) => `${a.reservation.id}:${a.caddy.id}`)
    .sort()
    .join("|");
  const engineFrom = preview.after.unavailableFromShift?.find(
    (row) => row.caddyId === dual
  )?.effectiveFromShift;
  const plan = buildLiveChangePersistPlan(preview);
  const persisted = plan.unavailables.find((row) => row.caddyId === dual);
  assert(shift1After === shift1Before, "2부 병가 후 1부 identity 유지");
  assert(
    preview.after.assignments.some(
      (row) => row.shift === "1부" && row.caddy.id === dual
    ),
    "투대기 1부 배치는 유지"
  );
  assert(laterShiftIds(preview.after, dual!).length === 0, "2·3부에서 제외");
  assert(engineFrom === "2부", "클릭 2부 → effectiveFromShift=2부");
  assert(persisted?.effectiveFromShift === "2부", "persist도 2부 (1부 승격 없음)");
  const confirmed = applyLiveResultToDraft(
    createDraftFromAutoResult(previous, pool),
    preview.after
  );
  assert(
    confirmed.assignments.some(
      (row) => row.shift === "1부" && row.caddy.id === dual
    ),
    "confirmed Draft도 1부 유지"
  );
  assert(
    !confirmed.assignments.some(
      (row) => row.shift !== "1부" && row.caddy.id === dual
    ),
    "confirmed Draft에서 2부 이후 제외 — 원상복구 없음"
  );
  assert(
    spareSnap({
      ...preview.after,
      sparesByShift: confirmed.sparesByShift,
    }) === spareSnap(preview.after),
    "confirmed Draft 2부 spare는 persist after 유지"
  );
}

section("7B. 동일 투대기 1부 SICK → 종일 제외 유지");
{
  const date = "2026-08-27";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부" }),
      res(date, "A3", { teeTime: "07:16", shift: "1부" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부" }),
      res(date, "B2", { teeTime: "12:08", shift: "2부" }),
      res(date, "B3", { teeTime: "12:16", shift: "2부" }),
    ],
  });
  const dual = previous.assignments
    .filter((row) => row.kind === "regular" && row.caddy.caddyType === "HOUSE")
    .reduce<number | null>((found, row) => {
      if (found) return found;
      const other = previous.assignments.some(
        (alt) =>
          alt.caddy.id === row.caddy.id &&
          alt.shift === "2부" &&
          row.shift === "1부" &&
          alt.kind === "regular"
      );
      return other ? row.caddy.id : null;
    }, null);
  assert(!!dual, "동일 투대기 캐디 존재");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: dual!, shift: "1부" },
  });
  const engineFrom = preview.after.unavailableFromShift?.find(
    (row) => row.caddyId === dual
  )?.effectiveFromShift;
  const plan = buildLiveChangePersistPlan(preview);
  const persisted = plan.unavailables.find((row) => row.caddyId === dual);
  assert(engineFrom === "1부", "1부 클릭 → effectiveFromShift=1부");
  assert(persisted?.effectiveFromShift === "1부", "persist 종일 1부");
  assert(
    preview.after.assignments.every((row) => row.caddy.id !== dual),
    "1부 병가는 1·2·3부 모두 제외"
  );
}

section("8. 기존 정상: 종일 병가 / 빈칸 MOVE / specialSupport");
{
  const date = "2026-08-27";
  const pool = makeCaddies(8);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A1", { teeTime: "07:00", shift: "1부", course: "SKY" }),
      res(date, "A2", { teeTime: "07:08", shift: "1부", course: "SKY" }),
      res(date, "B1", { teeTime: "12:00", shift: "2부", course: "SKY" }),
    ],
  });
  const a1Id = caddyOn(previous, "A1")!;
  const allDay = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: a1Id, shift: "1부" },
  });
  assert(
    allDay.after.assignments.every((row) => row.caddy.id !== a1Id),
    "종일 병가는 모든 부에서 제외"
  );
  const moved = previewLiveAssignmentChange({
    previous: allDay.after,
    regularCaddyPool: pool,
    change: makeMoveReservationChange({
      reservationKey: reservationKey(
        allDay.after.assignments.find((row) => row.reservation.id === "B1")!
          .reservation
      ),
      to: { course: "VERTHILL", shift: "2부", teeTime: "12:00" },
    }),
  });
  assert(moved.warnings.every((w) => w.level !== "error"), "일반 빈칸 MOVE 유지");
  assert(
    moved.after.assignments.every((row) => row.caddy.id !== a1Id),
    "종일 병가 후 MOVE가 병가 캐디를 되살리지 않음"
  );
  const off = supportCaddy(90, "휴무지원");
  const supportBoard = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2)],
    reservations: [
      res(date, "S1", { teeTime: "07:00", shift: "1부" }),
      res(date, "S2", { teeTime: "07:08", shift: "1부" }),
      res(date, "S3", { teeTime: "07:16", shift: "1부" }),
    ],
    protectedTailCount: 0,
    specialSupportByShift: { ...emptySpecialSupportByShift(), "1부": [off] },
  });
  assert(
    supportBoard.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90
    ),
    "정상 specialSupport 배정 유지"
  );
  const draft = createDraftFromAutoResult(allDay.after, pool);
  const hydrated = confirmedDraftKeepingPlacedUnavailable(draft, [a1Id]);
  assert(
    (hydrated.unavailableCaddyIds || []).includes(a1Id) ||
      !hydrated.assignments.some((row) => row.caddy.id === a1Id),
    "종일 병가 hydrate overlay는 보드에 없으면 유지"
  );
}

section("C. 특수지원 저장 → stale → 재맞추기 version은 자기 autosave 이후");
{
  const queues = {
    ...emptySpecialSupportByShift(),
    "1부": [supportCaddy(90, "휴무지원")],
  };
  assert(
    isSpecialSupportDraftStale(queues, []),
    "지원 저장 후 Draft 미반영이면 stale"
  );
  const date = "2026-08-26";
  const placed = computeAutoAssignmentsV1({
    date,
    available: [house(1, 1), house(2, 2)],
    reservations: [
      res(date, "S1", { teeTime: "07:00", shift: "1부" }),
      res(date, "S2", { teeTime: "07:08", shift: "1부" }),
      res(date, "S3", { teeTime: "07:16", shift: "1부" }),
    ],
    protectedTailCount: 0,
    specialSupportByShift: queues,
  });
  assert(
    placed.assignments.some(
      (row) => row.kind === "specialSupport" && row.caddy.id === 90 && row.shift === "1부"
    ),
    "재맞추기 preview는 지원 캐디를 1부에 배치"
  );
  const draft = createDraftFromAutoResult(placed, [house(1, 1), house(2, 2)]);
  assert(
    !isSpecialSupportDraftStale(queues, draft.assignments),
    "성공한 Draft와 지원 설정이 일치하면 stale 해제"
  );

  let cachedVersion = 5;
  assert(isDraftVersionConflict(5, 6), "자기 autosave가 올린 version을 무시하면 409");
  cachedVersion = 6;
  const prep = resolveRecalcDraftSavePrep("ok", cachedVersion);
  assert(prep.ok === true, "자기 저장 drain 성공");
  assert(
    prep.ok && prep.expectedVersion === 6,
    "재맞추기 PUT expectedVersion=drain 후 6"
  );
  assert(
    prep.ok && !isDraftVersionConflict(prep.expectedVersion, cachedVersion),
    "drain 후 PUT은 자기 변경을 conflict로 오판하지 않음"
  );
  assert(
    shouldAcceptRecalcDraftQueue(true) === false,
    "재맞추기 중 구 작업본 autosave queue 차단"
  );
  assert(
    shouldAcceptDraftQueue(true) === false,
    "SICK persist 중 autosave writer 차단"
  );
  assert(
    shouldAcceptDraftQueue(false) === true,
    "exclusive writer 없으면 autosave 허용"
  );
}

section("D. genuine concurrent version은 기존 409 유지");
{
  assert(isDraftVersionConflict(6, 7), "다른 version이면 conflict");
  assert(!isDraftVersionConflict(6, 6), "같은 version이면 conflict 아님");
  const prep = resolveRecalcDraftSavePrep("conflict", 6);
  assert(prep.ok === false && prep.reason === "conflict", "flush 중 타인 기록은 conflict");
}

section("source: 2부 병가 유지 + 특수지원 pool isolation 되돌림 + recalc drain");
{
  const page = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const apply = readFileSync(
    join(process.cwd(), "src/lib/quickBoardMutationApply.ts"),
    "utf8"
  );
  const engine = readFileSync(
    join(process.cwd(), "src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const draft = readFileSync(
    join(process.cwd(), "src/lib/assignmentDraft.ts"),
    "utf8"
  );
  const change = readFileSync(
    join(process.cwd(), "src/lib/assignmentChange.ts"),
    "utf8"
  );
  assert(
    !/isSpecialSupportDraftStale\(/.test(page) &&
      !/specialSupportHydratedRef/.test(page),
    "hydrate 시 지원 설정 비교를 main처럼 하지 않음"
  );
  assert(
    !/isSpecialSupportStalePipelineBlock\(/.test(page) &&
      !/blocked: specialSettingsStale/.test(page),
    "stale로 SICK/MOVE/publish를 막지 않음"
  );
  assert(
    /prepareRecalcDraftExpectedVersion\(/.test(page) &&
      /recalcInFlightRef/.test(page) &&
      /exclusiveDraftWriterRef/.test(page) &&
      /shouldAcceptDraftQueue\(/.test(page),
    "재맞추기 drain + SICK persist writer lock"
  );
  assert(
    /overlayUnavailableKeepingShift/.test(apply) &&
      /unavailableFromShift: overlayFromShift/.test(apply),
    "quick mutation previous에 부 범위 unavailable 유지"
  );
  assert(
    !/specialSupportExcludeIds\(/.test(engine),
    "reflow regular pool에서 특수지원 강제 제외 없음"
  );
  assert(
    /assigned: draft\.assignments\.map\(\(row\) => row\.caddy\)/.test(draft),
    "snapshot assigned는 main처럼 지원 배치를 포함"
  );
  assert(
    /assigned: input\.previous\.assignments\.map\(\(row\) => row\.caddy\)/.test(
      apply
    ),
    "persist assigned는 main처럼 지원 배치를 포함"
  );
  assert(
    !/shift1 > 0 && shift2 > 0/.test(engine),
    "1·2 regular 투대기 2부 병가 1부 승격 제거 유지"
  );
  assert(
    /fromById\.get\(event\.caddyId\)/.test(change),
    "persist effectiveFromShift는 엔진 after 기준"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
