/**
 * Local-only atomicity gate for quick MOVE.
 * caddy_local only. Production DB forbidden.
 *
 * 1) Current #104 sequential path: apply 200 then Draft PUT 409
 * 2) Atomic quick-move: apply fail / 409 / 500 / success for uid + id
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
  applyLiveAssignmentChange,
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
} from "../src/lib/assignmentChange";
import {
  applyQuickReservationMove,
  QUICK_MOVE_DRAFT_FORCE_FAIL,
  QUICK_MOVE_LIVE_FORCE_FAIL,
} from "../src/lib/quickReservationMoveApply";

const DATE = "2099-12-15";
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

function allAt(
  live: Awaited<ReturnType<typeof liveState>>,
  stored: Awaited<ReturnType<typeof draftState>>,
  clientSlot: string | null,
  expected: string
) {
  const liveSlot = slotOf(live.reservation);
  return (
    liveSlot === expected &&
    stored.slot === expected &&
    clientSlot === expected &&
    (live.reservation?.placementCount ?? 0) > 0
  );
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

type TeamCase = {
  teamName: string;
  dest: { course: string; shift: string; teeTime: string };
  occupiedDest: { course: string; shift: string; teeTime: string };
};

function teamRow(draft: AssignmentDraft, teamName: string) {
  const row = draft.assignments.find((a) => a.reservation.teamName === teamName);
  if (!row) throw new Error(`missing ${teamName}`);
  return row;
}

function fromSlot(draft: AssignmentDraft, teamName: string) {
  const row = teamRow(draft, teamName);
  return `${row.reservation.course} ${row.shift || row.reservation.shift} ${row.reservation.teeTime}`;
}

function paintedDraft(
  draft: AssignmentDraft,
  teamName: string,
  dest: TeamCase["dest"]
) {
  const row = teamRow(draft, teamName);
  const change = makeMoveReservationChange({
    reservationKey: reservationIdentity(row.reservation),
    reservationId: row.reservation.id,
    to: { ...dest, date: DATE },
  });
  const preview = previewLiveChangeFromDraft({ draft, change });
  return {
    change,
    preview,
    painted: applyLiveResultToDraft(draft, preview.after),
    previous: autoResultFromDraft(draft, null),
  };
}

async function runAtomic(input: {
  draft: AssignmentDraft;
  version: number;
  teamName: string;
  dest: TeamCase["dest"];
  expectedVersion?: number;
  testFailLive?: "error" | null;
  testFailDraft?: "error" | null;
}) {
  const move = paintedDraft(input.draft, input.teamName, input.dest);
  const started = Date.now();
  const result = await applyQuickReservationMove({
    previous: move.previous,
    regularCaddyPool: input.draft.caddyPool,
    events: move.preview.events,
    changeType: "MOVE_RESERVATION",
    draft: {
      date: DATE,
      expectedVersion: input.expectedVersion ?? input.version,
      payload: assignmentDraftToPayload(move.painted),
    },
    updatedByUserId: null,
    testFailLive: input.testFailLive,
    testFailDraft: input.testFailDraft,
  });
  return { result, move, totalMs: Date.now() - started };
}

async function main() {
  section("seed fixture: Draft + live at A");
  let seeded = await seedFixture();
  const excelFrom = fromSlot(seeded.draft, "엑셀이동팀");
  const dbFrom = fromSlot(seeded.draft, "DB이동팀");
  const excelKey = reservationIdentity(teamRow(seeded.draft, "엑셀이동팀").reservation);
  const dbKey = reservationIdentity(teamRow(seeded.draft, "DB이동팀").reservation);
  assert(excelFrom === "SKY 1부 07:00", "excel source A is SKY 07:00");
  assert(dbFrom === "OCEAN 1부 07:00", "id source A is OCEAN 07:00");
  assert(excelKey.startsWith("uid:"), "excel reservation uses uid");
  assert(dbKey.startsWith("id:"), "DB reservation uses id");
  const excelLiveA = await liveState("엑셀이동팀");
  const dbLiveA = await liveState("DB이동팀");
  assert(slotOf(excelLiveA.reservation) === excelFrom, "live excel at A");
  assert(slotOf(dbLiveA.reservation) === dbFrom, "live id at A");
  assert((excelLiveA.reservation?.placementCount ?? 0) > 0, "excel placement at A");
  assert((dbLiveA.reservation?.placementCount ?? 0) > 0, "id placement at A");

  section("current #104 sequential path: apply 200 + Draft PUT 409");
  {
    const move = paintedDraft(seeded.draft, "엑셀이동팀", {
      course: "VERTHILL",
      shift: "1부",
      teeTime: "07:00",
    });
    const apply = await applyLiveAssignmentChange({
      previous: move.previous,
      regularCaddyPool: seeded.draft.caddyPool,
      events: move.preview.events,
      changeType: "MOVE_RESERVATION",
    });
    assert(apply.ok === true, "sequential apply 200");
    const afterApplyLive = await liveState("엑셀이동팀");
    const afterApplyDraft = await draftState("엑셀이동팀");
    let putStatus = 0;
    try {
      await saveDailyBoardDraft({
        date: DATE,
        expectedVersion: seeded.version + 5,
        payload: assignmentDraftToPayload(move.painted),
        updatedByUserId: null,
      });
    } catch (e) {
      putStatus = e && typeof e === "object" && "status" in e ? Number((e as { status: number }).status) : 0;
    }
    const afterPutLive = await liveState("엑셀이동팀");
    const afterPutDraft = await draftState("엑셀이동팀");
    const clientRolledBack = excelFrom;
    const liveAtB =
      slotOf(afterPutLive.reservation) === "VERTHILL 1부 07:00";
    const draftAtA = afterPutDraft.slot === excelFrom;
    const splitBrain = liveAtB && draftAtA && clientRolledBack === excelFrom;
    console.log(
      JSON.stringify(
        {
          path: "sequential apply + Draft PUT 409",
          applyOk: apply.ok,
          putStatus,
          afterApply200: {
            live: slotOf(afterApplyLive.reservation),
            draft: afterApplyDraft.slot,
            version: afterApplyDraft.version,
          },
          afterPutFail: {
            live: slotOf(afterPutLive.reservation),
            draft: afterPutDraft.slot,
            version: afterPutDraft.version,
            clientRollback: clientRolledBack,
          },
          splitBrain,
        },
        null,
        2
      )
    );
    assert(putStatus === 409, "forced Draft PUT is 409");
    assert(splitBrain, "current #104 sequential path splits live B vs Draft/client A");
    await persistLiveFromDraft(seeded.draft);
    await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
    const restored = await saveDailyBoardDraft({
      date: DATE,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(seeded.draft),
      updatedByUserId: null,
    });
    seeded.version = restored.version;
  }

  const cases: Array<{ name: string; team: TeamCase; mode: string }> = [
    {
      name: "uid apply-stage fail (occupied dest)",
      team: {
        teamName: "엑셀이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "occupied",
    },
    {
      name: "uid apply-stage fail (forced live 500)",
      team: {
        teamName: "엑셀이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "live500",
    },
    {
      name: "uid Draft version 409",
      team: {
        teamName: "엑셀이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "409",
    },
    {
      name: "uid Draft save 500",
      team: {
        teamName: "엑셀이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "500",
    },
    {
      name: "uid success",
      team: {
        teamName: "엑셀이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "success",
    },
    {
      name: "id Draft version 409",
      team: {
        teamName: "DB이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "409",
    },
    {
      name: "id Draft save 500",
      team: {
        teamName: "DB이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "500",
    },
    {
      name: "id success",
      team: {
        teamName: "DB이동팀",
        dest: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
        occupiedDest: { course: "LAKE", shift: "1부", teeTime: "07:08" },
      },
      mode: "success",
    },
  ];

  const latency: Array<{ name: string; totalMs: number; persistMs: number | null }> = [];

  for (const item of cases) {
    section(item.name);
    const reset = await seedFixture();
    const from = fromSlot(reset.draft, item.team.teamName);
    const destSlot = `${item.team.dest.course} ${item.team.dest.shift} ${item.team.dest.teeTime}`;
    const occupiedSlot = `${item.team.occupiedDest.course} ${item.team.occupiedDest.shift} ${item.team.occupiedDest.teeTime}`;

    if (item.mode === "occupied") {
      const out = await runAtomic({
        draft: reset.draft,
        version: reset.version,
        teamName: item.team.teamName,
        dest: item.team.occupiedDest,
      });
      const live = await liveState(item.team.teamName);
      const stored = await draftState(item.team.teamName);
      const client = out.result.ok ? destSlot : from;
      assert(out.result.ok === false, "occupied dest apply fails");
      assert(out.result.ok === false && out.result.httpStatus === 400, "occupied dest is 400");
      assert(allAt(live, stored, client, from), "apply fail keeps live/Draft/client at A");
      assert(stored.slot !== occupiedSlot, "occupied dest not written");
      continue;
    }

    const out = await runAtomic({
      draft: reset.draft,
      version: reset.version,
      teamName: item.team.teamName,
      dest: item.team.dest,
      expectedVersion: item.mode === "409" ? reset.version + 5 : reset.version,
      testFailLive: item.mode === "live500" ? "error" : null,
      testFailDraft: item.mode === "500" ? "error" : null,
    });
    const live = await liveState(item.team.teamName);
    const stored = await draftState(item.team.teamName);
    const client = out.result.ok ? destSlot : from;
    const expected = item.mode === "success" ? destSlot : from;

    if (item.mode === "live500") {
      assert(out.result.ok === false && out.result.httpStatus === 500, "forced live fail is 500");
      assert(
        out.result.ok === false && out.result.code === QUICK_MOVE_LIVE_FORCE_FAIL,
        "live fail code"
      );
    }
    if (item.mode === "409") {
      assert(out.result.ok === false && out.result.httpStatus === 409, "version mismatch is 409");
    }
    if (item.mode === "500") {
      assert(out.result.ok === false && out.result.httpStatus === 500, "forced draft fail is 500");
      assert(
        out.result.ok === false && out.result.code === QUICK_MOVE_DRAFT_FORCE_FAIL,
        "draft fail code"
      );
    }
    if (item.mode === "success") {
      assert(out.result.ok === true, "atomic success");
      if (out.result.ok) {
        assert(out.result.draft.version === reset.version + 1, "Draft version bumped");
        latency.push({
          name: item.name,
          totalMs: out.totalMs,
          persistMs: out.result.timings.persistMs,
        });
      }
    }
    assert(
      allAt(live, stored, client, expected),
      `${item.name}: Reservation/Placement/Draft/client all ${expected}`
    );

    const reloadedLive = await liveState(item.team.teamName);
    const reloadedDraft = await draftState(item.team.teamName);
    assert(
      allAt(reloadedLive, reloadedDraft, reloadedDraft.slot, expected),
      `${item.name}: reload matches`
    );
  }

  section("success path latency");
  const seqSeed = await seedFixture();
  const seqMove = paintedDraft(seqSeed.draft, "엑셀이동팀", {
    course: "VERTHILL",
    shift: "1부",
    teeTime: "07:00",
  });
  const seqStarted = Date.now();
  const seqApply = await applyLiveAssignmentChange({
    previous: seqMove.previous,
    regularCaddyPool: seqSeed.draft.caddyPool,
    events: seqMove.preview.events,
    changeType: "MOVE_RESERVATION",
  });
  const seqApplyMs = Date.now() - seqStarted;
  const seqPutStarted = Date.now();
  if (seqApply.ok) {
    await saveDailyBoardDraft({
      date: DATE,
      expectedVersion: seqSeed.version,
      payload: assignmentDraftToPayload(seqMove.painted),
      updatedByUserId: null,
    });
  }
  const seqPutMs = Date.now() - seqPutStarted;
  const seqTotal = seqApplyMs + seqPutMs;
  console.log(
    JSON.stringify(
      {
        sequentialApplyPlusPutMs: seqTotal,
        sequentialApplyMs: seqApplyMs,
        sequentialPutMs: seqPutMs,
        atomicSuccess: latency,
      },
      null,
      2
    )
  );
  assert(seqApply.ok === true, "sequential success still works for latency compare");
  assert(latency.length >= 2, "uid + id success latency captured");

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
