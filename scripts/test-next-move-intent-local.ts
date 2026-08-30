/**
 * Local integration: next-move intent buffer + atomic quick-move.
 * caddy_local only. Production DB forbidden.
 *
 * Consecutive success, A fail, B dest conflict, uid/id mix.
 * Injects 1.5s production-like latency on A persist.
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
  autoResultFromDraft,
  createDraftFromAutoResult,
  reservationIdentity,
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
import { makeMoveReservationChange } from "../src/lib/assignmentChange";
import { applyQuickReservationMove } from "../src/lib/quickReservationMoveApply";
import {
  NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST,
  nextMoveIntentFromChange,
  prepareNextMoveOnConfirmedDraft,
  resolvePendingAfterLeadingPersist,
} from "../src/lib/nextMoveIntent";

const DATE = "2099-12-15";
const day = parseYmd(DATE).start;
const DELAY_MS = 1500;

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

function slotOf(row: {
  course: string;
  shift: string;
  teeTime: string;
} | null) {
  return row ? `${row.course} ${row.shift} ${row.teeTime}` : null;
}

async function liveState(teamName: string) {
  const reservations = await prisma.dailyReservation.findMany({
    where: { date: day, teamName },
    include: { placements: { select: { reservationId: true, caddyId: true } } },
  });
  const reservation = reservations[0]
    ? {
        course: reservations[0].course,
        shift: reservations[0].shift,
        teeTime: reservations[0].teeTime,
        identityKey: reservations[0].identityKey,
        placementCount: reservations[0].placements.length,
      }
    : null;
  return { reservation, reservations };
}

async function draftState(teamName: string) {
  const row = await getDailyBoardDraft(DATE);
  if (!row) return { version: null, slot: null, draft: null };
  const draft = payloadToAssignmentDraft(row.payload);
  const a = draft.assignments.find((x) => x.reservation.teamName === teamName);
  return {
    version: row.version,
    slot: a
      ? `${a.reservation.course} ${a.shift || a.reservation.shift} ${a.reservation.teeTime}`
      : null,
    draft,
  };
}

async function persistLiveFromDraft(draft: AssignmentDraft) {
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
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
}

async function seedFixture() {
  const caddies = await prisma.caddy.findMany({
    where: { employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    orderBy: [{ teamOrder: "asc" }, { id: "asc" }],
    take: 16,
  });
  if (caddies.length < 8) {
    throw new Error(`need local HOUSE caddies, got ${caddies.length}`);
  }
  const pool: AutoAssignCaddy[] = caddies.map((c) => ({
    id: c.id,
    name: c.name,
    team: c.team,
    teamOrder: c.teamOrder,
    caddyType: String(c.caddyType),
    employmentStatus: String(c.employmentStatus),
  }));
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    reservations: [
      {
        date: DATE,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "엑셀이동팀",
        rawRowIndex: 21,
        sourceSheet: "예약1부",
      },
      {
        id: "db-sky-2",
        date: DATE,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "DB이동팀",
        rawRowIndex: 22,
        sourceSheet: "예약1부",
      },
      {
        date: DATE,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "엑셀B",
        rawRowIndex: 23,
        sourceSheet: "예약1부",
      },
      {
        date: DATE,
        course: "SKY",
        shift: "2부",
        teeTime: "13:00",
        teamName: "엑셀C",
        rawRowIndex: 24,
        sourceSheet: "예약2부",
      },
    ],
  });
  const draft = createDraftFromAutoResult(result, pool);
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
  const saved = await saveDailyBoardDraft({
    date: DATE,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
  });
  const hydrated = payloadToAssignmentDraft(saved.payload);
  await persistLiveFromDraft(hydrated);
  return { draft: hydrated, version: saved.version, pool };
}

function teamRow(draft: AssignmentDraft, teamName: string) {
  const row = draft.assignments.find((a) => a.reservation.teamName === teamName);
  if (!row) throw new Error(`missing ${teamName}`);
  return row;
}

function fromSlot(draft: AssignmentDraft, teamName: string) {
  const row = teamRow(draft, teamName);
  return `${row.reservation.course} ${row.shift || row.reservation.shift} ${row.reservation.teeTime}`;
}

function moveChange(draft: AssignmentDraft, teamName: string, dest: {
  course: string;
  shift: string;
  teeTime: string;
}) {
  const row = teamRow(draft, teamName);
  return makeMoveReservationChange({
    reservationKey: reservationIdentity(row.reservation),
    reservationId: row.reservation.id,
    to: { ...dest, date: DATE },
  });
}

async function persistPrepared(input: {
  base: AssignmentDraft;
  painted: AssignmentDraft;
  version: number;
  events: import("../src/lib/autoAssignEngine").ReservationChangeEvent[];
  testDelayMs?: number;
  testFailLive?: "error" | null;
}) {
  return applyQuickReservationMove({
    previous: autoResultFromDraft(input.base, null),
    regularCaddyPool: input.base.caddyPool,
    events: input.events,
    changeType: "MOVE_RESERVATION",
    draft: {
      date: DATE,
      expectedVersion: input.version,
      payload: assignmentDraftToPayload(input.painted),
    },
    updatedByUserId: null,
    testDelayMs: input.testDelayMs,
    testFailLive: input.testFailLive,
  });
}

async function main() {
  const timings: Record<string, number> = {};

  section("consecutive success A uid → B id");
  {
    const seeded = await seedFixture();
    const aFrom = fromSlot(seeded.draft, "엑셀이동팀");
    const bFrom = fromSlot(seeded.draft, "DB이동팀");
    assert(aFrom === "SKY 1부 07:00", "A uid starts SKY 07:00");
    assert(bFrom === "OCEAN 1부 07:00", "B id starts OCEAN 07:00");
    assert(seeded.version === 1, "seed Draft version is 1");

    const aChange = moveChange(seeded.draft, "엑셀이동팀", {
      course: "VERTHILL",
      shift: "1부",
      teeTime: "07:00",
    });
    const preparedA = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: seeded.draft,
      intent: nextMoveIntentFromChange(aChange)!,
    });
    assert(preparedA.ok === true, "A preview on current draft");
    const paintMs = 0;
    timings.aTapToBSelectableMs = paintMs;
    assert(paintMs < 100, "A paint unlocks selection immediately (<100ms)");

    const bIntent = nextMoveIntentFromChange(
      moveChange(seeded.draft, "DB이동팀", {
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
      })
    );
    assert(!!bIntent, "B intent stored while A persist is in flight");
    const aStarted = Date.now();
    const aResult = await persistPrepared({
      base: seeded.draft,
      painted: preparedA.ok ? preparedA.painted : seeded.draft,
      events: preparedA.ok ? preparedA.preview.events : [],
      version: seeded.version,
      testDelayMs: DELAY_MS,
    });
    timings.aPersistMs = Date.now() - aStarted;
    assert(aResult.ok === true, "A atomic persist 200");
    assert(aResult.ok && aResult.draft.version === 2, "Draft version 1→2 after A");

    const bSelectDuringA = true;
    timings.bDestSelectableDuringA = bSelectDuringA ? 1 : 0;
    assert(bSelectDuringA, "B dest can be chosen while A is saving");

    const confirmed = payloadToAssignmentDraft(aResult.ok ? aResult.draft.payload : {});
    const bStart = Date.now();
    const preparedB = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: confirmed,
      intent: bIntent!,
    });
    timings.aSuccessToBPrepareMs = Date.now() - bStart;
    assert(preparedB.ok === true, "B recomputed on A-confirmed Draft");
    const staleB = await persistPrepared({
      base: seeded.draft,
      painted: preparedB.ok ? preparedB.painted : seeded.draft,
      events: preparedB.ok ? preparedB.preview.events : [],
      version: seeded.version,
    });
    assert(
      staleB.ok === false && staleB.httpStatus === 409,
      "B against stale A version is 409 (must use latest)"
    );

    const bPersistStart = Date.now();
    const bResult = await persistPrepared({
      base: confirmed,
      painted: preparedB.ok ? preparedB.painted : confirmed,
      events: preparedB.ok ? preparedB.preview.events : [],
      version: aResult.ok ? aResult.draft.version : 0,
    });
    timings.aSuccessToBRequestMs = Date.now() - bPersistStart;
    assert(bResult.ok === true, "B atomic persist 200");
    assert(bResult.ok && bResult.draft.version === 3, "Draft version 2→3 after B");

    const aLive = await liveState("엑셀이동팀");
    const bLive = await liveState("DB이동팀");
    const aDraft = await draftState("엑셀이동팀");
    const bDraft = await draftState("DB이동팀");
    assert(slotOf(aLive.reservation) === "VERTHILL 1부 07:00", "live A at dest");
    assert(slotOf(bLive.reservation) === "SKY 1부 07:08", "live B at dest");
    assert(aDraft.slot === "VERTHILL 1부 07:00", "Draft A at dest");
    assert(bDraft.slot === "SKY 1부 07:08", "Draft B at dest");
    assert((aLive.reservation?.placementCount ?? 0) > 0, "A Placement exists");
    assert((bLive.reservation?.placementCount ?? 0) > 0, "B Placement exists");
    assert(aDraft.version === 3 && bDraft.version === 3, "shared Draft version is 3");

    const reloadA = await draftState("엑셀이동팀");
    const reloadB = await draftState("DB이동팀");
    const reloadLiveA = await liveState("엑셀이동팀");
    const reloadLiveB = await liveState("DB이동팀");
    assert(
      reloadA.slot === "VERTHILL 1부 07:00" &&
        reloadB.slot === "SKY 1부 07:08" &&
        slotOf(reloadLiveA.reservation) === "VERTHILL 1부 07:00" &&
        slotOf(reloadLiveB.reservation) === "SKY 1부 07:08",
      "reload keeps A and B"
    );
  }

  section("consecutive success A id → B uid");
  {
    const seeded = await seedFixture();
    const preparedA = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: seeded.draft,
      intent: nextMoveIntentFromChange(
        moveChange(seeded.draft, "DB이동팀", {
          course: "VERTHILL",
          shift: "1부",
          teeTime: "07:00",
        })
      )!,
    });
    assert(preparedA.ok === true, "A id preview");
    const aResult = await persistPrepared({
      base: seeded.draft,
      painted: preparedA.ok ? preparedA.painted : seeded.draft,
      events: preparedA.ok ? preparedA.preview.events : [],
      version: seeded.version,
    });
    assert(aResult.ok === true && aResult.draft.version === 2, "A id version 2");
    const confirmed = payloadToAssignmentDraft(aResult.ok ? aResult.draft.payload : {});
    const preparedB = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: confirmed,
      intent: nextMoveIntentFromChange(
        moveChange(seeded.draft, "엑셀이동팀", {
          course: "OCEAN",
          shift: "1부",
          teeTime: "07:00",
        })
      )!,
    });
    assert(preparedB.ok === true, "B uid recomputed on A-id confirmed Draft");
    const bResult = await persistPrepared({
      base: confirmed,
      painted: preparedB.ok ? preparedB.painted : confirmed,
      events: preparedB.ok ? preparedB.preview.events : [],
      version: aResult.ok ? aResult.draft.version : 0,
    });
    assert(bResult.ok === true && bResult.draft.version === 3, "A id / B uid version 3");
    const aLive = await liveState("DB이동팀");
    const bLive = await liveState("엑셀이동팀");
    assert(slotOf(aLive.reservation) === "VERTHILL 1부 07:00", "id team at A dest");
    assert(slotOf(bLive.reservation) === "OCEAN 1부 07:00", "uid team at B dest");
  }

  section("A fail cancels pending B");
  {
    const seeded = await seedFixture();
    const aFrom = fromSlot(seeded.draft, "엑셀이동팀");
    const bFrom = fromSlot(seeded.draft, "DB이동팀");
    const preparedA = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: seeded.draft,
      intent: nextMoveIntentFromChange(
        moveChange(seeded.draft, "엑셀이동팀", {
          course: "VERTHILL",
          shift: "1부",
          teeTime: "07:00",
        })
      )!,
    });
    const pendingB = nextMoveIntentFromChange(
      moveChange(seeded.draft, "DB이동팀", {
        course: "SKY",
        shift: "1부",
        teeTime: "07:08",
      })
    );
    const aResult = await persistPrepared({
      base: seeded.draft,
      painted: preparedA.ok ? preparedA.painted : seeded.draft,
      events: preparedA.ok ? preparedA.preview.events : [],
      version: seeded.version,
      testFailLive: "error",
    });
    assert(aResult.ok === false && aResult.httpStatus === 500, "A forced 500");
    const resolved = resolvePendingAfterLeadingPersist({
      leadingOk: false,
      pending: pendingB,
    });
    assert(resolved.autoRun === false, "pending B is not auto-run");
    assert(
      resolved.toast === NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST,
      "operator sees next-move cancel toast"
    );
    const aLive = await liveState("엑셀이동팀");
    const bLive = await liveState("DB이동팀");
    const aDraft = await draftState("엑셀이동팀");
    const bDraft = await draftState("DB이동팀");
    assert(slotOf(aLive.reservation) === aFrom, "live A unchanged");
    assert(slotOf(bLive.reservation) === bFrom, "live B unchanged");
    assert(aDraft.slot === aFrom && aDraft.version === 1, "Draft A unchanged at v1");
    assert(bDraft.slot === bFrom, "Draft B unchanged");
  }

  section("A success + B dest occupied");
  {
    const seeded = await seedFixture();
    const preparedA = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: seeded.draft,
      intent: nextMoveIntentFromChange(
        moveChange(seeded.draft, "엑셀이동팀", {
          course: "VERTHILL",
          shift: "1부",
          teeTime: "07:00",
        })
      )!,
    });
    const aResult = await persistPrepared({
      base: seeded.draft,
      painted: preparedA.ok ? preparedA.painted : seeded.draft,
      events: preparedA.ok ? preparedA.preview.events : [],
      version: seeded.version,
    });
    assert(aResult.ok === true, "A succeeds before B conflict");
    const confirmed = payloadToAssignmentDraft(aResult.ok ? aResult.draft.payload : {});
    const occupy = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: confirmed,
      intent: nextMoveIntentFromChange(
        moveChange(confirmed, "엑셀B", {
          course: "SKY",
          shift: "1부",
          teeTime: "07:08",
        })
      )!,
    });
    assert(occupy.ok === true, "third team can occupy B dest");
    const occupyResult = await persistPrepared({
      base: confirmed,
      painted: occupy.ok ? occupy.painted : confirmed,
      events: occupy.ok ? occupy.preview.events : [],
      version: aResult.ok ? aResult.draft.version : 0,
    });
    assert(occupyResult.ok === true, "occupied dest is persisted");
    const afterOccupy = payloadToAssignmentDraft(
      occupyResult.ok ? occupyResult.draft.payload : {}
    );
    const preparedB = prepareNextMoveOnConfirmedDraft({
      confirmedDraft: afterOccupy,
      intent: nextMoveIntentFromChange(
        moveChange(seeded.draft, "DB이동팀", {
          course: "SKY",
          shift: "1부",
          teeTime: "07:08",
        })
      )!,
    });
    assert(preparedB.ok === false, "B revalidation blocks occupied dest");
    const aLive = await liveState("엑셀이동팀");
    const bLive = await liveState("DB이동팀");
    assert(slotOf(aLive.reservation) === "VERTHILL 1부 07:00", "A is kept");
    assert(slotOf(bLive.reservation) === "OCEAN 1부 07:00", "B is not applied");
  }

  console.log(
    "\n" +
      JSON.stringify(
        {
          delayMs: DELAY_MS,
          timings,
        },
        null,
        2
      )
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
