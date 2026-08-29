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
