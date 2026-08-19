/**
 * 현장 배치 변경 / reflow V1 단위 테스트 (DB write 없음 — memory store만)
 * 실행: npx tsx scripts/test-assignment-change-reflow-unit.ts
 */
import {
  applyLiveChangeToMemory,
  buildLiveChangePersistPlan,
  emptyLiveChangeMemoryStore,
  makeAddReservation,
  previewLiveAssignmentChange,
} from "../src/lib/assignmentChange";
import { createDraftFromAutoResult } from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  compareCaddyOrder,
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

section("중간 예약 취소 → 뒤 일반 캐디가 한 자리씩 당겨짐");
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
    "R3 filled by previous R2 caddy (one slot pull)"
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
  assert(caddyOn(preview.after, "R2") === ordered[0].id, "regulars pull around lock");
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
  const pool = makeCaddies(12);
  for (const c of pool) (c as AutoAssignCaddy).caddyType = "HOUSE";
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
  const free = previous.unusedCaddies[0];
  assert(!!free, "unused caddy exists");
  const store = emptyLiveChangeMemoryStore();
  store.caddyTypes.set(free.id, "HOUSE");
  store.caddyEmployment.set(free.id, "ACTIVE");
  const preview = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: free.id,
    },
  });
  const row = preview.after.assignments.find((a) => a.reservation.id === "S3B")!;
  assert(row.kind === "driving", "kind driving");
  assert(row.locked === true, "default LOCK ON");
  assert(isPlacementLocked(row), "placement locked");
  assert(row.caddy.id === free.id, "assigned selected caddy");
  assert(String(row.reservation.shift) === "3부", "stays 3부");
  applyLiveChangeToMemory(store, buildLiveChangePersistPlan(preview));
  assert(store.caddyTypes.get(free.id) === "HOUSE", "caddyType unchanged");
  assert(store.caddyEmployment.get(free.id) === "ACTIVE", "employment unchanged");
  assert(
    store.placements.some((p) => p.kind === "driving" && p.locked && p.caddyId === free.id),
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
  const pool = makeCaddies(14);
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
  const free = previous.unusedCaddies[0];
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: free.id,
    },
  });
  const afterCancel = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: { type: "CANCEL_RESERVATION", reservationId: "S3A" },
  });
  const kept = afterCancel.after.assignments.find((a) => a.reservation.id === "S3B")!;
  assert(kept.caddy.id === free.id, "driving caddy stays after 3부 cancel ahead");
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
  assert(keptAdd.caddy.id === free.id, "driving caddy stays after 당추 ahead");
  assert(keptAdd.kind === "driving", "kind stays driving after add");
}

section("드라이빙 해제 정상");
{
  const date = "2026-09-15";
  const pool = makeCaddies(12);
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    reservations: [
      res(date, "S3A", { teeTime: "16:00", shift: "3부" }),
      res(date, "S3B", { teeTime: "16:08", shift: "3부" }),
    ],
  });
  const target = previous.assignments.find((a) => a.reservation.id === "S3B")!;
  const free = previous.unusedCaddies[0];
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(target.reservation),
      caddyId: free.id,
    },
  });
  const cleared = previewLiveAssignmentChange({
    previous: driving.after,
    regularCaddyPool: pool,
    change: {
      type: "CLEAR_DRIVING",
      reservationKey: reservationKey(target.reservation),
    },
  });
  assert(
    !cleared.after.assignments.some((a) => a.reservation.id === "S3B"),
    "driving placement removed"
  );
  assert(
    cleared.after.unassignedReservations.some((u) => u.reservation.id === "S3B"),
    "reservation remains unassigned"
  );
  assert(
    cleared.after.assignments.every((a) => a.kind !== "driving"),
    "no driving rows left"
  );
}

section("드라이빙 LOCK ON은 순번 바꿈 차단");
{
  const date = "2026-09-16";
  const pool = makeCaddies(12);
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
  const free = previous.unusedCaddies[0];
  const driving = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "ASSIGN_DRIVING",
      reservationKey: reservationKey(b.reservation),
      caddyId: free.id,
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
      free.id,
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
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
