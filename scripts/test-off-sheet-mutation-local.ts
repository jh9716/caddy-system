/**
 * Local persist: cold/stale OFF cache on SICK. caddy_local only.
 */
import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
} from "../src/lib/autoAssignEngine";
import {
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { assignmentDraftToPayload, payloadToAssignmentDraft } from "../src/lib/dailyBoardDraft";
import { getDailyBoardDraft, saveDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import { applyQuickBoardMutation } from "../src/lib/quickBoardMutationApply";
import { makeMutationIntent, prepareIntentOnConfirmedDraft } from "../src/lib/boardMutationPipeline";
import { resolveCanonicalLivePool } from "../src/lib/opsDutyLivePool";
import {
  OFF_SHEET_UNRESOLVED_CODE,
  OFF_SHEET_UNRESOLVED_USER_MESSAGE,
} from "../src/lib/caddyPoolCanonical";
import { isOffSheetUnresolvedError } from "../src/lib/caddyPoolCanonicalService";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
  OffSheetError,
  resetOffSheetHttpStatsForTests,
  seedOffSheetCacheForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import type { OffSheet } from "../src/lib/offSheetParser";
import type { ShiftPart } from "../src/lib/reservationParser";

const DATE = "2026-09-16";
const day = parseYmd(DATE).start;
const OFF_ID = 25; // 손지연
const SICK_1 = 13; // 서승희
const IDS = [1, 13, 19, 20, 21, 22, 23, 14, 15, 24, 2, 3, 4, OFF_ID];

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

function offSheetForDate(ymd: string, names: string[]): OffSheet {
  const [y, m, d] = ymd.split("-");
  return {
    name: `${m}${d}`,
    matrix: [
      [`${y}.${m}.${d} (화)`, "", ""],
      ["1조", "2조", "3조"],
      [names[0] || "", names[1] || "", ""],
    ],
  };
}

async function resetDay() {
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
}

async function persistDraft(draft: AssignmentDraft) {
  await resetDay();
  for (const row of draft.assignments) {
    const created = await prisma.dailyReservation.create({
      data: {
        date: day,
        course: row.reservation.course,
        shift: String(row.shift || row.reservation.shift),
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName ?? null,
        identityKey: `${row.reservation.shift}-${row.reservation.course}-${row.reservation.teeTime}`,
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
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
  });
  return saved.version;
}

function shiftRows(shift: ShiftPart, count: number, hour: number, prefix: string) {
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  return Array.from({ length: count }, (_, i) => ({
    date: DATE,
    course: courses[i % 4],
    shift,
    teeTime: `${String(hour).padStart(2, "0")}:${String((i % 4) * 8).padStart(2, "0")}`,
    teamName: `${prefix}${i + 1}`,
    rawRowIndex: i + 1,
    sourceSheet: `예약${shift}`,
  }));
}

async function seedBoard() {
  const rows = await prisma.caddy.findMany({
    where: { id: { in: IDS }, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  });
  const byId = new Map(rows.map((c) => [c.id, c]));
  const pool: AutoAssignCaddy[] = IDS.filter((id) => id !== OFF_ID)
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c, i) => ({
      id: c.id,
      name: c.name,
      team: String(c.team),
      teamOrder: i,
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    }));
  const offRow = byId.get(OFF_ID);
  if (!offRow) throw new Error("OFF caddy 손지연 missing");
  const offCaddy: AutoAssignCaddy = {
    id: offRow.id,
    name: offRow.name,
    team: String(offRow.team),
    teamOrder: 99,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: SICK_1,
    reservations: [
      ...shiftRows("1부", 4, 7, "A"),
      ...shiftRows("2부", 4, 12, "B"),
      ...shiftRows("3부", 4, 17, "C"),
    ],
  });
  const draft = createDraftFromAutoResult(result, [...pool, offCaddy]);
  const version = await persistDraft(draft);
  return { draft, pool, offCaddy, version, result };
}

function usedIds(draft: AssignmentDraft) {
  const ids = draft.assignments.map((a) => a.caddy.id);
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) ids.push(s.spare1.caddyId);
    if (s.spare2?.caddyId) ids.push(s.spare2.caddyId);
  }
  return ids;
}

async function main() {
  const { draft, pool, offCaddy, version } = await seedBoard();
  const victim1 = draft.assignments.find((a) => a.shift === "1부" && a.caddy.id === SICK_1)
    || draft.assignments.find((a) => a.shift === "1부")!;
  const polluted = [...pool, offCaddy];

  section("cold cache persist does not resurrect OFF");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => [
      offSheetForDate(DATE, [offCaddy.name]),
    ]);
    const canonical = await resolveCanonicalLivePool(DATE, polluted, {
      offSheetMode: "cache-or-fetch",
      rosterClientPool: draft.caddyPool,
      computeClientPool: polluted,
    });
    assert(canonical.offSheetSource === "fetch", "cold persist fetched OFF");
    assert(canonical.offSheetMatched, "today matched");
    assert(!canonical.computePool.some((c) => c.id === OFF_ID), "OFF out of canonical compute");
    assert(getOffSheetHttpFetchCount() === 1, "1 HTTP on cold miss");
    const intent = makeMutationIntent(
      { type: "CADDY_SICK", caddyId: victim1.caddy.id, shift: "1부" },
      "cold-1"
    )!;
    const prepared = prepareIntentOnConfirmedDraft({
      confirmedDraft: draft,
      intent,
      regularCaddyPool: canonical.computePool,
    });
    assert(prepared.ok, "cold SICK prepares");
    if (!prepared.ok) throw new Error("prepare");
    const persist = await applyQuickBoardMutation({
      previous: prepared.previous,
      regularCaddyPool: canonical.computePool,
      canonical,
      skipCanonicalReload: true,
      events: prepared.preview.events,
      changeType: prepared.preview.changeType,
      change: intent.change,
      draft: {
        date: DATE,
        expectedVersion: version,
        payload: assignmentDraftToPayload(prepared.painted),
      },
      updatedByUserId: null,
    });
    assert(persist.ok === true, "cold SICK persist 200");
    assert(getOffSheetHttpFetchCount() === 1, "skipCanonicalReload did not fetch again");
    const row = await getDailyBoardDraft(DATE);
    const reloaded = payloadToAssignmentDraft(row!.payload);
    assert(!usedIds(reloaded).includes(OFF_ID), "reload: OFF not placement/spare");
    assert(
      !reloaded.assignments.some((a) => a.caddy.id === victim1.caddy.id),
      "reload: sick victim gone"
    );
    assert(
      (await prisma.dailyCaddyUnavailable.findMany({ where: { date: day } })).some(
        (u) => u.caddyId === victim1.caddy.id
      ),
      "unavailable written"
    );
  }

  section("OFF HTTP 500 fails persist and keeps confirmed Draft/live");
  {
    const seeded = await seedBoard();
    const before = await getDailyBoardDraft(DATE);
    const beforeVersion = before!.version;
    const beforeIds = usedIds(payloadToAssignmentDraft(before!.payload));
    const victim = seeded.draft.assignments.find((a) => a.caddy.id === SICK_1)
      || seeded.draft.assignments.find((a) => a.shift === "1부")!;
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      throw new OffSheetError("forced 500", "off_sheet_fetch_failed", 500);
    });
    let liveThrown: unknown = null;
    try {
      await resolveCanonicalLivePool(DATE, [...seeded.pool, offCaddy], {
        offSheetMode: "cache-or-fetch",
        rosterClientPool: seeded.draft.caddyPool,
        computeClientPool: [...seeded.pool, offCaddy],
      });
    } catch (error) {
      liveThrown = error;
    }
    assert(isOffSheetUnresolvedError(liveThrown), "500 does not build a client-fallback pool");
    const persist = await applyQuickBoardMutation({
      previous: seeded.result,
      regularCaddyPool: [...seeded.pool, offCaddy],
      events: [
        {
          type: "REMOVE_CADDY",
          caddyId: victim.caddy.id,
          cause: "SICK",
          fromShift: "1부",
        },
      ],
      changeType: "CADDY_SICK",
      change: { type: "CADDY_SICK", caddyId: victim.caddy.id, shift: "1부" },
      draft: {
        date: DATE,
        expectedVersion: seeded.version,
        payload: assignmentDraftToPayload(seeded.draft),
      },
      updatedByUserId: null,
    });
    assert(persist.ok === false, "500 persist does not save");
    assert(persist.code === OFF_SHEET_UNRESOLVED_CODE, "500 persist code");
    assert(persist.message === OFF_SHEET_UNRESOLVED_USER_MESSAGE, "500 persist user message");
    const after = await getDailyBoardDraft(DATE);
    const reloaded = payloadToAssignmentDraft(after!.payload);
    assert(after!.version === beforeVersion, "confirmed Draft version unchanged after 500");
    assert(
      usedIds(reloaded).join(",") === beforeIds.join(","),
      "confirmed live placement/spare unchanged after 500"
    );
    assert(!usedIds(reloaded).includes(OFF_ID), "OFF caddy did not re-enter after 500");
    assert(
      reloaded.assignments.some((a) => a.caddy.id === victim.caddy.id),
      "SICK victim remains on confirmed board after 500"
    );
    assert(
      (await prisma.dailyCaddyUnavailable.findMany({ where: { date: day } })).length === 0,
      "500 did not write unavailable"
    );
  }

  section("OFF fetch timeout fails persist and keeps confirmed Draft/live");
  {
    const seeded = await seedBoard();
    const before = await getDailyBoardDraft(DATE);
    const beforeVersion = before!.version;
    const victim = seeded.draft.assignments.find((a) => a.caddy.id === SICK_1)
      || seeded.draft.assignments.find((a) => a.shift === "1부")!;
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    process.env.OFF_SHEET_RESOLVE_TIMEOUT_MS = "60";
    let persist;
    try {
      persist = await applyQuickBoardMutation({
        previous: seeded.result,
        regularCaddyPool: [...seeded.pool, offCaddy],
        events: [
          {
            type: "REMOVE_CADDY",
            caddyId: victim.caddy.id,
            cause: "SICK",
            fromShift: "1부",
          },
        ],
        changeType: "CADDY_SICK",
        change: { type: "CADDY_SICK", caddyId: victim.caddy.id, shift: "1부" },
        draft: {
          date: DATE,
          expectedVersion: seeded.version,
          payload: assignmentDraftToPayload(seeded.draft),
        },
        updatedByUserId: null,
      });
    } finally {
      delete process.env.OFF_SHEET_RESOLVE_TIMEOUT_MS;
    }
    assert(persist.ok === false, "timeout persist does not save");
    assert(persist.code === OFF_SHEET_UNRESOLVED_CODE, "timeout persist code");
    assert(
      persist.message === OFF_SHEET_UNRESOLVED_USER_MESSAGE,
      "timeout persist user message"
    );
    const after = await getDailyBoardDraft(DATE);
    const reloaded = payloadToAssignmentDraft(after!.payload);
    assert(after!.version === beforeVersion, "confirmed Draft version unchanged after timeout");
    assert(!usedIds(reloaded).includes(OFF_ID), "OFF caddy did not re-enter after timeout");
    assert(
      reloaded.assignments.some((a) => a.caddy.id === victim.caddy.id),
      "SICK victim remains on confirmed board after timeout"
    );
  }

  section("stale other-date cache fetches today");
  {
    const seeded = await seedBoard();
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    seedOffSheetCacheForTests([offSheetForDate("2026-08-01", ["어제휴무"])]);
    setPublishedOffSheetLoaderForTests(async () => [
      offSheetForDate(DATE, [offCaddy.name]),
    ]);
    const canonical = await resolveCanonicalLivePool(DATE, [...seeded.pool, offCaddy], {
      offSheetMode: "cache-or-fetch",
      rosterClientPool: seeded.draft.caddyPool,
      computeClientPool: [...seeded.pool, offCaddy],
    });
    assert(canonical.offSheetSource === "fetch", "stale date forced fetch");
    assert(!canonical.computePool.some((c) => c.id === OFF_ID), "stale cache did not keep OFF");
    assert(getOffSheetHttpFetchCount() === 1, "stale cache 1 HTTP");
  }

  setPublishedOffSheetLoaderForTests(null);
  invalidateOffSheetCache();
  await prisma.$disconnect();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  setPublishedOffSheetLoaderForTests(null);
  await prisma.$disconnect();
  process.exit(1);
});
