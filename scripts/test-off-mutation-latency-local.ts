/**
 * 5s OFF delay + warm cache: SICK×2 persist latency. caddy_local only.
 * 실행: npx tsx scripts/test-off-mutation-latency-local.ts
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
import {
  assignmentDraftToPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import {
  getDailyBoardDraft,
  saveDailyBoardDraft,
} from "../src/lib/dailyBoardDraftService";
import { applyQuickBoardMutation } from "../src/lib/quickBoardMutationApply";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
} from "../src/lib/boardMutationPipeline";
import { resolveCanonicalLivePool } from "../src/lib/opsDutyLivePool";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
  resetOffSheetHttpStatsForTests,
  seedOffSheetCacheForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import { resolveCanonicalOffSheet } from "../src/lib/caddyPoolCanonicalService";
import type { OffSheet } from "../src/lib/offSheetParser";
import type { ShiftPart } from "../src/lib/reservationParser";

const DATE = "2026-09-17";
const day = parseYmd(DATE).start;
const OFF_ID = 25;
const SICK_A = 13;
const SICK_B = 19;
const DELAY = 5000;
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
      [`${y}.${m}.${d} (목)`, "", ""],
      ["1조", "2조", "3조"],
      [names[0] || "", "", ""],
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
  if (!offRow) throw new Error("OFF caddy missing");
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
    houseStartCaddyId: SICK_A,
    reservations: [
      ...shiftRows("1부", 4, 7, "A"),
      ...shiftRows("2부", 4, 12, "B"),
      ...shiftRows("3부", 4, 17, "C"),
    ],
  });
  const draft = createDraftFromAutoResult(result, [...pool, offCaddy]);
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
  return { draft, pool, offCaddy, version: saved.version };
}

function usedIds(draft: AssignmentDraft) {
  const ids = draft.assignments.map((a) => a.caddy.id);
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) ids.push(s.spare1.caddyId);
    if (s.spare2?.caddyId) ids.push(s.spare2.caddyId);
  }
  return ids;
}

async function persistSick(
  draft: AssignmentDraft,
  pool: AutoAssignCaddy[],
  version: number,
  caddyId: number
) {
  const intent = makeMutationIntent(
    { type: "CADDY_SICK", caddyId, shift: "1부" },
    `sick-${caddyId}`
  )!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: draft,
    intent,
    regularCaddyPool: pool,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  const preparedHasOff = usedIds(prepared.painted).includes(OFF_ID);
  const offStart = Date.now();
  const canonical = await resolveCanonicalLivePool(DATE, pool, {
    offSheetMode: "cache-or-fetch",
    rosterClientPool: draft.caddyPool,
    computeClientPool: pool,
  });
  const offMs = Date.now() - offStart;
  const persistStart = Date.now();
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
  if (!persist.ok) throw new Error(persist.message);
  return {
    offMs,
    persistMs: Date.now() - persistStart,
    dbMs: persist.timings?.persistMs ?? 0,
    source: canonical.offSheetSource,
    preparedHasOff,
    version: Number(persist.draft?.version),
    painted: payloadToAssignmentDraft(persist.draft!.payload as never),
  };
}

async function main() {
  const { offCaddy } = await seedBoard();

  section("cold overlap 5s is one HTTP");
  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, DELAY));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const started = Date.now();
    const [a, b] = await Promise.all([
      resolveCanonicalOffSheet(DATE, "cache-or-fetch"),
      resolveCanonicalOffSheet(DATE, "cache-or-fetch"),
    ]);
    const elapsed = Date.now() - started;
    assert(a.matched && b.matched, "overlap both matched");
    assert(getOffSheetHttpFetchCount() === 1, `overlap HTTP 1 (got ${getOffSheetHttpFetchCount()})`);
    assert(elapsed >= 4500 && elapsed < 8000, `overlap waited one 5s fetch (${elapsed}ms)`);
  }

  section("cold sequential SICK×2 after 5s fetch");
  {
    const seeded = await seedBoard();
    const pool = [...seeded.pool, offCaddy];
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, DELAY));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const drainStart = Date.now();
    const first = await persistSick(seeded.draft, pool, seeded.version, SICK_A);
    const second = await persistSick(first.painted, pool, first.version, SICK_B);
    const drainMs = Date.now() - drainStart;
    console.log(
      `  · first off=${first.offMs}ms persist=${first.persistMs}ms db=${first.dbMs}ms source=${first.source} paintedOff=${first.preparedHasOff}`
    );
    console.log(
      `  · second off=${second.offMs}ms persist=${second.persistMs}ms db=${second.dbMs}ms source=${second.source} paintedOff=${second.preparedHasOff}`
    );
    console.log(`  · drain=${drainMs}ms http=${getOffSheetHttpFetchCount()}`);
    assert(getOffSheetHttpFetchCount() === 1, "sequential 2 SICK is 1 HTTP");
    assert(first.source === "fetch", "first is cold fetch");
    assert(second.source === "cache", "second reuses date snapshot");
    assert(first.offMs >= 4500, "first waited for 5s OFF");
    assert(second.offMs < 200, `second did not fetch again (${second.offMs}ms)`);
    assert(seeded.version === 1 && first.version === 2 && second.version === 3, "Draft 1→2→3");
    const reloaded = payloadToAssignmentDraft((await getDailyBoardDraft(DATE))!.payload);
    assert(!usedIds(first.painted).includes(OFF_ID), "persist1: OFF not in Draft used");
    assert(!usedIds(second.painted).includes(OFF_ID), "persist2: OFF not in Draft used");
    assert(!usedIds(reloaded).includes(SICK_A), "reload: first SICK gone");
    assert(!usedIds(reloaded).includes(SICK_B), "reload: second SICK gone");
    assert(!usedIds(reloaded).includes(OFF_ID), "reload: OFF not resurrected");
    const spare1 = (reloaded.sparesByShift || []).find((s) => s.shift === "1부");
    assert(!!spare1?.spare1, "1부 spare pull-forward kept spare1");
  }

  section("warm cache SICK×2 is 0 HTTP");
  {
    const seeded = await seedBoard();
    const pool = [...seeded.pool, offCaddy];
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    seedOffSheetCacheForTests([offSheetForDate(DATE, [offCaddy.name])]);
    setPublishedOffSheetLoaderForTests(async () => {
      throw new Error("warm must not HTTP");
    });
    const drainStart = Date.now();
    const first = await persistSick(seeded.draft, pool, seeded.version, SICK_A);
    const second = await persistSick(first.painted, pool, first.version, SICK_B);
    const drainMs = Date.now() - drainStart;
    console.log(
      `  · warm first persist=${first.persistMs}ms off=${first.offMs}ms source=${first.source}`
    );
    console.log(
      `  · warm second persist=${second.persistMs}ms off=${second.offMs}ms source=${second.source}`
    );
    console.log(`  · warm drain=${drainMs}ms http=${getOffSheetHttpFetchCount()}`);
    assert(getOffSheetHttpFetchCount() === 0, "warm 0 HTTP");
    assert(first.source === "cache" && second.source === "cache", "warm both cache");
    assert(first.persistMs < 500, `warm first persist <500ms (${first.persistMs})`);
    assert(second.persistMs < 500, `warm second persist <500ms (${second.persistMs})`);
    assert(drainMs < 1000, `warm drain <1000ms (${drainMs})`);
    assert(first.version === 2 && second.version === 3, "warm Draft 1→2→3");
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
