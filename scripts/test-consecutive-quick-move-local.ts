/**
 * Local-only: 3 consecutive team moves (uid + id mix) on caddy_local.
 * Persist stays serial. Production DB forbidden.
 *
 *   npx tsx scripts/test-consecutive-quick-move-local.ts
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
import {
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
} from "../src/lib/assignmentChange";
import { applyQuickReservationMove } from "../src/lib/quickReservationMoveApply";
import {
  bumpPersistGeneration,
  rollbackDraftAfterQueuedMoveFailure,
  shouldRunQueuedPersist,
} from "../src/lib/quickMovePersistQueue";

const DATE = "2099-12-16";
const day = parseYmd(DATE).start;

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

function teamRow(draft: AssignmentDraft, teamName: string) {
  const row = draft.assignments.find((a) => a.reservation.teamName === teamName);
  if (!row) throw new Error(`missing ${teamName}`);
  return row;
}

function slotOf(draft: AssignmentDraft, teamName: string) {
  const row = teamRow(draft, teamName);
  return `${row.reservation.course} ${row.shift || row.reservation.shift} ${row.reservation.teeTime}`;
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
    take: 12,
  });
  if (caddies.length < 6) {
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
        teamName: "연속A-uid",
        rawRowIndex: 31,
        sourceSheet: "예약1부",
      },
      {
        id: "db-consec-b",
        date: DATE,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "연속B-id",
        rawRowIndex: 32,
        sourceSheet: "예약1부",
      },
      {
        date: DATE,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "연속C-uid",
        rawRowIndex: 33,
        sourceSheet: "예약1부",
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
  return { draft: hydrated, version: saved.version };
}

async function main() {
  console.log("== consecutive quick MOVE (uid/id mix) ==");
  const seeded = await seedFixture();
  const aKey = reservationIdentity(teamRow(seeded.draft, "연속A-uid").reservation);
  const bKey = reservationIdentity(teamRow(seeded.draft, "연속B-id").reservation);
  const cKey = reservationIdentity(teamRow(seeded.draft, "연속C-uid").reservation);
  assert(aKey.startsWith("uid:"), "A uses uid");
  assert(bKey.startsWith("id:"), "B uses id");
  assert(cKey.startsWith("uid:"), "C uses uid");

  const moves = [
    { team: "연속A-uid", dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" } },
    { team: "연속B-id", dest: { course: "SKY", shift: "1부", teeTime: "07:16" } },
    { team: "연속C-uid", dest: { course: "OCEAN", shift: "1부", teeTime: "07:16" } },
  ] as const;

  let draft = seeded.draft;
  let version = seeded.version;
  const versions: number[] = [version];

  for (const step of moves) {
    const row = teamRow(draft, step.team);
    const change = makeMoveReservationChange({
      reservationKey: reservationIdentity(row.reservation),
      reservationId: row.reservation.id,
      to: { ...step.dest, date: DATE },
    });
    const preview = previewLiveChangeFromDraft({ draft, change });
    const painted = applyLiveResultToDraft(draft, preview.after);
    const previous = autoResultFromDraft(draft, null);
    const result = await applyQuickReservationMove({
      previous,
      regularCaddyPool: draft.caddyPool,
      events: preview.events,
      changeType: "MOVE_RESERVATION",
      draft: {
        date: DATE,
        expectedVersion: version,
        payload: assignmentDraftToPayload(painted),
      },
      updatedByUserId: null,
    });
    assert(result.ok === true, `${step.team} persist ok (no 409)`);
    if (result.ok) {
      assert(result.draft.version === version + 1, `${step.team} version ${version}→${version + 1}`);
      version = result.draft.version;
      versions.push(version);
      draft = payloadToAssignmentDraft(result.draft.payload);
    }
  }

  assert(
    versions.join(",") === "1,2,3,4" ||
      (versions.length === 4 &&
        versions[1] === versions[0] + 1 &&
        versions[2] === versions[1] + 1 &&
        versions[3] === versions[2] + 1),
    `Draft version sequential ${versions.join("→")}`
  );
  assert(slotOf(draft, "연속A-uid") === "VERTHILL 1부 07:00", "A at dest after serial persist");
  assert(slotOf(draft, "연속B-id") === "SKY 1부 07:16", "B at dest after serial persist");
  assert(slotOf(draft, "연속C-uid") === "OCEAN 1부 07:16", "C at dest after serial persist");

  const reloaded = await getDailyBoardDraft(DATE);
  assert(!!reloaded, "draft reloads");
  if (reloaded) {
    const again = payloadToAssignmentDraft(reloaded.payload);
    assert(reloaded.version === version, "reload version matches last persist");
    assert(slotOf(again, "연속A-uid") === "VERTHILL 1부 07:00", "reload keeps A");
    assert(slotOf(again, "연속B-id") === "SKY 1부 07:16", "reload keeps B");
    assert(slotOf(again, "연속C-uid") === "OCEAN 1부 07:16", "reload keeps C");
  }

  const live = await prisma.dailyReservation.findMany({
    where: { date: day, teamName: { in: ["연속A-uid", "연속B-id", "연속C-uid"] } },
  });
  const liveSlot = (name: string) => {
    const row = live.find((r) => r.teamName === name);
    return row ? `${row.course} ${row.shift} ${row.teeTime}` : null;
  };
  assert(liveSlot("연속A-uid") === "VERTHILL 1부 07:00", "live A dest");
  assert(liveSlot("연속B-id") === "SKY 1부 07:16", "live B dest");
  assert(liveSlot("연속C-uid") === "OCEAN 1부 07:16", "live C dest");

  console.log("\n== move1 ok → move2 409 → move3 cancelled ==");
  {
    const seededFail = await seedFixture();
    let persistGen = 0;
    const lastSuccessful = { draft: seededFail.draft };

    const move1 = {
      team: "연속A-uid",
      dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" as const },
    };
    const row1 = teamRow(seededFail.draft, move1.team);
    const change1 = makeMoveReservationChange({
      reservationKey: reservationIdentity(row1.reservation),
      reservationId: row1.reservation.id,
      to: { ...move1.dest, date: DATE },
    });
    const preview1 = previewLiveChangeFromDraft({
      draft: seededFail.draft,
      change: change1,
    });
    const painted1 = applyLiveResultToDraft(seededFail.draft, preview1.after);
    const gen1 = persistGen;
    const result1 = await applyQuickReservationMove({
      previous: autoResultFromDraft(seededFail.draft, null),
      regularCaddyPool: seededFail.draft.caddyPool,
      events: preview1.events,
      changeType: "MOVE_RESERVATION",
      draft: {
        date: DATE,
        expectedVersion: seededFail.version,
        payload: assignmentDraftToPayload(painted1),
      },
      updatedByUserId: null,
    });
    assert(result1.ok === true, "move1 persist ok");
    if (!result1.ok) throw new Error("move1 failed");
    lastSuccessful.draft = payloadToAssignmentDraft(result1.draft.payload);
    let version = result1.draft.version;

    const row2 = teamRow(painted1, "연속B-id");
    const change2 = makeMoveReservationChange({
      reservationKey: reservationIdentity(row2.reservation),
      reservationId: row2.reservation.id,
      to: { course: "SKY", shift: "1부", teeTime: "07:16", date: DATE },
    });
    const preview2 = previewLiveChangeFromDraft({ draft: painted1, change: change2 });
    const painted2 = applyLiveResultToDraft(painted1, preview2.after);
    const gen2 = persistGen;
    const result2 = await applyQuickReservationMove({
      previous: autoResultFromDraft(painted1, null),
      regularCaddyPool: painted1.caddyPool,
      events: preview2.events,
      changeType: "MOVE_RESERVATION",
      draft: {
        date: DATE,
        expectedVersion: version + 9,
        payload: assignmentDraftToPayload(painted2),
      },
      updatedByUserId: null,
    });
    assert(result2.ok === false, "move2 persist 409/fail");
    if (shouldRunQueuedPersist(gen2, persistGen) && !result2.ok) {
      persistGen = bumpPersistGeneration(persistGen);
    }
    const rolled = rollbackDraftAfterQueuedMoveFailure({
      lastSuccessfulDraft: lastSuccessful.draft,
      failedMoveRollbackDraft: painted1,
    });
    assert(slotOf(rolled, "연속A-uid") === "VERTHILL 1부 07:00", "rollback keeps move1");
    assert(slotOf(rolled, "연속B-id") === "OCEAN 1부 07:00", "move2 optimistic rolled back");

    const row3 = teamRow(painted2, "연속C-uid");
    const change3 = makeMoveReservationChange({
      reservationKey: reservationIdentity(row3.reservation),
      reservationId: row3.reservation.id,
      to: { course: "OCEAN", shift: "1부", teeTime: "07:16", date: DATE },
    });
    const preview3 = previewLiveChangeFromDraft({ draft: painted2, change: change3 });
    const painted3 = applyLiveResultToDraft(painted2, preview3.after);
    const gen3 = gen2;
    assert(
      !shouldRunQueuedPersist(gen3, persistGen),
      "move3 queue aborted after move2 fail"
    );
    if (shouldRunQueuedPersist(gen3, persistGen)) {
      await applyQuickReservationMove({
        previous: autoResultFromDraft(painted2, null),
        regularCaddyPool: painted2.caddyPool,
        events: preview3.events,
        changeType: "MOVE_RESERVATION",
        draft: {
          date: DATE,
          expectedVersion: version,
          payload: assignmentDraftToPayload(painted3),
        },
        updatedByUserId: null,
      });
    }

    const stored = await getDailyBoardDraft(DATE);
    const storedDraft = stored ? payloadToAssignmentDraft(stored.payload) : null;
    assert(!!storedDraft, "draft still present");
    assert(slotOf(storedDraft!, "연속A-uid") === "VERTHILL 1부 07:00", "server Draft keeps move1");
    assert(slotOf(storedDraft!, "연속B-id") === "OCEAN 1부 07:00", "server Draft has no move2");
    assert(slotOf(storedDraft!, "연속C-uid") === "LAKE 1부 07:08", "server Draft has no move3");
    assert(stored?.version === version, "Draft version stayed at move1");

    const liveFail = await prisma.dailyReservation.findMany({
      where: { date: day, teamName: { in: ["연속A-uid", "연속B-id", "연속C-uid"] } },
    });
    const liveFailSlot = (name: string) => {
      const row = liveFail.find((r) => r.teamName === name);
      return row ? `${row.course} ${row.shift} ${row.teeTime}` : null;
    };
    assert(liveFailSlot("연속A-uid") === "VERTHILL 1부 07:00", "live keeps move1");
    assert(liveFailSlot("연속B-id") === "OCEAN 1부 07:00", "live has no move2");
    assert(liveFailSlot("연속C-uid") === "LAKE 1부 07:08", "live has no move3");
    const placeCount = await prisma.dailyPlacement.count({ where: { date: day } });
    assert(placeCount === 3, "placements stay at 3 rows");
    assert(shouldRunQueuedPersist(gen1, persistGen) === false, "failed gen blocks old captures");
  }

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
