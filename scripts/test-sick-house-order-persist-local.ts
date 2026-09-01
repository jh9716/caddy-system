/**
 * Local-only: 최루비 SICK click / persist / reload fingerprints.
 * extraUsable 93 + live DailyCaddyUnavailable 12. caddy_local only.
 * 실행: npm run test:sick-house-order-persist-local
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public";

import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import { compareCaddyOrder, reservationKey, type AutoAssignCaddy } from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  snapshotComputePoolFromDraft,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { getDailyBoardDraft, saveDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import { applyQuickBoardMutation } from "../src/lib/quickBoardMutationApply";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
  projectPendingIntents,
} from "../src/lib/boardMutationPipeline";
import { resolveCanonicalLivePool } from "../src/lib/opsDutyLivePool";
import {
  invalidateOffSheetCache,
  resetOffSheetHttpStatsForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";

const DATE = "2026-08-28";
const day = parseYmd(DATE).start;
const VICTIM = 112;
const NEXT1 = 190;
const NEXT2 = 113;
const SPARE1 = 146;
const SPARE2 = 141;
const NEXT_UNUSED = 152;
const BAD1 = 94;
const BAD2 = 106;
const SECOND = 190;
const LIVE_SICK = [14, 192, 113, 40, 193, 15, 277, 12, 9, 51, 56, 235];

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

function regularIds(draft: AssignmentDraft, shift: string) {
  return draft.assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === shift &&
        row.kind === "regular" &&
        (row.caddy.caddyType || "HOUSE") === "HOUSE"
    )
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((row) => row.caddy.id);
}

function spareIds(draft: AssignmentDraft, shift: string) {
  const row = (draft.sparesByShift || []).find((s) => s.shift === shift);
  return [row?.spare1?.caddyId || null, row?.spare2?.caddyId || null] as const;
}

function fp(draft: AssignmentDraft) {
  return {
    "1부": regularIds(draft, "1부"),
    "2부": regularIds(draft, "2부"),
    "3부": regularIds(draft, "3부"),
    spare: {
      "1부": spareIds(draft, "1부"),
      "2부": spareIds(draft, "2부"),
      "3부": spareIds(draft, "3부"),
    },
    houseStartCaddyId: draft.houseStartCaddyId ?? null,
  };
}

function sameFp(a: ReturnType<typeof fp>, b: ReturnType<typeof fp>, label: string) {
  const eq = JSON.stringify(a) === JSON.stringify(b);
  assert(eq, label);
  if (!eq) {
    for (const shift of ["1부", "2부", "3부"] as const) {
      if (a[shift].join(",") !== b[shift].join(",")) {
        console.error(`    ${shift} a`, a[shift].slice(0, 5), "...", a[shift].slice(-3));
        console.error(`    ${shift} b`, b[shift].slice(0, 5), "...", b[shift].slice(-3));
      }
      if (a.spare[shift].join("/") !== b.spare[shift].join("/")) {
        console.error(`    ${shift} spare a`, a.spare[shift], "b", b.spare[shift]);
      }
    }
  }
  return eq;
}

function expectPullForward(before: AssignmentDraft, after: AssignmentDraft, victim: number) {
  const b1 = regularIds(before, "1부");
  const a1 = regularIds(after, "1부");
  const [bs1, bs2] = spareIds(before, "1부");
  const [as1, as2] = spareIds(after, "1부");
  const idx = b1.indexOf(victim);
  const expected1 = [...b1.slice(0, idx), ...b1.slice(idx + 1), bs1].filter(
    (id): id is number => typeof id === "number"
  );
  assert(!a1.includes(victim), "1부 victim removed");
  assert(a1.join(",") === expected1.join(","), `1부 pull-forward ${a1.slice(0, 3)} last=${a1.at(-1)}`);
  assert(as1 === bs2, `spare2→spare1 ${as1}`);
  assert(a1[0] === NEXT1, `1부 first ${a1[0]}`);
  assert(a1[1] === NEXT2, `1부 second stays ${a1[1]} (not skip to 191)`);
  assert(as1 !== BAD1 && as2 !== BAD2, "not 김수현/박솔 team-sort jump");
  const b2 = regularIds(before, "2부");
  const a2 = regularIds(after, "2부");
  if (b2.includes(victim)) {
    const i2 = b2.indexOf(victim);
    const [s1, s2] = spareIds(before, "2부");
    const expected2 = [...b2.slice(0, i2), ...b2.slice(i2 + 1), s1].filter(
      (id): id is number => typeof id === "number"
    );
    assert(a2.join(",") === expected2.join(","), "2부 pull-forward");
    assert(spareIds(after, "2부")[0] === s2, "2부 spare2→spare1");
  }
  assert(
    regularIds(after, "3부").join(",") === regularIds(before, "3부").join(",") &&
      spareIds(after, "3부").join("/") === spareIds(before, "3부").join("/"),
    "3부 frozen"
  );
}

async function resetDate() {
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
}

async function ensureCaddies(pool: AutoAssignCaddy[]) {
  const ids = [...new Set(pool.map((c) => c.id).filter((id) => id > 0))];
  const existing = await prisma.caddy.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const have = new Set(existing.map((c) => c.id));
  const missing = pool.filter((c) => !have.has(c.id));
  if (missing.length) {
    await prisma.caddy.createMany({
      data: missing.map((c) => ({
        id: c.id,
        name: c.name || `caddy-${c.id}`,
        team: c.team || "1조",
        teamOrder: c.teamOrder || 0,
        caddyType: (c.caddyType as "HOUSE" | "DRIVING" | "THIRD") || "HOUSE",
        employmentStatus: "ACTIVE" as const,
      })),
      skipDuplicates: true,
    });
  }
  console.log(`  caddies existing=${have.size} created=${missing.length}`);
}

async function seedDraft(draft: AssignmentDraft) {
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
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
  });
  return saved.version;
}

async function main() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/prod-2026-08-28-choi-sick.json"), "utf8")
  );
  const parsed = parseDailyBoardDraftPayload({ ...raw, schemaVersion: 1 }, DATE);
  const draft0 = payloadToAssignmentDraft(parsed);

  const used = new Set<number>();
  for (const row of draft0.assignments) if (row.kind === "regular") used.add(row.caddy.id);
  for (const s of draft0.sparesByShift || []) {
    if (s.spare1?.caddyId) used.add(s.spare1.caddyId);
    if (s.spare2?.caddyId) used.add(s.spare2.caddyId);
  }
  const extraUsable = draft0.caddyPool
    .filter((c) => (c.caddyType || "HOUSE") === "HOUSE" && used.has(c.id) && !LIVE_SICK.includes(c.id))
    .sort(compareCaddyOrder);
  const clickPool = snapshotComputePoolFromDraft(draft0, null, { extraUsable });

  invalidateOffSheetCache();
  resetOffSheetHttpStatsForTests();
  setPublishedOffSheetLoaderForTests(async () => [
    {
      name: "0828",
      matrix: [
        ["2026.08.28 (금)", "", ""],
        ["1조", "2조", "3조"],
        ["", "", ""],
      ],
    },
  ]);

  await resetDate();
  await ensureCaddies(draft0.caddyPool);
  for (const id of LIVE_SICK) {
    const exists = await prisma.caddy.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      await prisma.caddy.create({
        data: { id, name: `caddy-${id}`, team: "1조", teamOrder: 0, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
      });
    }
  }
  await prisma.dailyCaddyUnavailable.createMany({
    data: LIVE_SICK.map((caddyId) => ({ date: day, caddyId, reason: "SICK" as const })),
  });
  let version = await seedDraft(draft0);

  console.log("\n== click optimistic ==");
  const click = projectPendingIntents({
    confirmedDraft: draft0,
    pending: [makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "click")!],
    regularCaddyPool: clickPool,
  });
  expectPullForward(draft0, click.draft, VICTIM);
  const clickFp = fp(click.draft);
  assert(clickFp.spare["1부"][0] === SPARE2 && clickFp.spare["1부"][1] === NEXT_UNUSED, `click spare ${clickFp.spare["1부"]}`);

  console.log("\n== persist skipCanonical + click pool / live 12 sick overlay ==");
  const intent = makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "persist")!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: draft0,
    intent,
    regularCaddyPool: clickPool,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  const persist = await applyQuickBoardMutation({
    previous: prepared.previous,
    regularCaddyPool: clickPool,
    events: prepared.preview.events,
    changeType: prepared.preview.changeType,
    canonical: {
      computePool: clickPool,
      rosterBaseline: draft0.caddyPool,
      unavailableIds: LIVE_SICK,
      opsDutyIds: [],
      specialSkipIds: [],
      offSheetMatched: true,
      offSheetSource: "cache",
    },
    skipCanonicalReload: true,
    draft: {
      date: DATE,
      expectedVersion: version,
      payload: assignmentDraftToPayload(prepared.painted),
    },
    updatedByUserId: null,
  });
  assert(persist.ok === true, `persist ok ${"ok" in persist && persist.ok ? persist.changeId : (persist as { message?: string }).message}`);
  if (!persist.ok) {
    console.log(`DONE: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  version = persist.draft.version;
  const persistDraft = applyLiveResultToDraft(draft0, persist.preview.after);
  const persistFp = fp(persistDraft);
  sameFp(clickFp, persistFp, "click vs persist preview.after");

  console.log("\n== reload ==");
  const row = await getDailyBoardDraft(DATE);
  const reloaded = payloadToAssignmentDraft(row!.payload as never);
  const reloadFp = fp(reloaded);
  sameFp(clickFp, reloadFp, "click vs reload Draft");
  sameFp(persistFp, reloadFp, "persist vs reload Draft");
  expectPullForward(draft0, reloaded, VICTIM);
  assert(!regularIds(reloaded, "1부").includes(VICTIM), "reload: 최루비 gone");
  assert(!regularIds(reloaded, "2부").includes(VICTIM), "reload: 최루비 gone 2부");

  console.log("\n== server resolveCanonicalLivePool persist path ==");
  await resetDate();
  await prisma.dailyCaddyUnavailable.createMany({
    data: LIVE_SICK.map((caddyId) => ({ date: day, caddyId, reason: "SICK" as const })),
  });
  version = await seedDraft(draft0);
  let canonicalMs = 0;
  try {
    const t0 = Date.now();
    const canonical = await resolveCanonicalLivePool(DATE, clickPool, {
      offSheetMode: "cache-or-fetch",
      rosterClientPool: draft0.caddyPool,
      computeClientPool: clickPool,
    });
    canonicalMs = Date.now() - t0;
    console.log(`  canonical compute=${canonical.computePool.length} unavail=${canonical.unavailableIds.length} off=${canonical.offSheetSource} matched=${canonical.offSheetMatched} ${canonicalMs}ms`);
    const prepared2 = prepareIntentOnConfirmedDraft({
      confirmedDraft: draft0,
      intent: makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "p2")!,
      regularCaddyPool: canonical.computePool,
    });
    if (!prepared2.ok) throw new Error(prepared2.message);
    const persist2 = await applyQuickBoardMutation({
      previous: prepared2.previous,
      regularCaddyPool: canonical.computePool,
      canonical,
      skipCanonicalReload: true,
      events: prepared2.preview.events,
      changeType: prepared2.preview.changeType,
      draft: {
        date: DATE,
        expectedVersion: version,
        payload: assignmentDraftToPayload(prepared2.painted),
      },
      updatedByUserId: null,
    });
    assert(persist2.ok === true, "canonical persist ok");
    if (persist2.ok) {
      const after2 = applyLiveResultToDraft(draft0, persist2.preview.after);
      sameFp(clickFp, fp(after2), "click vs resolveCanonical persist");
      const reload2 = payloadToAssignmentDraft((await getDailyBoardDraft(DATE))!.payload as never);
      sameFp(clickFp, fp(reload2), "click vs resolveCanonical reload");
    }
  } catch (e) {
    console.error("  canonical path error", e instanceof Error ? e.message : e);
    failed++;
  }

  console.log("\n== consecutive second SICK ==");
  const afterFirst = payloadToAssignmentDraft((await getDailyBoardDraft(DATE))!.payload as never);
  const v2 = (await getDailyBoardDraft(DATE))!.version;
  const pool2 = snapshotComputePoolFromDraft(afterFirst, null, { extraUsable });
  const click2 = projectPendingIntents({
    confirmedDraft: afterFirst,
    pending: [makeMutationIntent({ type: "CADDY_SICK", caddyId: SECOND, shift: "1부" }, "s2")!],
    regularCaddyPool: pool2,
  });
  assert(!regularIds(click2.draft, "1부").includes(VICTIM), "second click: first victim stays gone");
  assert(!regularIds(click2.draft, "1부").includes(SECOND), "second click: second victim gone");
  const prepared3 = prepareIntentOnConfirmedDraft({
    confirmedDraft: afterFirst,
    intent: makeMutationIntent({ type: "CADDY_SICK", caddyId: SECOND, shift: "1부" }, "s2p")!,
    regularCaddyPool: pool2,
  });
  if (!prepared3.ok) throw new Error(prepared3.message);
  const persist3 = await applyQuickBoardMutation({
    previous: prepared3.previous,
    regularCaddyPool: pool2,
    events: prepared3.preview.events,
    changeType: prepared3.preview.changeType,
    skipCanonicalReload: true,
    canonical: {
      computePool: pool2,
      rosterBaseline: afterFirst.caddyPool,
      unavailableIds: [...LIVE_SICK, VICTIM],
      opsDutyIds: [],
      specialSkipIds: [],
      offSheetMatched: true,
      offSheetSource: "cache",
    },
    draft: {
      date: DATE,
      expectedVersion: v2,
      payload: assignmentDraftToPayload(prepared3.painted),
    },
    updatedByUserId: null,
  });
  assert(persist3.ok === true, "second persist ok");
  if (persist3.ok) {
    const after3 = applyLiveResultToDraft(afterFirst, persist3.preview.after);
    sameFp(fp(click2.draft), fp(after3), "second click vs persist");
    const reload3 = payloadToAssignmentDraft((await getDailyBoardDraft(DATE))!.payload as never);
    sameFp(fp(click2.draft), fp(reload3), "second click vs reload");
    assert(!regularIds(reload3, "1부").includes(VICTIM), "reload: first victim not resurrected");
    assert(!regularIds(reload3, "1부").includes(SECOND), "reload: second victim gone");
    const b1 = regularIds(afterFirst, "1부");
    const a1 = regularIds(reload3, "1부");
    const i = b1.indexOf(SECOND);
    const [s1] = spareIds(afterFirst, "1부");
    const expected = [...b1.slice(0, i), ...b1.slice(i + 1), s1];
    assert(a1.join(",") === expected.join(","), "second sick is 1-slot pull-forward not full re-sort");
  }

  await resetDate();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
