/**
 * Measure SICK×2 persist latency vs OFF fetch. caddy_local only.
 * 실행: DATABASE_URL=... npx tsx scripts/measure-off-mutation-latency-local.ts
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
import type { OffSheet } from "../src/lib/offSheetParser";
import type { ShiftPart } from "../src/lib/reservationParser";

const DATE = "2026-09-17";
const day = parseYmd(DATE).start;
const OFF_ID = 25;
const SICK_A = 13;
const SICK_B = 19;
const DELAY = 5000;
const IDS = [1, 13, 19, 20, 21, 22, 23, 14, 15, 24, 2, 3, 4, OFF_ID];

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
  return { draft, pool, offCaddy, version: saved.version, result };
}

async function persistOne(
  draft: AssignmentDraft,
  pool: AutoAssignCaddy[],
  version: number,
  caddyId: number,
  label: string
) {
  const enqueue = Date.now();
  const intent = makeMutationIntent(
    { type: "CADDY_SICK", caddyId, shift: "1부" },
    label
  )!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: draft,
    intent,
    regularCaddyPool: pool,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  const persistStart = Date.now();
  const httpBefore = getOffSheetHttpFetchCount();
  const offStart = Date.now();
  const canonical = await resolveCanonicalLivePool(DATE, pool, {
    offSheetMode: "cache-or-fetch",
    rosterClientPool: draft.caddyPool,
    computeClientPool: pool,
  });
  const offEnd = Date.now();
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
  const persistEnd = Date.now();
  if (!persist.ok) throw new Error(persist.message);
  return {
    label,
    enqueueMs: persistStart - enqueue,
    offMs: offEnd - offStart,
    persistMs: persistEnd - persistStart,
    dbMs: persist.timings?.persistMs ?? null,
    computeMs: persist.timings?.computeMs ?? null,
    offSource: canonical.offSheetSource,
    httpDelta: getOffSheetHttpFetchCount() - httpBefore,
    version: persist.draft?.version ?? null,
    painted: persist.draft
      ? payloadToAssignmentDraft(persist.draft.payload as never)
      : prepared.painted,
    paintedCaddyCount: persist.draft
      ? payloadToAssignmentDraft(persist.draft.payload as never).assignments.length
      : prepared.painted.assignments.length,
  };
}

function publicTiming<T extends { painted?: unknown }>(row: T) {
  const { painted: _painted, ...rest } = row;
  void _painted;
  return rest;
}

async function main() {
  const rows: unknown[] = [];
  const { draft, pool, offCaddy } = await seedBoard();
  const polluted = [...pool, offCaddy];

  {
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((r) => setTimeout(r, DELAY));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const started = Date.now();
    const [a, b] = await Promise.all([
      resolveCanonicalLivePool(DATE, polluted, {
        offSheetMode: "cache-or-fetch",
        computeClientPool: polluted,
      }),
      resolveCanonicalLivePool(DATE, polluted, {
        offSheetMode: "cache-or-fetch",
        computeClientPool: polluted,
      }),
    ]);
    rows.push({
      scenario: "cold-overlap-5s",
      drainMs: Date.now() - started,
      http: getOffSheetHttpFetchCount(),
      aSource: a.offSheetSource,
      bSource: b.offSheetSource,
    });
  }

  {
    const seeded = await seedBoard();
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    setPublishedOffSheetLoaderForTests(async () => {
      await new Promise((r) => setTimeout(r, DELAY));
      return [offSheetForDate(DATE, [offCaddy.name])];
    });
    const drainStart = Date.now();
    const first = await persistOne(
      seeded.draft,
      [...seeded.pool, offCaddy],
      seeded.version,
      SICK_A,
      "cold-a"
    );
    const second = await persistOne(
      first.painted,
      [...seeded.pool, offCaddy],
      Number(first.version),
      SICK_B,
      "cold-b"
    );
    rows.push({
      scenario: "cold-sequential-5s",
      drainMs: Date.now() - drainStart,
      http: getOffSheetHttpFetchCount(),
      first: publicTiming(first),
      second: publicTiming(second),
      versions: [seeded.version, first.version, second.version],
    });
  }

  {
    const seeded = await seedBoard();
    invalidateOffSheetCache();
    resetOffSheetHttpStatsForTests();
    seedOffSheetCacheForTests([offSheetForDate(DATE, [offCaddy.name])]);
    setPublishedOffSheetLoaderForTests(async () => {
      throw new Error("warm must not HTTP");
    });
    const drainStart = Date.now();
    const first = await persistOne(
      seeded.draft,
      [...seeded.pool, offCaddy],
      seeded.version,
      SICK_A,
      "warm-a"
    );
    const second = await persistOne(
      first.painted,
      [...seeded.pool, offCaddy],
      Number(first.version),
      SICK_B,
      "warm-b"
    );
    rows.push({
      scenario: "warm-sequential",
      drainMs: Date.now() - drainStart,
      http: getOffSheetHttpFetchCount(),
      first: publicTiming(first),
      second: publicTiming(second),
      versions: [seeded.version, first.version, second.version],
    });
  }

  setPublishedOffSheetLoaderForTests(null);
  invalidateOffSheetCache();
  await prisma.$disconnect();
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  setPublishedOffSheetLoaderForTests(null);
  await prisma.$disconnect();
  process.exit(1);
});
