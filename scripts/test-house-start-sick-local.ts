/**
 * Local-only: persist SICK of houseStart after full-HOUSE seed.
 * Asserts pull-forward, not 1조 reset. caddy_local only.
 */
import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  assignmentDraftToPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { getDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import { applyQuickBoardMutation } from "../src/lib/quickBoardMutationApply";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
} from "../src/lib/boardMutationPipeline";
import { resolveCanonicalLivePool } from "../src/lib/opsDutyLivePool";
import { snapshotComputePoolFromDraft } from "../src/lib/assignmentDraft";
import {
  getOffSheetHttpFetchCount,
  invalidateOffSheetCache,
  resetOffSheetHttpStatsForTests,
  setPublishedOffSheetLoaderForTests,
} from "../src/lib/offSheetFetch";
import type { OffSheet } from "../src/lib/offSheetParser";

const DATE = "2026-09-15";
const SICK_ID = 13;
const OFF_NAME = "손지연";
const RESET_NAME = "이영진";

function offSheet(): OffSheet {
  return {
    name: "0915",
    matrix: [
      ["2026.09.15 (화)", "", ""],
      ["1조", "2조", "3조"],
      [OFF_NAME, "", ""],
    ],
  };
}

async function main() {
  invalidateOffSheetCache();
  resetOffSheetHttpStatsForTests();
  setPublishedOffSheetLoaderForTests(async () => [offSheet()]);
  const stored = await getDailyBoardDraft(DATE);
  if (!stored) throw new Error("no draft");
  const draft = payloadToAssignmentDraft(stored.payload as never);
  const firstBefore = draft.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)[0];
  if (firstBefore?.caddy.id !== SICK_ID) {
    throw new Error(`expected house start 서승희, got ${firstBefore?.caddy.name}`);
  }
  const clientPool = snapshotComputePoolFromDraft(draft, null);
  const canonical = await resolveCanonicalLivePool(DATE, clientPool, {
    offSheetMode: "cache-or-fetch",
    rosterClientPool: draft.caddyPool,
    computeClientPool: clientPool,
  });
  const intent = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: SICK_ID, shift: "1부" },
    "local-house-start"
  )!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: draft,
    intent,
    regularCaddyPool: canonical.computePool,
  });
  if (!prepared.ok) throw new Error(prepared.message);
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
      expectedVersion: stored.version,
      payload: assignmentDraftToPayload(prepared.painted),
    },
    updatedByUserId: null,
  });
  if (!persist.ok) throw new Error(persist.message);
  const row = await getDailyBoardDraft(DATE);
  const next = payloadToAssignmentDraft(row!.payload as never);
  const names = next.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((a) => a.caddy.name);
  const used = [
    ...next.assignments.map((a) => a.caddy.name),
    ...(next.sparesByShift || []).flatMap((s) => [s.spare1?.name, s.spare2?.name]),
  ];
  console.log("1부 after", names);
  console.log("http", getOffSheetHttpFetchCount());
  if (names[0] === RESET_NAME) throw new Error("1조 reset");
  if (names.includes("서승희")) throw new Error("victim still placed");
  if (used.includes(OFF_NAME)) throw new Error("OFF resurrected");
  if (names[0] !== "김지운") throw new Error(`expected 김지운 first, got ${names[0]}`);
  const day = parseYmd(DATE).start;
  const unavail = await prisma.dailyCaddyUnavailable.findMany({ where: { date: day } });
  if (!unavail.some((u) => u.caddyId === SICK_ID)) throw new Error("unavailable missing");
  console.log("PASS house-start persist pull-forward");
  setPublishedOffSheetLoaderForTests(null);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
