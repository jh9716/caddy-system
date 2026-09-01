/**
 * Local-only Board Mutation Pipeline persist tests.
 * caddy_local only. Production DB forbidden.
 */
import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  computeAutoAssignmentsV1,
  reservationKey,
  type AutoAssignCaddy,
} from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  autoResultFromDraft,
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import {
  getDailyBoardDraft,
  saveDailyBoardDraft,
} from "../src/lib/dailyBoardDraftService";
import {
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
} from "../src/lib/assignmentChange";
import { applyQuickBoardMutation } from "../src/lib/quickBoardMutationApply";
import {
  prepareIntentOnConfirmedDraft,
  projectPendingIntents,
  makeMutationIntent,
} from "../src/lib/boardMutationPipeline";
import { QUICK_MOVE_LIVE_FORCE_FAIL } from "../src/lib/quickReservationMoveApply";
import { buildOffSnapshot, isUsableOffSnapshot } from "../src/lib/offSnapshot";

function withOffSnapshot(draft: AssignmentDraft): AssignmentDraft {
  if (isUsableOffSnapshot(draft.offSnapshot, draft.date)) return draft;
  return {
    ...draft,
    offSnapshot: buildOffSnapshot({ date: draft.date, caddyIds: [] }),
  };
}

const DATE = "2099-12-21";
const day = parseYmd(DATE).start;
const HOUSE_START = 13; // 서승희
const RESET_TRAP = 1; // 이영진 — 1조 첫 캐디
const PULL = 19; // 김하나1

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

async function persistLiveFromDraft(draft: AssignmentDraft) {
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
  for (const row of draft.assignments) {
    const created = await prisma.dailyReservation.create({
      data: {
        date: day,
        course: row.reservation.course,
        shift: String(row.shift || row.reservation.shift),
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName ?? null,
        identityKey: reservationKey(row.reservation),
        source: row.reservation.sourceSheet ?? null,
        rawRowIndex: row.reservation.rawRowIndex ?? null,
        status: "ACTIVE",
      },
    });
    await prisma.dailyPlacement.create({
      data: {
        date: day,
        reservationId: created.id,
        caddyId: row.caddy.id,
        kind: row.kind,
        sequenceIndex: row.sequenceIndex,
        pairId: row.pairId ?? null,
        locked: false,
      },
    });
  }
  const saved = await saveDailyBoardDraft({
    date: DATE,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(withOffSnapshot(draft)),
    updatedByUserId: null,
  });
  return saved.version;
}

async function seed() {
  const wanted = [RESET_TRAP, HOUSE_START, PULL, 20, 21, 22, 23, 14, 15];
  const caddies = await prisma.caddy.findMany({
    where: { id: { in: wanted }, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  });
  const byId = new Map(caddies.map((c) => [c.id, c]));
  const order = new Map(wanted.map((id, i) => [id, i]));
  const pool: AutoAssignCaddy[] = wanted
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({
      id: c.id,
      name: c.name,
      team: `${order.get(c.id) ?? c.teamOrder}조`,
      teamOrder: order.get(c.id) ?? c.teamOrder,
      caddyType: String(c.caddyType),
      employmentStatus: String(c.employmentStatus),
    }));
  if (pool.length < 6) throw new Error(`need fixture HOUSE caddies, got ${pool.length}`);
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: HOUSE_START,
    reservations: [
      { date: DATE, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "A팀", rawRowIndex: 1, sourceSheet: "예약1부" },
      { id: "db-b", date: DATE, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "B팀", rawRowIndex: 2, sourceSheet: "예약1부" },
      { date: DATE, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "C팀", rawRowIndex: 3, sourceSheet: "예약1부" },
      { date: DATE, course: "VERTHILL", shift: "1부", teeTime: "07:08", teamName: "D팀", rawRowIndex: 4, sourceSheet: "예약1부" },
    ],
  });
  const draft = createDraftFromAutoResult(result, pool);
  const version = await persistLiveFromDraft(draft);
  return { draft, pool, version, result };
}

async function reloadDraft() {
  const row = await getDailyBoardDraft(DATE);
  if (!row) throw new Error("draft missing");
  return { version: row.version, draft: payloadToAssignmentDraft(row.payload) };
}

function names(draft: AssignmentDraft) {
  return draft.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((a) => a.caddy.name);
}

async function applyIntent(
  confirmed: AssignmentDraft,
  change: Parameters<typeof makeMutationIntent>[0],
  version: number,
  testFailLive?: "error" | null,
  testDelayMs?: number
) {
  const intent = makeMutationIntent(change, `t-${Date.now()}-${Math.random()}`)!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent,
  });
  if (!prepared.ok) return { prepared, persist: null as null };
  const persist = await applyQuickBoardMutation({
    previous: prepared.previous,
    regularCaddyPool: confirmed.caddyPool,
    events: prepared.preview.events,
    changeType: prepared.preview.changeType,
    change,
    draft: {
      date: DATE,
      expectedVersion: version,
      payload: assignmentDraftToPayload(withOffSnapshot(prepared.painted)),
    },
    updatedByUserId: null,
    testFailLive: testFailLive ?? null,
    testDelayMs: testDelayMs ?? 0,
  });
  return { prepared, persist };
}

async function main() {
  section("seed");
  let { draft, version } = await seed();
  assert(draft.houseStartCaddyId === HOUSE_START, "seed stores 서승희 house start");
  assert(names(draft)[0] === "서승희", "first slot 서승희");
  assert(names(draft)[1] === "김하나1", "second slot 김하나1");

  section("SICK then reload");
  {
    const beforeSpare = draft.sparesByShift.find((s) => s.shift === "1부");
    const r = await applyIntent(draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version);
    assert(r.persist?.ok === true, "sick atomic 200");
    if (r.persist && r.persist.ok) {
      version = r.persist.draft.version;
      draft = applyLiveResultToDraft(r.prepared.ok ? r.prepared.painted : draft, r.persist.preview.after);
    }
    const reloaded = await reloadDraft();
    assert(reloaded.version === version, "version monotonic after sick");
    assert(reloaded.draft.houseStartCaddyId === HOUSE_START, "reload keeps 서승희 start");
    assert(names(reloaded.draft)[0] === "김하나1", "reload: 김하나1 pulled forward");
    assert(!names(reloaded.draft).includes("서승희"), "reload: 서승희 gone");
    assert(!names(reloaded.draft).includes("이영진"), "reload: 1조 first not revived as start");
    const unavail = await prisma.dailyCaddyUnavailable.findMany({ where: { date: day } });
    assert(unavail.some((u) => u.caddyId === HOUSE_START), "unavailable written");
    const afterSpare = reloaded.draft.sparesByShift.find((s) => s.shift === "1부");
    assert(Boolean(afterSpare?.spare1), "spare1 still assigned after pull-forward");
    assert(
      !afterSpare?.spare1 || afterSpare.spare1.caddyId !== HOUSE_START,
      "sick caddy is not spare1"
    );
    assert(
      !beforeSpare ||
        afterSpare?.spare1?.caddyId !== beforeSpare.spare1?.caddyId ||
        afterSpare?.spare2?.caddyId !== beforeSpare.spare2?.caddyId,
      "spare queue recomputed"
    );
    draft = reloaded.draft;
  }

  section("SICK → MOVE");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const sick = await applyIntent(draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version);
    assert(sick.persist?.ok === true, "leading sick 200");
    if (!sick.persist || !sick.persist.ok || !sick.prepared.ok) throw new Error("sick");
    version = sick.persist.draft.version;
    const confirmed = applyLiveResultToDraft(sick.prepared.painted, sick.persist.preview.after);
    const a = confirmed.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await applyIntent(
      confirmed,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        reservationId: a.reservation.id,
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      version
    );
    assert(move.persist?.ok === true, "MOVE after sick 200");
    const reloaded = await reloadDraft();
    const aRow = reloaded.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept after sick");
    assert(!names(reloaded.draft).includes("서승희"), "sick still applied");
    assert(reloaded.version === version + 1, "version 1→2→3 style bump");
  }

  section("MOVE → SICK");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const a = draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await applyIntent(
      draft,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      version
    );
    assert(move.persist?.ok === true, "leading MOVE 200");
    if (!move.persist || !move.persist.ok || !move.prepared.ok) throw new Error("move");
    version = move.persist.draft.version;
    const confirmed = applyLiveResultToDraft(move.prepared.painted, move.persist.preview.after);
    const sick = await applyIntent(confirmed, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version);
    assert(sick.persist?.ok === true, "SICK after MOVE 200");
    const reloaded = await reloadDraft();
    const aRow = reloaded.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept");
    assert(names(reloaded.draft)[0] === "김하나1" || !names(reloaded.draft).includes("서승희"), "SICK applied on moved board");
    assert(!names(reloaded.draft).includes("서승희"), "서승희 not revived");
  }

  section("SICK → SICK");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const first = await applyIntent(draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version);
    assert(first.persist?.ok === true, "first sick 200");
    if (!first.persist || !first.persist.ok || !first.prepared.ok) throw new Error("s1");
    version = first.persist.draft.version;
    const confirmed = applyLiveResultToDraft(first.prepared.painted, first.persist.preview.after);
    const second = await applyIntent(confirmed, {
      type: "CADDY_SICK",
      caddyId: PULL,
      shift: "1부",
    }, version);
    assert(second.persist?.ok === true, "second sick 200 on latest queue");
    const reloaded = await reloadDraft();
    assert(!names(reloaded.draft).includes("서승희"), "first sick stays gone");
    assert(!names(reloaded.draft).includes("김하나1"), "second sick pulled next");
    assert(!names(reloaded.draft).includes("이영진") || names(reloaded.draft)[0] !== "이영진", "not reset to 1조 first unless she is next after both");
  }

  section("MOVE fail then SICK");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const a = draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await applyIntent(
      draft,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      version,
      "error"
    );
    assert(move.persist?.ok === false, "MOVE forced fail");
    assert(move.persist && !move.persist.ok && move.persist.code === QUICK_MOVE_LIVE_FORCE_FAIL, "live fail code");
    const afterFail = await reloadDraft();
    const aRow = afterFail.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "SKY", "failed MOVE not written");
    const sick = await applyIntent(afterFail.draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, afterFail.version);
    assert(sick.persist?.ok === true, "SICK still runs on confirmed");
    const reloaded = await reloadDraft();
    assert(!names(reloaded.draft).includes("서승희"), "SICK applied after MOVE fail");
    const aKeep = reloaded.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aKeep?.reservation.course === "SKY", "MOVE did not apply");
  }

  section("SICK fail then MOVE");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const sick = await applyIntent(draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version, "error");
    assert(sick.persist?.ok === false, "SICK forced fail");
    const afterFail = await reloadDraft();
    assert(names(afterFail.draft)[0] === "서승희", "failed SICK not written");
    const a = afterFail.draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await applyIntent(
      afterFail.draft,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      afterFail.version
    );
    assert(move.persist?.ok === true, "MOVE after SICK fail 200");
    const reloaded = await reloadDraft();
    const aRow = reloaded.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept");
    assert(names(reloaded.draft).includes("서승희"), "SICK did not apply");
  }

  section("id/uid mix + dest collision");
  {
    const seeded = await seed();
    draft = seeded.draft;
    version = seeded.version;
    const sick = await applyIntent(draft, {
      type: "CADDY_SICK",
      caddyId: HOUSE_START,
      shift: "1부",
    }, version);
    if (!sick.persist || !sick.persist.ok || !sick.prepared.ok) throw new Error("sick");
    version = sick.persist.draft.version;
    const confirmed = applyLiveResultToDraft(sick.prepared.painted, sick.persist.preview.after);
    const b = confirmed.assignments.find((x) => x.reservation.teamName === "B팀")!;
    const occupied = await applyIntent(
      confirmed,
      makeMoveReservationChange({
        reservationKey: reservationKey(b.reservation),
        reservationId: b.reservation.id,
        to: { course: confirmed.assignments.find((x) => x.reservation.teamName === "A팀")!.reservation.course, shift: "1부", teeTime: confirmed.assignments.find((x) => x.reservation.teamName === "A팀")!.reservation.teeTime },
      }),
      version
    );
    assert(
      occupied.prepared.ok === false || occupied.persist?.ok === false,
      "occupied dest blocked"
    );
    const reloaded = await reloadDraft();
    assert(!names(reloaded.draft).includes("서승희"), "sick kept after blocked MOVE");
  }

  section("stale paint is not persist source");
  {
    const seeded = await seed();
    const a = seeded.draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const moveChange = makeMoveReservationChange({
      reservationKey: reservationKey(a.reservation),
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    });
    const stale = projectPendingIntents({
      confirmedDraft: seeded.draft,
      pending: [
        makeMutationIntent(moveChange, "p1")!,
        makeMutationIntent(
          { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
          "p2"
        )!,
      ],
    });
    const move = await applyIntent(seeded.draft, moveChange, seeded.version);
    assert(move.persist?.ok === true, "MOVE 200 while SICK was already painted");
    if (!move.persist || !move.persist.ok || !move.prepared.ok) throw new Error("move");
    const confirmed = applyLiveResultToDraft(
      move.prepared.painted,
      move.persist.preview.after
    );
    const sickPrepared = prepareIntentOnConfirmedDraft({
      confirmedDraft: confirmed,
      intent: makeMutationIntent(
        { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
        "p2"
      )!,
    });
    assert(sickPrepared.ok === true, "SICK recomputes on latest confirmed");
    assert(
      sickPrepared.ok &&
        sickPrepared.painted.assignments[0]?.reservation.course ===
          confirmed.assignments[0]?.reservation.course,
      "recompute uses moved board, not stale snapshot"
    );
    assert(stale.draft.assignments.length > 0, "stale paint existed but is unused");
    if (sickPrepared.ok) {
      const persist = await applyQuickBoardMutation({
        previous: sickPrepared.previous,
        regularCaddyPool: confirmed.caddyPool,
        events: sickPrepared.preview.events,
        changeType: sickPrepared.preview.changeType,
        change: { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
        draft: {
          date: DATE,
          expectedVersion: move.persist.draft.version,
          payload: assignmentDraftToPayload(withOffSnapshot(sickPrepared.painted)),
        },
        updatedByUserId: null,
      });
      assert(persist.ok === true, "SICK 200 after MOVE on recomputed draft");
    }
    const reloaded = await reloadDraft();
    const aRow = reloaded.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept after delayed SICK");
    assert(!names(reloaded.draft).includes("서승희"), "서승희 not revived");
    assert(names(reloaded.draft)[0] === "김하나1", "김하나1 pulled on latest queue");
  }

  section("client projection before persist");
  {
    const seeded = await seed();
    const a = seeded.draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const projected = projectPendingIntents({
      confirmedDraft: seeded.draft,
      pending: [
        makeMutationIntent(
          makeMoveReservationChange({
            reservationKey: reservationKey(a.reservation),
            to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
          }),
          "p1"
        )!,
        makeMutationIntent(
          { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
          "p2"
        )!,
      ],
    });
    assert(projected.applied.length === 2, "both intents project immediately");
    const t0 = Date.now();
    projectPendingIntents({
      confirmedDraft: seeded.draft,
      pending: projected.applied,
    });
    assert(Date.now() - t0 < 100, "next projection <100ms");
  }

  section("3부 HOUSE SICK persist+reload");
  {
    const wanted = [RESET_TRAP, HOUSE_START, PULL, 20, 21, 22, 23, 14, 15];
    const caddies = await prisma.caddy.findMany({
      where: { id: { in: wanted }, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    });
    const byId = new Map(caddies.map((c) => [c.id, c]));
    const pool: AutoAssignCaddy[] = wanted
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c, i) => ({
        id: c.id,
        name: c.name,
        team: `${i}조`,
        teamOrder: i,
        caddyType: String(c.caddyType),
        employmentStatus: String(c.employmentStatus),
      }));
    const result = computeAutoAssignmentsV1({
      date: DATE,
      available: pool,
      openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
      houseStartCaddyId: HOUSE_START,
      reservations: [
        { date: DATE, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "A팀", rawRowIndex: 1, sourceSheet: "예약1부" },
        { date: DATE, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "B팀", rawRowIndex: 2, sourceSheet: "예약1부" },
        { date: DATE, course: "SKY", shift: "3부", teeTime: "17:00", teamName: "3A", rawRowIndex: 10, sourceSheet: "예약3부" },
        { date: DATE, course: "OCEAN", shift: "3부", teeTime: "17:00", teamName: "3B", rawRowIndex: 11, sourceSheet: "예약3부" },
        { date: DATE, course: "LAKE", shift: "3부", teeTime: "17:08", teamName: "3C", rawRowIndex: 12, sourceSheet: "예약3부" },
        { date: DATE, course: "VERTHILL", shift: "3부", teeTime: "17:08", teamName: "3D", rawRowIndex: 13, sourceSheet: "예약3부" },
      ],
    });
    const thirdDraft = createDraftFromAutoResult(result, pool);
    const thirdVersion = await persistLiveFromDraft(thirdDraft);
    const thirdNames = (d: AssignmentDraft) =>
      d.assignments
        .filter((a) => a.shift === "3부" && a.kind === "regular")
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
        .map((a) => a.caddy.name);
    const victim = thirdDraft.assignments.find(
      (a) => a.shift === "3부" && a.kind === "regular"
    );
    assert(!!victim, "3부 HOUSE victim exists");
    if (!victim) throw new Error("no 3부 victim");
    const before = thirdNames(thirdDraft);
    const t0 = Date.now();
    const projected = projectPendingIntents({
      confirmedDraft: thirdDraft,
      pending: [
        makeMutationIntent(
          { type: "CADDY_SICK", caddyId: victim.caddy.id, shift: "3부" },
          "3sick"
        )!,
      ],
    });
    const paintMs = Date.now() - t0;
    assert(paintMs < 100, `3부 click→paint ${paintMs}ms < 100`);
    assert(
      !projected.draft.assignments.some((a) => a.caddy.id === victim.caddy.id),
      "3부 victim gone on optimistic paint"
    );
    const afterNames = thirdNames(projected.draft);
    if (before.length > 1) {
      assert(
        afterNames[0] === before[1] || afterNames.includes(before[1]),
        "3부 pull-forward"
      );
    }
    const persist = await applyIntent(
      thirdDraft,
      { type: "CADDY_SICK", caddyId: victim.caddy.id, shift: "3부" },
      thirdVersion
    );
    assert(persist.persist?.ok === true, "3부 sick persist 200");
    const reloaded = await reloadDraft();
    assert(
      !reloaded.draft.assignments.some((a) => a.caddy.id === victim.caddy.id),
      "3부 sick held after reload"
    );
    const unavail = await prisma.dailyCaddyUnavailable.findMany({ where: { date: day } });
    assert(
      unavail.some((u) => u.caddyId === victim.caddy.id),
      "3부 unavailable written"
    );
  }

  await prisma.$disconnect();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
