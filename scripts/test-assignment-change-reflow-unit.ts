/**
 * 현장 배치 변경 / reflow V1 단위 테스트 (DB write 없음 — memory store만)
 * 실행: npx tsx scripts/test-assignment-change-reflow-unit.ts
 */
import {
  applyLiveChangePreviewToDraft,
  applyLiveChangeToMemory,
  applyLiveAssignmentChange,
  buildLiveChangePersistPlan,
  emptyLiveChangeMemoryStore,
  isSequenceReflowLiveChange,
  liveBoardSnapshot,
  makeAddReservation,
  previewLiveAssignmentChange,
  previewLiveChangeFromDraft,
  LIVE_CHANGE_APPLY_USER_MESSAGE,
  isInstantQuickAction,
  isLiveChangeReady,
  isPatchableLiveChange,
  needsQuickActionConfirm,
  sameLiveBoard,
  shouldReconcileLivePersist,
  skipsOpsRewriteOnLivePersist,
  swapOrderToast,
} from "../src/lib/assignmentChange";
import {
  autoResultFromDraft,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
  compareReservationOrder,
  drivingCandidateCaddies,
  isPlacementLocked,
  reservationKey,
  REASON,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
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

function drivingCaddy(id = 900): AutoAssignCaddy {
  return {
    id,
    name: `드라이빙${id}`,
    team: "1조",
    teamOrder: 99,
    caddyType: "DRIVING",
    employmentStatus: "ACTIVE",
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
      teamOrder: Math.floor(i / 12) + 1,
      caddyType: "HOUSE",
    });
  }
  return out.sort(compareCaddyOrder);
}

function res(
  date: string,
  id: string,
  opts: Partial<AutoAssignReservation> & { teeTime: string; shift?: string }
): AutoAssignReservation {
  return {
    id,
    date,
    course: opts.course || "SKY",
    shift: opts.shift || "1부",
    teeTime: opts.teeTime,
    teamName: opts.teamName || id,
    rawRowIndex: opts.rawRowIndex ?? Number(id.replace(/\D/g, "") || 1),
  };
}

function caddyOn(
  result: AutoAssignResultV1,
  reservationId: string
): number | undefined {
  return result.assignments.find((a) => a.reservation.id === reservationId)
    ?.caddy.id;
}

function nameOn(
  result: AutoAssignResultV1,
  reservationId: string
): string | undefined {
  return result.assignments.find((a) => a.reservation.id === reservationId)
    ?.caddy.name;
}

function namedHouse(n = 6): AutoAssignCaddy[] {
  const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const out: AutoAssignCaddy[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      name: names[i],
      team: `${i + 1}조`,
      teamOrder: 1,
      caddyType: "HOUSE",
    });
  }
  return out;
}

function namedBoard(date: string, pool: AutoAssignCaddy[]) {
  return computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:07" }),
      res(date, "R3", { teeTime: "07:14" }),
      res(date, "R4", { teeTime: "07:21" }),
    ],
  });
}

function stampLocks(
  result: AutoAssignResultV1,
  lockedByResId: Record<string, boolean>
): AutoAssignResultV1 {
  const assignments = result.assignments.map((row) => {
    const id = String(row.reservation.id ?? "");
    if (id in lockedByResId) return { ...row, locked: lockedByResId[id] };
    return row;
  });
  return { ...result, assignments };
}

function shiftSnap(result: AutoAssignResultV1, shift: string) {
  return result.assignments
    .filter((row) => String(row.reservation.shift) === shift)
    .map((row) => ({
      id: String(row.reservation.id ?? ""),
      tee: row.reservation.teeTime,
      caddy: row.caddy.id,
      kind: row.kind,
      locked: isPlacementLocked(row),
      teamOrder: row.caddy.teamOrder,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function spareSnap(result: AutoAssignResultV1, shift: string) {
  const row = (result.sparesByShift || []).find((s) => s.shift === shift);
  return `${row?.spare1?.caddyId ?? "-"}/${row?.spare2?.caddyId ?? "-"}`;
}

function beforeTargetSnap(result: AutoAssignResultV1, target: AutoAssignReservation) {
  return result.assignments
    .filter(
      (row) =>
        String(row.reservation.shift) === "3부" &&
        compareReservationOrder(row.reservation, target) < 0
    )
    .map((row) => `${row.reservation.id}:${row.caddy.id}:${row.kind}`)
    .join("|");
}

section("방향: R2 예약취소는 B/C 밀림 (R1=A, R3=B, R4=C)");
{
  const date = "2026-10-20";
  const pool = namedHouse(6);
  const previous = namedBoard(date, pool);
  assert(nameOn(previous, "R1") === "A", "before R1=A");
  assert(nameOn(previous, "R2") === "B", "before R2=B");
  assert(nameOn(previous, "R3") === "C", "before R3=C");
  assert(nameOn(previous, "R4") === "D", "before R4=D");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R2" },
  });
  assert(nameOn(preview.after, "R2") == null, "R2 예약 삭제");
  assert(nameOn(preview.after, "R1") === "A", "R1=A 유지");
  assert(nameOn(preview.after, "R3") === "B", "R3=B 밀림");
  assert(nameOn(preview.after, "R4") === "C", "R4=C 밀림");
  assert(spareSnap(preview.after, "1부").startsWith("4/"), "D는 Spare 흐름");
  assert(preview.summary.pushedCount >= 2, "cancel pushedCount 밀림");
  assert(preview.summary.pulledCount === 0, "cancel 당김 없음");
}

section("방향: R2 팀노쇼는 취소와 동일 밀림");
{
  const date = "2026-10-20";
  const pool = namedHouse(6);
  const previous = namedBoard(date, pool);
  const cancel = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R2" },
  });
  const noshow = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "TEAM_NOSHOW", reservationId: "R2" },
  });
  assert(nameOn(noshow.after, "R1") === "A", "노쇼 R1=A");
  assert(nameOn(noshow.after, "R3") === "B", "노쇼 R3=B 밀림");
  assert(nameOn(noshow.after, "R4") === "C", "노쇼 R4=C 밀림");
  assert(
    JSON.stringify(liveBoardSnapshot(cancel.after)) ===
      JSON.stringify(liveBoardSnapshot(noshow.after)),
    "노쇼 배치 = 취소 밀림"
  );
}

section("방향: B 병가는 C/D 당김 (R1=A, R2=C, R3=D)");
{
  const date = "2026-10-20";
  const pool = namedHouse(6);
  const previous = namedBoard(date, pool);
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: 2 },
  });
  assert(preview.after.assignments.length === 4, "병가 reservation 유지");
  assert(nameOn(preview.after, "R1") === "A", "병가 R1=A");
  assert(nameOn(preview.after, "R2") === "C", "병가 R2=C 당김");
  assert(nameOn(preview.after, "R3") === "D", "병가 R3=D 당김");
  assert(
    preview.after.assignments.every((row) => row.caddy.name !== "B"),
    "B 당일 제외"
  );
  assert(preview.summary.pulledCount >= 2, "sick pulledCount 당김");
  assert(preview.summary.pushedCount === 0, "sick 밀림 없음");
}

section("방향: B 결근은 병가와 동일 당김");
{
  const date = "2026-10-20";
  const pool = namedHouse(6);
  const previous = namedBoard(date, pool);
  const sick = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: 2 },
  });
  const absent = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: 2 },
  });
  assert(nameOn(absent.after, "R2") === "C", "결근 R2=C 당김");
  assert(nameOn(absent.after, "R3") === "D", "결근 R3=D 당김");
  assert(
    JSON.stringify(liveBoardSnapshot(sick.after)) ===
      JSON.stringify(liveBoardSnapshot(absent.after)),
    "결근 배치 = 병가 당김"
  );
}

section("방향: Quick vs 고급 이름 보드 동등 (취소 밀림 / 병가 당김)");
{
  const date = "2026-10-21";
  const pool = namedHouse(6);
  const previous = namedBoard(date, pool);
  const draft = createDraftFromAutoResult(previous, pool);
  const cases: Array<{
    label: string;
    advanced: Parameters<typeof previewLiveAssignmentChange>[0]["change"];
    quick: Parameters<typeof previewLiveAssignmentChange>[0]["change"];
  }> = [
    {
      label: "cancel",
      advanced: { type: "CANCEL_RESERVATION", reservationId: "R2" },
      quick: {
        type: "CANCEL_RESERVATION",
        reservationKey: reservationKey(
          previous.assignments.find((row) => row.reservation.id === "R2")!.reservation
        ),
      },
    },
    {
      label: "noshow",
      advanced: { type: "TEAM_NOSHOW", reservationId: "R2" },
      quick: {
        type: "TEAM_NOSHOW",
        reservationKey: reservationKey(
          previous.assignments.find((row) => row.reservation.id === "R2")!.reservation
        ),
      },
    },
    {
      label: "sick",
      advanced: { type: "CADDY_SICK", caddyId: 2 },
      quick: { type: "CADDY_SICK", caddyId: 2 },
    },
    {
      label: "absent",
      advanced: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: 2 },
      quick: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: 2 },
    },
  ];
  for (const item of cases) {
    const advanced = previewLiveAssignmentChange({
      previous,
      regularCaddyPool: pool,
      change: item.advanced,
    });
    const quick = previewLiveChangeFromDraft({
      draft,
      base: previous,
      change: item.quick,
    });
    assert(sameLiveBoard(advanced.after, quick.after), `Quick=고급 ${item.label}`);
  }
}

section("LOCK 중간 포함: 취소는 LOCK 건너뛰며 밀림, 병가는 LOCK 건너뛰며 당김");
{
  const date = "2026-10-22";
  const pool = namedHouse(6);
  const previous = stampLocks(namedBoard(date, pool), { R3: true });
  assert(nameOn(previous, "R3") === "C", "LOCK C on R3");
  const cancel = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R2" },
  });
  assert(nameOn(cancel.after, "R1") === "A", "lock-cancel R1=A");
  assert(nameOn(cancel.after, "R3") === "C", "LOCK C 유지");
  assert(nameOn(cancel.after, "R4") === "B", "B는 LOCK 건너뛰고 밀림");
  assert(isPlacementLocked(cancel.after.assignments.find((a) => a.reservation.id === "R3")!), "R3 still LOCK");

  const sick = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: 2 },
  });
  assert(nameOn(sick.after, "R1") === "A", "lock-sick R1=A");
  assert(nameOn(sick.after, "R2") === "D", "D가 LOCK 건너뛰고 당김");
  assert(nameOn(sick.after, "R3") === "C", "병가도 LOCK 유지");
  assert(sick.after.assignments.length === 4, "병가 reservation 유지 with LOCK");
}

section("LOCK된 reservation 취소는 그 placement만 제거하고 다른 LOCK은 유지");
{
  const date = "2026-10-23";
  const pool = namedHouse(6);
  const previous = stampLocks(namedBoard(date, pool), { R2: true, R3: true });
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R2" },
  });
  assert(nameOn(preview.after, "R2") == null, "LOCKED R2 예약 제거");
  assert(nameOn(preview.after, "R1") === "A", "unlocked A 유지");
  assert(nameOn(preview.after, "R3") === "C", "다른 LOCK C 이동 없음");
  assert(nameOn(preview.after, "R4") === "D", "뒤 일반 밀림 없음");
  assert(
    isPlacementLocked(preview.after.assignments.find((a) => a.reservation.id === "R3")!),
    "remaining LOCK stays"
  );
}

section("중간 예약 취소 → 뒤 일반 캐디가 한 자리씩 밀림");
{
  const date = "2026-08-20";
  const pool = makeCaddies(5);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  assert(caddyOn(previous, "R1") === ordered[0].id, "before R1 = first");
  assert(caddyOn(previous, "R2") === ordered[1].id, "before R2 = second");
  assert(caddyOn(previous, "R3") === ordered[2].id, "before R3 = third");

  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R2" },
  });
  assert(preview.reason === REASON.REGULAR_CANCEL_REFLOW, "cancel reason");
  assert(caddyOn(preview.after, "R2") == null, "R2 removed");
  assert(caddyOn(preview.after, "R1") === ordered[0].id, "R1 stays first");
  assert(
    caddyOn(preview.after, "R3") === ordered[1].id,
    "R3 filled by previous R2 caddy (one slot 밀림)"
  );
  assert(
    !preview.after.assignments.some((a) => a.caddy.id === ordered[2].id),
    "third caddy unassigned"
  );
  const teamOrders = new Map(pool.map((c) => [c.id, c.teamOrder]));
  for (const row of preview.after.assignments) {
    assert(
      teamOrders.get(row.caddy.id) === row.caddy.teamOrder,
      `teamOrder unchanged for ${row.caddy.id}`
    );
  }
}

section("예약 취소와 팀 노쇼는 동일 reflow, 사유만 구분");
{
  const date = "2026-08-21";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "A", { teeTime: "07:00" }),
      res(date, "B", { teeTime: "07:08" }),
    ],
  });
  const cancel = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "A" },
  });
  const noshow = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "TEAM_NOSHOW", reservationId: "A" },
  });
  assert(cancel.reason === REASON.REGULAR_CANCEL_REFLOW, "cancel reason code");
  assert(noshow.reason === REASON.TEAM_NOSHOW_REFLOW, "noshow reason code");
  assert(
    JSON.stringify(cancel.after.assignments.map((a) => [a.reservation.id, a.caddy.id])) ===
      JSON.stringify(noshow.after.assignments.map((a) => [a.reservation.id, a.caddy.id])),
    "same reflow placements"
  );
}

section("중간 예약 당추 → 뒤 일반 캐디가 정확히 밀림");
{
  const date = "2026-08-22";
  const pool = makeCaddies(6);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  assert(caddyOn(previous, "R1") === ordered[0].id, "before R1 first");
  assert(caddyOn(previous, "R3") === ordered[1].id, "before R3 second");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ADD_RESERVATION",
      addReservation: makeAddReservation({
        date,
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
        teamName: "당추",
      }),
    },
  });
  assert(preview.reason === REASON.REGULAR_ADD_REFLOW, "add reason");
  const afterIds = preview.after.regularAssignments.map((a) => a.reservation.teeTime);
  assert(afterIds.join(",") === "07:00,07:08,07:16", "inserted in middle");
  assert(caddyOn(preview.after, "R1") === ordered[0].id, "R1 stays");
  const mid = preview.after.assignments.find((a) => a.reservation.teeTime === "07:08");
  assert(mid?.caddy.id === ordered[1].id, "previous R3 caddy shifted to new slot");
  assert(caddyOn(preview.after, "R3") === ordered[2].id, "R3 pushed to next caddy");
}

section("당추 동일 티타임/코스 중복 경고");
{
  const date = "2026-08-23";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [res(date, "R1", { teeTime: "07:00", course: "OCEAN" })],
  });
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ADD_RESERVATION",
      addReservation: makeAddReservation({
        date,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
      }),
    },
  });
  assert(
    preview.warnings.some((w) => w.code === "DUPLICATE_COURSE_TEETIME"),
    "duplicate course/tee warning"
  );
}

section("캐디 병가 → 예약 유지 + 캐디만 빠지고 뒤 순번 당김");
{
  const date = "2026-08-24";
  const pool = makeCaddies(5);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  const sickId = ordered[1].id;
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: sickId },
  });
  assert(preview.reason === REASON.CADDY_UNAVAILABLE_REFLOW, "sick reason");
  assert(caddyOn(preview.after, "R1") === ordered[0].id, "R1 stays");
  assert(caddyOn(preview.after, "R2") === ordered[2].id, "R2 filled by next caddy");
  assert(caddyOn(preview.after, "R3") === ordered[3].id, "R3 pulled");
  assert(
    preview.after.assignments.every((a) => a.caddy.id !== sickId),
    "sick caddy removed from all placements"
  );
  assert(preview.after.assignments.length === 3, "all reservations remain");
}

section("병가 캐디가 당일 다중근무면 이후 근무에서도 제외");
{
  const date = "2026-08-25";
  const pool = makeCaddies(3);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S1A", { teeTime: "07:00", shift: "1부" }),
      res(date, "S1B", { teeTime: "07:08", shift: "1부" }),
      res(date, "S2A", { teeTime: "13:00", shift: "2부" }),
      res(date, "S2B", { teeTime: "13:08", shift: "2부" }),
    ],
  });
  const dual = previous.assignments.reduce((acc, row) => {
    acc.set(row.caddy.id, (acc.get(row.caddy.id) || 0) + 1);
    return acc;
  }, new Map<number, number>());
  const dualId = [...dual.entries()].find(([, n]) => n >= 2)?.[0];
  assert(!!dualId, "found multi-shift caddy");
  const beforeCount = previous.assignments.filter((a) => a.caddy.id === dualId).length;
  assert(beforeCount >= 2, `multi-shift count ${beforeCount}`);
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: dualId },
  });
  assert(
    preview.after.assignments.every((a) => a.caddy.id !== dualId),
    "removed from every shift"
  );
  assert(
    preview.after.assignments.length === previous.assignments.length,
    "reservation count unchanged"
  );
  void ordered;
}

section("LOCK ON placement는 앞 변경에도 같은 reservation 유지");
{
  const date = "2026-08-26";
  const pool = makeCaddies(6);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = stampLocks(
    computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
        res(date, "R3", { teeTime: "07:16" }),
        res(date, "R4", { teeTime: "07:24" }),
      ],
    }),
    { R3: true }
  );
  const lockedCaddy = caddyOn(previous, "R3");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  assert(caddyOn(preview.after, "R3") === lockedCaddy, "LOCK ON stays on R3");
  assert(
    preview.lockedPreserved.some((r) => r.reservationKey.includes("R3") || r.caddy.id === lockedCaddy),
    "lockedPreserved listed"
  );
  assert(caddyOn(preview.after, "R2") === ordered[0].id, "regulars 밀림 around lock");
  assert(caddyOn(preview.after, "R4") === ordered[1].id, "after-lock slot filled by next regular");
}

section("LOCK OFF는 일반 reflow에 참여");
{
  const date = "2026-08-27";
  const pool = makeCaddies(6);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = stampLocks(
    computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
        res(date, "R3", { teeTime: "07:16" }),
      ],
    }),
    { R2: false }
  );
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  assert(caddyOn(preview.after, "R2") === ordered[0].id, "LOCK OFF participates — first remaining takes first caddy");
  assert(caddyOn(preview.after, "R3") === ordered[1].id, "second remaining takes second");
}

section("특수 LOCK ON (54홀)은 앞 캔슬에도 유지");
{
  const date = "2026-08-28";
  const pool = makeCaddies(8);
  const special: AutoAssignCaddy = {
    id: 8801,
    name: "오십사",
    team: "2조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    fiftyFourHole: [special],
    reservations: [
      res(date, "G1", { teeTime: "07:00" }),
      res(date, "G2", { teeTime: "07:08" }),
      res(date, "F1", { teeTime: "10:00", shift: "1부" }),
      res(date, "F2", { teeTime: "16:10", shift: "3부" }),
    ],
  });
  const before54 = previous.fiftyFourHoleAssignments.map((a) => ({
    res: a.reservation.id,
    caddy: a.caddy.id,
  }));
  assert(before54.length === 2, "54홀 pair assigned");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "G1" },
  });
  const after54 = preview.after.fiftyFourHoleAssignments.map((a) => ({
    res: a.reservation.id,
    caddy: a.caddy.id,
  }));
  assert(JSON.stringify(after54) === JSON.stringify(before54), "54홀 LOCK ON preserved");
  assert(
    preview.after.assignments.every((a) =>
      a.caddy.id !== special.id || isPlacementLocked(a)
    ),
    "54홀 rows remain locked by default"
  );
}

section("특수 LOCK OFF (54홀)는 일반 reflow에 참여");
{
  const date = "2026-08-29";
  const pool = makeCaddies(8);
  const special: AutoAssignCaddy = {
    id: 8802,
    name: "오십사OFF",
    team: "1조",
    teamOrder: 0,
    caddyType: "HOUSE",
  };
  const base = computeAutoAssignmentsV1({
    date,
    available: pool,
    fiftyFourHole: [special],
    reservations: [
      res(date, "G1", { teeTime: "07:00" }),
      res(date, "G2", { teeTime: "07:08" }),
      res(date, "F1", { teeTime: "10:00", shift: "1부" }),
      res(date, "F2", { teeTime: "16:10", shift: "3부" }),
    ],
  });
  const unlocked: AutoAssignResultV1 = {
    ...base,
    assignments: base.assignments.map((row) =>
      row.caddy.id === special.id ? { ...row, locked: false } : row
    ),
  };
  const preview = previewLiveAssignmentChange({
    previous: unlocked,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "G1" },
  });
  const stillOnF1 = preview.after.assignments.some(
    (a) => a.reservation.id === "F1" && a.caddy.id === special.id
  );
  assert(!stillOnF1, "LOCK OFF 54홀 caddy left original F1 slot");
  const afterSpecial = preview.after.assignments.find((a) => a.caddy.id === special.id);
  assert(!!afterSpecial, "LOCK OFF special still assigned somewhere");
  assert(afterSpecial?.kind === "fiftyFourHole", "special tag preserved");
  assert(afterSpecial?.locked === false, "stays LOCK OFF");
}

section("체인지 A↔B만 교환, 전체 reflow 없음");
{
  const date = "2026-08-30";
  const pool = makeCaddies(5);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
  const b = previous.assignments.find((x) => x.reservation.id === "R3")!;
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  assert(preview.reason === REASON.CADDY_SWAP, "swap reason");
  assert(caddyOn(preview.after, "R1") === b.caddy.id, "R1 got B");
  assert(caddyOn(preview.after, "R3") === a.caddy.id, "R3 got A");
  assert(caddyOn(preview.after, "R2") === caddyOn(previous, "R2"), "middle unchanged");
  assert(
    JSON.stringify(preview.after.sparesByShift) ===
      JSON.stringify(previous.sparesByShift),
    "spare unchanged on swap"
  );
}

section("변경 후 Spare1/2 재계산");
{
  const date = "2026-08-31";
  const pool = makeCaddies(20);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
      res(date, "R4", { teeTime: "07:24" }),
      res(date, "R5", { teeTime: "07:32" }),
    ],
  });
  const beforeSpare = previous.sparesByShift.find((s) => s.shift === "1부")!;
  assert(beforeSpare.spare1?.caddyId === ordered[5].id, "before spare1 = 6th");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  const afterSpare = preview.after.sparesByShift.find((s) => s.shift === "1부")!;
  assert(afterSpare.spare1?.caddyId === ordered[4].id, "spare1 recomputed");
  assert(afterSpare.spare2?.caddyId === ordered[5].id, "spare2 recomputed");
}

section("미리보기만 했을 때 store/DB 변경 없음");
{
  const date = "2026-09-01";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const store = emptyLiveChangeMemoryStore();
  store.caddyEmployment.set(pool[0].id, "ACTIVE");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  assert(store.reservations.length === 0, "no reservations after preview");
  assert(store.placements.length === 0, "no placements after preview");
  assert(store.changes.length === 0, "no change event after preview");
  assert(store.unavailables.length === 0, "no unavailable after preview");
  assert(store.caddyEmployment.get(pool[0].id) === "ACTIVE", "employment untouched");
  void preview;
}

section("이대로 적용 후에만 저장 + employmentStatus 불변");
{
  const date = "2026-09-02";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const store = emptyLiveChangeMemoryStore();
  for (const c of pool) store.caddyEmployment.set(c.id, "ACTIVE");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CADDY_SICK", caddyId: pool.sort(compareCaddyOrder)[0].id },
  });
  const applied = applyLiveChangeToMemory(
    store,
    buildLiveChangePersistPlan({
      ...preview,
      changeType: "CADDY_SICK",
      events: [
        {
          type: "REMOVE_CADDY",
          caddyId: [...pool].sort(compareCaddyOrder)[0].id,
          cause: "SICK",
        },
      ],
    })
  );
  assert(applied.changeId === 1, "apply ok");
  assert(store.changes.length === 1, "change event saved");
  assert(store.placements.length > 0, "placements saved");
  assert(store.reservations.length > 0, "reservations saved");
  assert(
    store.unavailables.some((u) => u.reason === "SICK"),
    "daily unavailable saved"
  );
  assert(
    [...store.caddyEmployment.values()].every((v) => v === "ACTIVE"),
    "employmentStatus not changed"
  );
}

section("적용 전 취소 = 기존 배치 유지 (preview discard)");
{
  const date = "2026-09-03";
  const pool = makeCaddies(3);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const draft = createDraftFromAutoResult(previous, pool);
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  assert(draft.assignments.length === previous.assignments.length, "draft unchanged");
  assert(
    draft.assignments[0].caddy.id === previous.assignments[0].caddy.id,
    "original first caddy kept when preview discarded"
  );
  void preview;
}

section("preview payload includes before/after caddy + lock + unassigned");
{
  const date = "2026-09-04";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  assert(preview.placementDiffs.length >= 1, "placement diffs");
  assert(typeof preview.summary.pulledCount === "number", "pulledCount");
  assert(typeof preview.summary.pushedCount === "number", "pushedCount");
  assert(Array.isArray(preview.after.sparesByShift), "new spares");
  assert(Array.isArray(preview.lockedPreserved), "locked preserved list");
}

section("리무진 ON 후 일반 reflow가 일어나도 같은 reservation에 표시 유지");
{
  const date = "2026-09-10";
  const pool = makeCaddies(5);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  const withLimo = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SET_LIMOUSINE",
      reservationKey: reservationKey(
        previous.assignments.find((a) => a.reservation.id === "R2")!.reservation
      ),
      limousineCart: true,
    },
  });
  assert(
    withLimo.after.assignments.find((a) => a.reservation.id === "R2")?.reservation
      .limousineCart === true,
    "limo ON on R2"
  );
  const afterCancel = previewLiveAssignmentChange({
    previous: withLimo.after,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "R1" },
  });
  const r2 = afterCancel.after.assignments.find((a) => a.reservation.id === "R2");
  assert(!!r2, "R2 remains after cancel R1");
  assert(r2?.reservation.limousineCart === true, "limo stays on R2 after reflow");
}

section("순번 바꿈 후에도 리무진은 reservation에 유지");
{
  const date = "2026-09-11";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:42" }),
      res(date, "R2", { teeTime: "07:49" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
  const b = previous.assignments.find((x) => x.reservation.id === "R2")!;
  const withLimo = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SET_LIMOUSINE",
      reservationKey: reservationKey(b.reservation),
      limousineCart: true,
    },
  });
  const swapped = previewLiveAssignmentChange({
    previous: withLimo.after,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  const afterA = swapped.after.assignments.find((x) => x.reservation.id === "R1")!;
  const afterB = swapped.after.assignments.find((x) => x.reservation.id === "R2")!;
  assert(afterA.caddy.id === b.caddy.id, "R1 got B");
  assert(afterB.caddy.id === a.caddy.id, "R2 got A");
  assert(afterA.reservation.limousineCart !== true, "R1 stays 일반팀");
  assert(afterB.reservation.limousineCart === true, "R2 keeps 리무진");
}

section("드라이빙은 3부 특정 reservation에 저장되고 기본 LOCK ON");
{
  const date = "2026-09-12";
  const pool = [...makeCaddies(12), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S1", { teeTime: "07:00", shift: "1부" }),
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const target = previous.assignments.find((a) => a.reservation.id === "S3B")!;
  const store = emptyLiveChangeMemoryStore();
  store.caddyTypes.set(900, "DRIVING");
  store.caddyEmployment.set(900, "ACTIVE");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: 900,
    },
  });
  const row = preview.after.assignments.find((a) => a.reservation.id === "S3B")!;
  assert(row.kind === "driving", "kind driving");
  assert(row.locked === true, "default LOCK ON");
  assert(isPlacementLocked(row), "placement locked");
  assert(row.caddy.id === 900, "assigned selected caddy");
  assert(String(row.reservation.shift) === "3부", "stays 3부");
  applyLiveChangeToMemory(store, buildLiveChangePersistPlan(preview));
  assert(store.caddyTypes.get(900) === "DRIVING", "caddyType unchanged");
  assert(store.caddyEmployment.get(900) === "ACTIVE", "employment unchanged");
  assert(
    store.placements.some((p) => p.kind === "driving" && p.locked && p.caddyId === 900),
    "driving placement persisted"
  );
}

section("1부에는 드라이빙 지정 불가");
{
  const date = "2026-09-13";
  const pool = makeCaddies(6);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [res(date, "S1", { teeTime: "07:00", shift: "1부" })],
  });
  const target = previous.assignments[0];
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: previous.unusedCaddies[0]?.id || pool[5].id,
    },
  });
  assert(
    preview.warnings.some((w) => w.code === "DRIVING_SHIFT_REQUIRED"),
    "3부 only"
  );
  assert(
    preview.after.assignments.every((a) => a.kind !== "driving"),
    "no driving applied"
  );
}

section("드라이빙 앞에서 예약 취소/당추가 발생해도 같은 reservation에 유지");
{
  const date = "2026-09-14";
  const pool = [...makeCaddies(14), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S1", { teeTime: "07:00", shift: "1부" }),
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:16", shift: "3부" }),
    ],
  });
  const target = previous.assignments.find((a) => a.reservation.id === "S3B")!;
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: 900,
    },
  });
  const afterCancel = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "S3A" },
  });
  const kept = afterCancel.after.assignments.find((a) => a.reservation.id === "S3B")!;
  assert(kept.caddy.id === 900, "driving caddy stays after 3부 cancel ahead");
  assert(kept.kind === "driving", "kind stays driving");
  const afterAdd = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: {
      type: "ADD_RESERVATION",
      addReservation: makeAddReservation({
        date,
        course: "SKY",
        shift: "3부",
        teeTime: "16:08",
        teamName: "당추",
      }),
    },
  });
  const keptAdd = afterAdd.after.assignments.find((a) => a.reservation.id === "S3B")!;
  assert(keptAdd.caddy.id === 900, "driving caddy stays after 당추 ahead");
  assert(keptAdd.kind === "driving", "kind stays driving after add");
}

section("드라이빙 삽입 후 뒤 일반 캐디가 한 자리씩 밀림");
{
  const date = "2026-09-18";
  const pool = [...makeCaddies(12), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
      res(date, "S3C", { teeTime: "16:16", shift: "3부" }),
    ],
  });
  const a = caddyOn(previous, "S3A");
  const b = caddyOn(previous, "S3B");
  const c = caddyOn(previous, "S3C");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "S3B")!.reservation
      ),
      caddyId: 900,
    },
  });
  assert(caddyOn(preview.after, "S3A") === a, "ahead regular stays");
  assert(caddyOn(preview.after, "S3B") === 900, "inserted driving at target");
  assert(
    preview.after.assignments.find((x) => x.reservation.id === "S3B")?.kind ===
      "driving",
    "target is driving"
  );
  assert(caddyOn(preview.after, "S3C") === b, "original B shifted back one");
  assert(
    preview.after.unusedCaddies.some((x) => x.id === c) ||
      preview.after.sparesByShift.some(
        (s) => s.spare1?.caddyId === c || s.spare2?.caddyId === c
      ),
    "original last regular became unused/spare"
  );
  assert(
    preview.after.assignments.filter((x) => x.caddy.id === 900).length === 1,
    "driving not also in regular rotation"
  );
}

section("일반 캔슬 reflow 후에도 unused DRIVING은 일반 순번에 안 들어감");
{
  const date = "2026-09-23";
  const pool = [...makeCaddies(8), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
    ],
  });
  assert(
    !previous.assignments.some((a) => a.caddy.id === 900),
    "auto-assign leaves DRIVING unused"
  );
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "R1")!.reservation
      ),
    },
  });
  assert(
    !preview.after.assignments.some((a) => a.caddy.id === 900),
    "reflow still excludes unused DRIVING"
  );
}

section("드라이빙 해제 시 뒤 일반이 당겨져 원래 흐름 복원");
{
  const date = "2026-09-15";
  const pool = [...makeCaddies(12), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
      res(date, "S3C", { teeTime: "16:16", shift: "3부" }),
    ],
  });
  const original = {
    a: caddyOn(previous, "S3A"),
    b: caddyOn(previous, "S3B"),
    c: caddyOn(previous, "S3C"),
  };
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "S3B")!.reservation
      ),
      caddyId: 900,
    },
  });
  const cleared = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: {
      type: "CLEAR_DRIVING",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "S3B")!.reservation
      ),
    },
  });
  assert(
    cleared.after.assignments.every((x) => x.kind !== "driving"),
    "no driving rows left"
  );
  assert(caddyOn(cleared.after, "S3A") === original.a, "S3A restored");
  assert(caddyOn(cleared.after, "S3B") === original.b, "S3B pulled original regular");
  assert(caddyOn(cleared.after, "S3C") === original.c, "S3C restored");
}

section("드라이빙 LOCK ON은 순번 바꿈 차단");
{
  const date = "2026-09-16";
  const pool = [...makeCaddies(12), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "S3A")!;
  const b = previous.assignments.find((x) => x.reservation.id === "S3B")!;
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(b.reservation),
      caddyId: 900,
    },
  });
  const swapped = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  assert(
    swapped.warnings.some((w) => w.code === "SWAP_DRIVING_LOCKED"),
    "swap blocked"
  );
  assert(
    swapped.after.assignments.find((x) => x.reservation.id === "S3B")?.caddy.id ===
      900,
    "driving placement unchanged"
  );
}

section("일반 순번 바꿈은 A↔B만 변경");
{
  const date = "2026-09-17";
  const pool = makeCaddies(5);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
  const b = previous.assignments.find((x) => x.reservation.id === "R3")!;
  const mid = caddyOn(previous, "R2");
  const swapped = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  assert(caddyOn(swapped.after, "R1") === b.caddy.id, "only A moved");
  assert(caddyOn(swapped.after, "R3") === a.caddy.id, "only B moved");
  assert(caddyOn(swapped.after, "R2") === mid, "middle unchanged");
  assert(
    isLiveChangeReady({
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    }),
    "B selected → swap is ready for auto preview"
  );
  assert(
    !isLiveChangeReady({
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
    }),
    "A only is not ready"
  );
  const store = emptyLiveChangeMemoryStore();
  previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  assert(store.placements.length === 0, "preview does not write placements");
  assert(store.reservations.length === 0, "preview does not write reservations");
}

section("드라이빙 후보는 DRIVING+ACTIVE만, 없으면 일반 캐디 대체 없음");
{
  const pool = [
    ...makeCaddies(3),
    drivingCaddy(901),
    {
      ...drivingCaddy(902),
      employmentStatus: "LEAVE",
    },
  ];
  const assigned = new Set([1]);
  const cands = drivingCandidateCaddies({
    pool,
    assignedCaddyIds: assigned,
  });
  assert(cands.length === 1 && cands[0].id === 901, "only active unused DRIVING");
  assert(
    drivingCandidateCaddies({ pool: makeCaddies(8) }).length === 0,
    "HOUSE pool yields zero driving candidates"
  );
  assert(
    drivingCandidateCaddies({
      pool: [...makeCaddies(3), drivingCaddy(903)],
      unavailableCaddyIds: [903],
    }).length === 0,
    "unavailable driving is not listed"
  );
  assert(
    drivingCandidateCaddies({
      pool: [...makeCaddies(3), drivingCaddy(901)],
      assignedCaddyIds: [901],
    }).length === 0,
    "already assigned DRIVING is not a candidate"
  );
}

section("같은 DRIVING 캐디를 다른 팀에 중복 지정하면 거부");
{
  const date = "2026-09-19";
  const pool = [...makeCaddies(8), drivingCaddy(900)];
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const first = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "S3A")!.reservation
      ),
      caddyId: 900,
    },
  });
  assert(caddyOn(first.after, "S3A") === 900, "first driving assign ok");
  const dup = previewLiveAssignmentChange({
    previous: first.after,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(
        previous.assignments.find((x) => x.reservation.id === "S3B")!.reservation
      ),
      caddyId: 900,
    },
  });
  assert(
    dup.warnings.some((w) => w.code === "DRIVING_CADDY_ALREADY_ASSIGNED"),
    "duplicate driving assign blocked"
  );
  assert(caddyOn(dup.after, "S3B") !== 900, "second team keeps regular");
}

section("SET_LOCK는 같은 자리 캐디를 유지하고 locked만 변경");
{
  const date = "2026-09-22";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const key = reservationKey(
    previous.assignments.find((x) => x.reservation.id === "R2")!.reservation
  );
  const before = caddyOn(previous, "R2");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: { type: "SET_LOCK", reservationKey: key, locked: true },
  });
  assert(caddyOn(preview.after, "R2") === before, "caddy unchanged");
  assert(
    preview.after.assignments.find((x) => x.reservation.id === "R2")?.locked ===
      true,
    "LOCK ON"
  );
  const unlocked = previewLiveAssignmentChange({
    previous: preview.after,
    regularCaddyPool: pool,
    change: { type: "SET_LOCK", reservationKey: key, locked: false },
  });
  assert(
    unlocked.after.assignments.find((x) => x.reservation.id === "R2")?.locked ===
      false,
    "LOCK OFF"
  );
}

section("일반 HOUSE를 드라이빙으로 지정하면 거부");
{
  const date = "2026-09-19";
  const pool = makeCaddies(8);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [res(date, "S3A", { teeTime: "16:00", shift: "3부" })],
  });
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(previous.assignments[0].reservation),
      caddyId: previous.unusedCaddies[0].id,
    },
  });
  assert(
    preview.warnings.some((w) => w.code === "DRIVING_TYPE_REQUIRED"),
    "HOUSE rejected"
  );
}

section("DRIVING은 3부 scoped shift만 — 1·2부와 target 이전은 불변");
{
  const date = "2026-09-24";
  const pool = [...makeCaddies(28), drivingCaddy(900)];
  const reservations = [
    res(date, "S1A", { teeTime: "07:00", shift: "1부" }),
    res(date, "S1B", { teeTime: "07:08", shift: "1부" }),
    res(date, "S1C", { teeTime: "07:16", shift: "1부" }),
    res(date, "S1D", { teeTime: "07:24", shift: "1부" }),
    res(date, "S1E", { teeTime: "07:32", shift: "1부" }),
    res(date, "S2A", { teeTime: "12:00", shift: "2부" }),
    res(date, "S2B", { teeTime: "12:08", shift: "2부" }),
    res(date, "S2C", { teeTime: "12:16", shift: "2부" }),
    res(date, "S2D", { teeTime: "12:24", shift: "2부" }),
    res(date, "S2E", { teeTime: "12:32", shift: "2부" }),
    res(date, "S3A", { teeTime: "16:53", shift: "3부" }),
    res(date, "S3B", { teeTime: "17:00", shift: "3부" }),
    res(date, "S3C", { teeTime: "17:07", shift: "3부" }),
    res(date, "S3D", { teeTime: "17:14", shift: "3부" }),
  ];
  const computed = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations,
  });
  const previous = stampLocks(computed, { S3C: true });
  const target = previous.assignments.find((x) => x.reservation.id === "S3B")!;
  const original = {
    a: caddyOn(previous, "S3A"),
    b: caddyOn(previous, "S3B"),
    c: caddyOn(previous, "S3C"),
    d: caddyOn(previous, "S3D"),
    first: JSON.stringify(shiftSnap(previous, "1부")),
    second: JSON.stringify(shiftSnap(previous, "2부")),
    beforeTarget: beforeTargetSnap(previous, target.reservation),
    spare1: spareSnap(previous, "1부"),
    spare2: spareSnap(previous, "2부"),
    spare3: spareSnap(previous, "3부"),
  };
  const assigned = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: 900,
    },
  });
  assert(
    JSON.stringify(shiftSnap(assigned.after, "1부")) === original.first,
    "DRIVING 지정 후 1부 완전 동일"
  );
  assert(
    JSON.stringify(shiftSnap(assigned.after, "2부")) === original.second,
    "DRIVING 지정 후 2부 완전 동일"
  );
  assert(
    beforeTargetSnap(assigned.after, target.reservation) === original.beforeTarget,
    "3부 target 이전 완전 동일"
  );
  assert(caddyOn(assigned.after, "S3A") === original.a, "16:53 stays");
  assert(caddyOn(assigned.after, "S3B") === 900, "17:00 driving inserted");
  assert(
    assigned.after.assignments.find((x) => x.reservation.id === "S3B")?.kind ===
      "driving",
    "target kind driving"
  );
  assert(
    assigned.after.assignments.find((x) => x.reservation.id === "S3B")?.locked ===
      true,
    "driving LOCK ON"
  );
  assert(caddyOn(assigned.after, "S3C") === original.c, "LOCK placement 유지");
  assert(
    assigned.after.assignments.find((x) => x.reservation.id === "S3C")?.locked ===
      true,
    "S3C stays locked"
  );
  assert(caddyOn(assigned.after, "S3D") === original.b, "뒤 일반만 1칸 밀림");
  assert(
    spareSnap(assigned.after, "1부") === original.spare1,
    "1부 Spare unchanged"
  );
  assert(
    spareSnap(assigned.after, "2부") === original.spare2,
    "2부 Spare unchanged"
  );
  assert(spareSnap(assigned.after, "3부") !== original.spare3, "3부 Spare만 변경");
  const thirdSpare = (assigned.after.sparesByShift || []).find((s) => s.shift === "3부");
  assert(thirdSpare?.spare1?.caddyId === original.d, "밀린 마지막 일반 → 3부 Spare1");
  const firstShiftMoved = assigned.changes.filter(
    (c) =>
      c.kind !== "unchanged" &&
      ((c.beforeReservation && String(c.beforeReservation.shift) === "1부") ||
        (c.afterReservation && String(c.afterReservation.shift) === "1부"))
  );
  assert(firstShiftMoved.length === 0, "1부 caddy moves 0");
  assert(assigned.summary.pushedCount < 10, "scoped shift is not full-day reflow");
  for (const row of assigned.after.assignments) {
    const src = pool.find((c) => c.id === row.caddy.id);
    if (src) {
      assert(src.teamOrder === row.caddy.teamOrder, `teamOrder 유지 ${row.caddy.id}`);
    }
  }

  const cleared = previewLiveAssignmentChange({
    previous: assigned.after,
    regularCaddyPool: pool,
    change: {
      type: "CLEAR_DRIVING",
      reservationKey: reservationKey(target.reservation),
    },
  });
  assert(
    JSON.stringify(shiftSnap(cleared.after, "1부")) === original.first,
    "해제 후 1부 동일"
  );
  assert(
    JSON.stringify(shiftSnap(cleared.after, "2부")) === original.second,
    "해제 후 2부 동일"
  );
  assert(caddyOn(cleared.after, "S3A") === original.a, "clear S3A");
  assert(caddyOn(cleared.after, "S3B") === original.b, "clear pulls original B");
  assert(caddyOn(cleared.after, "S3C") === original.c, "clear keeps LOCK C");
  assert(caddyOn(cleared.after, "S3D") === original.d, "clear restores D");
  assert(
    !cleared.after.assignments.some((x) => x.kind === "driving"),
    "clear removes driving"
  );
  assert(spareSnap(cleared.after, "3부") === original.spare3, "3부 Spare 복원");
  assert(spareSnap(cleared.after, "1부") === original.spare1, "clear 1부 Spare");
  assert(spareSnap(cleared.after, "2부") === original.spare2, "clear 2부 Spare");
}

section("Quick Action은 확인 대상만 confirm, 나머지는 즉시 타입");
{
  assert(isInstantQuickAction("SET_LIMOUSINE"), "limo instant");
  assert(isInstantQuickAction("SET_LOCK"), "lock instant");
  assert(isInstantQuickAction("SWAP_CADDY"), "swap instant");
  assert(isInstantQuickAction("ASSIGN_DRIVING"), "driving instant");
  assert(isInstantQuickAction("CLEAR_DRIVING"), "clear instant");
  assert(needsQuickActionConfirm("CANCEL_RESERVATION"), "cancel confirms");
  assert(needsQuickActionConfirm("TEAM_NOSHOW"), "noshow confirms");
  assert(needsQuickActionConfirm("CADDY_SICK"), "sick confirms");
  assert(needsQuickActionConfirm("CADDY_ATTENDANCE_NOSHOW"), "결근 confirms");
  assert(!needsQuickActionConfirm("SWAP_CADDY"), "swap no confirm");
  assert(
    swapOrderToast("김A", "김B") === "김A ↔ 김B 순번을 변경했습니다",
    "swap toast copy"
  );
  assert(isPatchableLiveChange("SWAP_CADDY"), "swap patches");
  assert(isPatchableLiveChange("SET_LOCK"), "lock patches");
  assert(isPatchableLiveChange("SET_LIMOUSINE"), "limo patches");
  assert(!isPatchableLiveChange("ASSIGN_DRIVING"), "driving full replace");
  assert(!isPatchableLiveChange("CANCEL_RESERVATION"), "cancel not patchable");
  assert(!isPatchableLiveChange("TEAM_NOSHOW"), "noshow not patchable");
  assert(!isPatchableLiveChange("CADDY_SICK"), "sick not patchable");
  assert(!isPatchableLiveChange("CADDY_ATTENDANCE_NOSHOW"), "결근 not patchable");
  assert(isSequenceReflowLiveChange("CANCEL_RESERVATION"), "cancel reflows");
  assert(isSequenceReflowLiveChange("TEAM_NOSHOW"), "noshow reflows");
  assert(isSequenceReflowLiveChange("CADDY_SICK"), "sick reflows");
  assert(isSequenceReflowLiveChange("CADDY_ATTENDANCE_NOSHOW"), "결근 reflows");
  assert(!isSequenceReflowLiveChange("SWAP_CADDY"), "swap is not sequence reflow");
  assert(shouldReconcileLivePersist("CANCEL_RESERVATION"), "cancel reconciles server");
  assert(!shouldReconcileLivePersist("SWAP_CADDY"), "swap keeps optimistic patch");
  assert(!shouldReconcileLivePersist("SET_LOCK"), "lock keeps optimistic patch");
  assert(!shouldReconcileLivePersist("SET_LIMOUSINE"), "limo keeps optimistic patch");
  assert(skipsOpsRewriteOnLivePersist("SET_LOCK"), "lock skips ops rewrite");
  assert(!skipsOpsRewriteOnLivePersist("SWAP_CADDY"), "swap may update ops");
}

section("optimistic persist는 적용 전 snapshot을 previous로 써야 함");
{
  const date = "2026-09-27";
  const pool = makeCaddies(4);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
  const b = previous.assignments.find((x) => x.reservation.id === "R2")!;
  const change = {
    type: "SWAP_CADDY" as const,
    reservationKeyA: reservationKey(a.reservation),
    reservationKeyB: reservationKey(b.reservation),
  };
  const first = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change,
  });
  assert(caddyOn(first.after, "R1") === b.caddy.id, "UI snapshot swapped");
  const doubled = previewLiveAssignmentChange({
    previous: first.after,
    regularCaddyPool: pool,
    change,
  });
  assert(
    caddyOn(doubled.after, "R1") === a.caddy.id,
    "sending already-swapped previous would invert"
  );
}

function persistBoardSnap(plan: ReturnType<typeof buildLiveChangePersistPlan>) {
  return JSON.stringify({
    reservations: [...plan.reservations]
      .map((row) => ({
        key: row.identityKey,
        status: row.status,
        teeTime: row.teeTime,
        shift: row.shift,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    placements: [...plan.placements]
      .map((row) => ({
        key: row.identityKey,
        caddyId: row.caddyId,
        kind: row.kind,
        locked: row.locked,
        sequenceIndex: row.sequenceIndex,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    unavailables: [...plan.unavailables]
      .map((row) => ({ caddyId: row.caddyId, reason: row.reason }))
      .sort((a, b) => a.caddyId - b.caddyId),
    spares: plan.payload.sparesByShift,
  });
}

function assertAdvancedEqualsQuick(
  label: string,
  previous: AutoAssignResultV1,
  pool: AutoAssignCaddy[],
  advancedChange: Parameters<typeof previewLiveAssignmentChange>[0]["change"],
  quickChange: Parameters<typeof previewLiveAssignmentChange>[0]["change"]
) {
  const draft = createDraftFromAutoResult(previous, pool);
  const advanced = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: advancedChange,
  });
  const quick = previewLiveChangeFromDraft({
    draft,
    base: previous,
    change: quickChange,
  });
  const quickDraft = applyLiveChangePreviewToDraft(draft, quick);
  const fromDraft = autoResultFromDraft(quickDraft, previous);
  assert(sameLiveBoard(advanced.after, quick.after), `${label} after board`);
  assert(sameLiveBoard(advanced.after, fromDraft), `${label} draft board`);
  assert(
    persistBoardSnap(buildLiveChangePersistPlan(advanced)) ===
      persistBoardSnap(buildLiveChangePersistPlan(quick)),
    `${label} persist plan`
  );
  return { advanced, quick, draft, quickDraft };
}

section("고급 배치 변경 vs Quick Action 예약 취소 동등성");
{
  const date = "2026-10-02";
  const pool = makeCaddies(8);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = stampLocks(
    computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
        res(date, "R3", { teeTime: "07:16" }),
        res(date, "R4", { teeTime: "07:24" }),
      ],
    }),
    { R3: true }
  );
  const r2 = previous.assignments.find((row) => row.reservation.id === "R2")!;
  const lockedCaddy = caddyOn(previous, "R3");
  const beforeR4 = caddyOn(previous, "R4");
  const { advanced, quickDraft } = assertAdvancedEqualsQuick(
    "cancel",
    previous,
    pool,
    { type: "CANCEL_RESERVATION", reservationId: "R2" },
    {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(r2.reservation),
    }
  );
  assert(caddyOn(advanced.after, "R2") == null, "Quick/고급 R2 제거");
  assert(caddyOn(advanced.after, "R1") === ordered[0].id, "R1 유지");
  assert(
    caddyOn(advanced.after, "R4") === ordered[1].id,
    "Quick 예약취소 뒤 일반 캐디 실제 밀림"
  );
  assert(caddyOn(advanced.after, "R4") !== beforeR4, "R4 caddy changed");
  assert(caddyOn(advanced.after, "R3") === lockedCaddy, "LOCK 유지");
  assert(
    liveBoardSnapshot(advanced.after).placements.find((row) => row.reservationId === "R3")
      ?.locked === true,
    "LOCK flag 유지"
  );
  const afterSpare = spareSnap(advanced.after, "1부");
  const beforeSpare = spareSnap(previous, "1부");
  assert(afterSpare !== beforeSpare, "Spare 재계산");
  assert(
    !quickDraft.assignments.some((row) => row.reservation.id === "R2"),
    "draft에서도 예약 제거"
  );
  assert(
    quickDraft.assignments.find((row) => row.reservation.id === "R4")?.caddy.id ===
      ordered[1].id,
    "draft에서도 밀림"
  );
}

section("고급 배치 변경 vs Quick Action 팀 노쇼 동등성");
{
  const date = "2026-10-03";
  const pool = makeCaddies(6);
  const ordered = [...pool].sort(compareCaddyOrder);
  const previous = stampLocks(
    computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "A", { teeTime: "07:00" }),
        res(date, "B", { teeTime: "07:08" }),
        res(date, "C", { teeTime: "07:16" }),
      ],
    }),
    { C: true }
  );
  const target = previous.assignments.find((row) => row.reservation.id === "A")!;
  const lockedCaddy = caddyOn(previous, "C");
  const { advanced } = assertAdvancedEqualsQuick(
    "noshow",
    previous,
    pool,
    { type: "TEAM_NOSHOW", reservationId: "A" },
    { type: "TEAM_NOSHOW", reservationKey: reservationKey(target.reservation) }
  );
  assert(caddyOn(advanced.after, "A") == null, "노쇼 예약 제거");
  assert(
    caddyOn(advanced.after, "B") === ordered[0].id,
    "Quick 팀노쇼 뒤 일반 캐디 밀림"
  );
  assert(caddyOn(advanced.after, "C") === lockedCaddy, "노쇼 LOCK 유지");
  assert(advanced.reason === REASON.TEAM_NOSHOW_REFLOW, "노쇼 사유 코드");
}

section("고급 배치 변경 vs Quick Action 병가/결근 동등성");
{
  const date = "2026-10-04";
  const pool = makeCaddies(6);
  const previous = stampLocks(
    computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00", shift: "1부" }),
        res(date, "R2", { teeTime: "07:08", shift: "1부" }),
        res(date, "R3", { teeTime: "07:16", shift: "1부" }),
        res(date, "S2A", { teeTime: "13:00", shift: "2부" }),
        res(date, "S2B", { teeTime: "13:08", shift: "2부" }),
      ],
    }),
    { R3: true }
  );
  const sickId = caddyOn(previous, "R2")!;
  const lockedCaddy = caddyOn(previous, "R3");
  const beforeCount = previous.assignments.length;
  const { advanced: sick } = assertAdvancedEqualsQuick(
    "sick",
    previous,
    pool,
    { type: "CADDY_SICK", caddyId: sickId },
    { type: "CADDY_SICK", caddyId: sickId }
  );
  assert(sick.after.assignments.length === beforeCount, "병가 reservation 유지");
  assert(
    sick.after.assignments.every((row) => row.caddy.id !== sickId),
    "병가 캐디 당일 전체 제외"
  );
  assert(caddyOn(sick.after, "R2") != null, "병가 뒤 R2 예약 유지");
  assert(caddyOn(sick.after, "R2") !== sickId, "병가 뒤 일반 당김");
  assert(caddyOn(sick.after, "R3") === lockedCaddy, "병가 LOCK 유지");

  const dualDate = "2026-10-06";
  const dualPool = makeCaddies(3);
  const dualPrevious = computeAutoAssignmentsV1({
    date: dualDate,
    available: dualPool,
    reservations: [
      res(dualDate, "S1A", { teeTime: "07:00", shift: "1부" }),
      res(dualDate, "S1B", { teeTime: "07:08", shift: "1부" }),
      res(dualDate, "S2A", { teeTime: "13:00", shift: "2부" }),
      res(dualDate, "S2B", { teeTime: "13:08", shift: "2부" }),
    ],
  });
  const dualCounts = dualPrevious.assignments.reduce((acc, row) => {
    acc.set(row.caddy.id, (acc.get(row.caddy.id) || 0) + 1);
    return acc;
  }, new Map<number, number>());
  const dualId = [...dualCounts.entries()].find(([, n]) => n >= 2)?.[0];
  assert(!!dualId, "found multi-shift caddy for 결근");
  const dualAbsent = previewLiveChangeFromDraft({
    draft: createDraftFromAutoResult(dualPrevious, dualPool),
    base: dualPrevious,
    change: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: Number(dualId) },
  });
  const advancedDual = previewLiveAssignmentChange({
    previous: dualPrevious,
    regularCaddyPool: dualPool,
    change: { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: Number(dualId) },
  });
  assert(sameLiveBoard(advancedDual.after, dualAbsent.after), "dual 결근 고급=Quick");
  assert(
    dualAbsent.after.assignments.every((row) => row.caddy.id !== dualId),
    "결근 캐디 당일 후속 근무에서도 제외"
  );
  assert(
    dualAbsent.after.assignments.length === dualPrevious.assignments.length,
    "dual 결근 reservation 유지"
  );

  const absentId = caddyOn(previous, "R1")!;
  const { advanced: absent } = assertAdvancedEqualsQuick(
    "absent",
    previous,
    pool,
    { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: absentId },
    { type: "CADDY_ATTENDANCE_NOSHOW", caddyId: absentId }
  );
  assert(absent.after.assignments.length === beforeCount, "결근 reservation 유지");
  assert(
    absent.after.assignments.every((row) => row.caddy.id !== absentId),
    "결근 캐디 당일 후속 근무에서도 제외"
  );
  assert(caddyOn(absent.after, "R3") === lockedCaddy, "결근 LOCK 유지");
}

section("Quick swap/리무진/LOCK 적용은 memory store에 즉시 기록");
{
  const date = "2026-09-25";
  const pool = makeCaddies(5);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "R1", { teeTime: "07:00" }),
      res(date, "R2", { teeTime: "07:08" }),
      res(date, "R3", { teeTime: "07:16" }),
    ],
  });
  const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
  const b = previous.assignments.find((x) => x.reservation.id === "R3")!;
  const swapStore = emptyLiveChangeMemoryStore();
  previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a.reservation),
      reservationKeyB: reservationKey(b.reservation),
    },
  });
  assert(swapStore.placements.length === 0, "preview still does not write");
}

async function runPersistTests() {
  section("Quick swap/리무진/LOCK/확인형 변경 apply는 memory DB write");
  {
    const date = "2026-09-26";
    const pool = makeCaddies(6);
    const previous = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
        res(date, "R3", { teeTime: "07:16" }),
      ],
    });
    const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
    const b = previous.assignments.find((x) => x.reservation.id === "R3")!;
    const swapStore = emptyLiveChangeMemoryStore();
    const swapped = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "SWAP_CADDY",
          reservationKeyA: reservationKey(a.reservation),
          reservationKeyB: reservationKey(b.reservation),
        },
      },
      { memory: swapStore }
    );
    assert(swapped.ok === true, "swap apply ok");
    assert(swapStore.placements.length === previous.assignments.length, "swap wrote placements");
    assert(swapStore.changes.some((c) => c.changeType === "SWAP_CADDY"), "swap change row");
    const swapA = swapStore.placements.find(
      (p) => p.identityKey === reservationKey(a.reservation)
    );
    const swapB = swapStore.placements.find(
      (p) => p.identityKey === reservationKey(b.reservation)
    );
    assert(swapA?.caddyId === b.caddy.id, "swap A got B");
    assert(swapB?.caddyId === a.caddy.id, "swap B got A");

    const limoStore = emptyLiveChangeMemoryStore();
    const limo = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "SET_LIMOUSINE",
          reservationKey: reservationKey(a.reservation),
          limousineCart: true,
        },
      },
      { memory: limoStore }
    );
    assert(limo.ok === true, "limo apply ok");
    assert(
      limoStore.reservations.some(
        (r) => r.identityKey === reservationKey(a.reservation) && r.limousineCart
      ),
      "limo flag persisted"
    );

    const lockStore = emptyLiveChangeMemoryStore();
    const locked = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "SET_LOCK",
          reservationKey: reservationKey(b.reservation),
          locked: true,
        },
      },
      { memory: lockStore }
    );
    assert(locked.ok === true, "lock apply ok");
    assert(
      lockStore.placements.some(
        (p) => p.identityKey === reservationKey(b.reservation) && p.locked
      ),
      "lock persisted"
    );

    const cancelStore = emptyLiveChangeMemoryStore();
    const cancelled = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "CANCEL_RESERVATION",
          reservationKey: reservationKey(a.reservation),
        },
      },
      { memory: cancelStore }
    );
    assert(cancelled.ok === true, "cancel apply ok after confirm-path compute");
    assert(
      cancelStore.reservations.some(
        (r) =>
          r.identityKey === reservationKey(a.reservation) && r.status === "CANCELLED"
      ),
      "cancel status persisted"
    );
    const remainingR3 = previous.assignments.find((x) => x.reservation.id === "R3")!;
    const pulled = cancelStore.placements.find(
      (p) => p.identityKey === reservationKey(remainingR3.reservation)
    );
    assert(
      pulled?.caddyId === previous.assignments.find((x) => x.reservation.id === "R2")?.caddy.id,
      "cancel persist 밀림 next regular onto R3"
    );

    const sickStore = emptyLiveChangeMemoryStore();
    const sick = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: { type: "CADDY_SICK", caddyId: b.caddy.id },
      },
      { memory: sickStore }
    );
    assert(sick.ok === true, "sick apply ok");
    assert(
      sickStore.unavailables.some(
        (u) => u.caddyId === b.caddy.id && u.reason === "SICK"
      ),
      "sick unavailable persisted"
    );
  }

  section("기존 Daily row가 있으면 swap/lock/limo는 patch만");
  {
    const date = "2026-09-28";
    const pool = makeCaddies(4);
    const previous = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
      ],
    });
    const a = previous.assignments.find((x) => x.reservation.id === "R1")!;
    const b = previous.assignments.find((x) => x.reservation.id === "R2")!;
    const keyA = reservationKey(a.reservation);
    const keyB = reservationKey(b.reservation);
    const counts = {
      reservationDelete: 0,
      placementDelete: 0,
      reservationCreateMany: 0,
      placementUpdate: 0,
      reservationUpdate: 0,
    };
    const fakeTx = {
      dailyReservation: {
        count: async () => 2,
        findUnique: async (args: {
          where: { date_identityKey: { identityKey: string } };
        }) => {
          const key = args.where.date_identityKey.identityKey;
          if (key === keyA) return { id: 11 };
          if (key === keyB) return { id: 12 };
          return null;
        },
        deleteMany: async () => {
          counts.reservationDelete += 1;
          return { count: 0 };
        },
        createManyAndReturn: async (args: { data: unknown[] }) => {
          counts.reservationCreateMany += args.data.length;
          return [];
        },
        update: async () => {
          counts.reservationUpdate += 1;
          return { id: 11 };
        },
      },
      dailyPlacement: {
        deleteMany: async () => {
          counts.placementDelete += 1;
          return { count: 0 };
        },
        createMany: async () => ({ count: 0 }),
        update: async () => {
          counts.placementUpdate += 1;
          return { id: 1 };
        },
      },
      dailyCaddyUnavailable: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      dailyAssignmentChange: {
        create: async () => ({ id: 1 }),
      },
      audit: { create: async () => ({ id: 1 }) },
      shiftDuty: { count: async () => 0 },
      schedule: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
      scheduleExtraTag: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
    };
    const fakePrisma = {
      $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
        fn(fakeTx),
    };
    const swapped = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "SWAP_CADDY",
          reservationKeyA: keyA,
          reservationKeyB: keyB,
        },
      },
      { prisma: fakePrisma as never }
    );
    assert(swapped.ok === true, "swap patch ok");
    assert(counts.reservationDelete === 0, "swap did not delete reservations");
    assert(counts.placementDelete === 0, "swap did not delete placements");
    assert(counts.reservationCreateMany === 0, "swap did not recreate day");
    assert(counts.placementUpdate === 2, "swap updated two placements");
  }

  section("기존 Daily row가 있어도 예약취소는 patch하지 않고 reflow rewrite");
  {
    const date = "2026-10-05";
    const pool = makeCaddies(4);
    const previous = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [
        res(date, "R1", { teeTime: "07:00" }),
        res(date, "R2", { teeTime: "07:08" }),
        res(date, "R3", { teeTime: "07:16" }),
      ],
    });
    const counts = {
      reservationDelete: 0,
      placementDelete: 0,
      reservationCreateMany: 0,
      placementUpdate: 0,
    };
    const fakeTx = {
      dailyReservation: {
        count: async () => 3,
        findUnique: async () => ({ id: 1 }),
        deleteMany: async () => {
          counts.reservationDelete += 1;
          return { count: 3 };
        },
        update: async () => {
          throw new Error("cancel must not patch reservation");
        },
        createManyAndReturn: async (args: { data: unknown[] }) => {
          counts.reservationCreateMany += args.data.length;
          return (args.data as Array<{ identityKey: string }>).map((row, i) => ({
            id: i + 1,
            identityKey: row.identityKey,
          }));
        },
      },
      dailyPlacement: {
        deleteMany: async () => {
          counts.placementDelete += 1;
          return { count: 3 };
        },
        update: async () => {
          counts.placementUpdate += 1;
          throw new Error("cancel must not patch placement");
        },
        createMany: async () => ({ count: 2 }),
      },
      dailyCaddyUnavailable: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      dailyAssignmentChange: { create: async () => ({ id: 1 }) },
      audit: { create: async () => ({ id: 1 }) },
      shiftDuty: { count: async () => 0 },
    };
    const fakePrisma = {
      $transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
        fn(fakeTx),
    };
    const result = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "CANCEL_RESERVATION",
          reservationKey: reservationKey(previous.assignments[0].reservation),
        },
      },
      { prisma: fakePrisma as never, updateOpsIfPresent: false }
    );
    assert(result.ok === true, "cancel rewrite ok");
    assert(counts.placementUpdate === 0, "cancel did not patch placements");
    assert(counts.reservationDelete === 1, "cancel rewrote reservations");
    assert(counts.placementDelete === 1, "cancel rewrote placements");
    assert(counts.reservationCreateMany >= 3, "cancel rewrote reservation rows");
    assert(caddyOn(result.ok ? result.preview.after : previous, "R2") === caddyOn(previous, "R1"), "rewrite still 밀림");
  }

  section("250건 Reservation 저장은 createMany, 개별 create 없음");
  {
    const date = "2026-09-20";
    const pool = makeCaddies(8);
    const reservations = Array.from({ length: 250 }, (_, i) =>
      res(date, `R${i + 1}`, {
        teeTime: `${String(7 + Math.floor(i / 12)).padStart(2, "0")}:${String(
          (i % 12) * 5
        ).padStart(2, "0")}`,
        shift: "1부",
        course: "SKY",
      })
    );
    const previous = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations,
    });
    const counts = {
      reservationCreate: 0,
      reservationCreateMany: 0,
      placementCreate: 0,
      placementCreateMany: 0,
      txCalls: 0,
    };
    const fakeTx = {
      dailyPlacement: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => {
          counts.placementCreate += 1;
          if (counts.placementCreate > 20) {
            throw new Error(
              "Transaction not found. Transaction ID is invalid, refers to an old closed transaction"
            );
          }
          return { id: counts.placementCreate };
        },
        createMany: async (args: { data: unknown[] }) => {
          counts.placementCreateMany += args.data.length;
          return { count: args.data.length };
        },
      },
      dailyReservation: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => {
          counts.reservationCreate += 1;
          if (counts.reservationCreate > 20) {
            throw new Error(
              "Transaction not found. Transaction ID is invalid, refers to an old closed transaction"
            );
          }
          return { id: counts.reservationCreate };
        },
        createMany: async (args: { data: unknown[] }) => {
          counts.reservationCreateMany += args.data.length;
          return { count: args.data.length };
        },
        createManyAndReturn: async (args: { data: unknown[] }) => {
          counts.reservationCreateMany += args.data.length;
          return (args.data as Array<{ identityKey: string }>).map((row, i) => ({
            id: i + 1,
            identityKey: row.identityKey,
          }));
        },
        findMany: async () => {
          throw new Error("findMany should not be used after createManyAndReturn");
        },
      },
      dailyCaddyUnavailable: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
        upsert: async () => {
          throw new Error("unavailable upsert should be batched");
        },
      },
      dailyAssignmentChange: {
        create: async () => ({ id: 1 }),
      },
      audit: {
        create: async () => ({ id: 1 }),
      },
      shiftDuty: {
        count: async () => 0,
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      schedule: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      scheduleExtraTag: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
    };
    const fakePrisma = {
      $transaction: async (
        fn: (tx: typeof fakeTx) => Promise<unknown>,
        _opts?: unknown
      ) => {
        counts.txCalls += 1;
        return fn(fakeTx);
      },
    };
    const result = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "CANCEL_RESERVATION",
          reservationKey: reservationKey(previous.assignments[0].reservation),
        },
      },
      { prisma: fakePrisma as never, updateOpsIfPresent: false }
    );
    assert(result.ok === true, "250-row apply succeeds");
    assert(counts.reservationCreate === 0, "no per-row reservation.create");
    assert(counts.placementCreate === 0, "no per-row placement.create");
    assert(counts.reservationCreateMany >= 200, "reservations batched");
    assert(counts.txCalls === 1, "single short transaction");
  }

  section("저장 실패 시 Prisma 원문을 사용자 메시지에 넣지 않음");
  {
    const date = "2026-09-21";
    const pool = makeCaddies(4);
    const previous = computeAutoAssignmentsV1({
      date,
      available: pool,
      reservations: [res(date, "R1", { teeTime: "07:00" })],
    });
    const fakePrisma = {
      $transaction: async () => {
        throw new Error(
          "Invalid prisma.dailyReservation.create() invocation Transaction API error: Transaction not found"
        );
      },
    };
    const result = await applyLiveAssignmentChange(
      {
        previous,
        regularCaddyPool: pool,
        change: {
          type: "CANCEL_RESERVATION",
          reservationKey: reservationKey(previous.assignments[0].reservation),
        },
      },
      { prisma: fakePrisma as never }
    );
    assert(result.ok === false, "apply failed");
    assert(
      result.ok === false && result.message === LIVE_CHANGE_APPLY_USER_MESSAGE,
      "user-safe message"
    );
    assert(
      result.ok === false && !result.message.includes("Transaction not found"),
      "no prisma stack in user message"
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void runPersistTests();
