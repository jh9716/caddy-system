/**
 * SICK must pull the existing HOUSE sequence forward one slot.
 * Never re-sort by team order / extraUsable availability.
 * 실행: npx tsx scripts/test-sick-house-order-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeAutoAssignmentsV1, type AutoAssignCaddy } from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  confirmedDraftKeepingPlacedUnavailable,
  createDraftFromAutoResult,
  snapshotComputePoolFromDraft,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { previewLiveChangeFromDraft, type LiveChangeInput } from "../src/lib/assignmentChange";
import { parseDailyBoardDraftPayload, payloadToAssignmentDraft } from "../src/lib/dailyBoardDraft";
import { compareCaddyOrder } from "../src/lib/autoAssignEngine";
import {
  overlayUnavailableIdsKeepingPlaced,
  placedCaddyIdsFromBoard,
  snapshotComputePool,
} from "../src/lib/caddyPoolCanonical";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
  projectEnqueuedIntents,
  projectPendingIntents,
} from "../src/lib/boardMutationPipeline";

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

function house(id: number, name: string, teamOrder: number, team = "1조"): AutoAssignCaddy {
  return {
    id,
    name,
    team,
    teamOrder,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function regularNames(assignments: Array<{ shift?: string; kind?: string; caddy: AutoAssignCaddy; reservation?: { shift?: string } }>, shift: string) {
  return assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === shift &&
        row.kind === "regular" &&
        (row.caddy.caddyType || "HOUSE") === "HOUSE"
    )
    .map((row) => row.caddy.name);
}

function regularIds(assignments: Array<{ shift?: string; kind?: string; sequenceIndex?: number; caddy: AutoAssignCaddy; reservation?: { shift?: string } }>, shift: string) {
  return assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === shift &&
        row.kind === "regular" &&
        (row.caddy.caddyType || "HOUSE") === "HOUSE"
    )
    .sort((a, b) => (a.sequenceIndex || 0) - (b.sequenceIndex || 0))
    .map((row) => row.caddy.id);
}

function spareNames(spares: Array<{ shift: string; spare1?: { name?: string } | null; spare2?: { name?: string } | null }>, shift: string) {
  const row = spares.find((s) => s.shift === shift);
  return [row?.spare1?.name || null, row?.spare2?.name || null] as const;
}

function spareIds(spares: Array<{ shift: string; spare1?: { caddyId?: number } | null; spare2?: { caddyId?: number } | null }>, shift: string) {
  const row = spares.find((s) => s.shift === shift);
  return [row?.spare1?.caddyId || null, row?.spare2?.caddyId || null] as const;
}

/** 1·2부 투대기 1부 SICK: 2부 = victim 결원 + 1부 소비분 → 시작 cursor 1칸. */
function dualShift2After1Consume(
  before2: number[],
  victim: number,
  spare1: number | null,
  spare2: number | null
) {
  const without = before2.filter((id) => id !== victim);
  return [...without.slice(1), spare1, spare2].filter(
    (id): id is number => typeof id === "number"
  );
}

/** Same function /manage/assignments enqueuePipelineMutation uses after confirm. */
function uiHydrateAndEnqueueSick(input: {
  payloadDraft: AssignmentDraft;
  liveUnavailableIds: number[];
  extraUsable: AutoAssignCaddy[];
  change: LiveChangeInput;
  id: string;
}) {
  const incoming: AssignmentDraft = {
    ...input.payloadDraft,
    unavailableCaddyIds: input.liveUnavailableIds,
  };
  const confirmed = confirmedDraftKeepingPlacedUnavailable(incoming);
  const click = projectEnqueuedIntents({
    confirmedDraft: confirmed,
    pending: [makeMutationIntent(input.change, input.id)!],
    extraUsable: input.extraUsable,
    liveUnavailableIds: input.liveUnavailableIds,
  });
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent: makeMutationIntent(input.change, `${input.id}-persist`)!,
    regularCaddyPool: click.regularCaddyPool,
  });
  return {
    incoming,
    confirmed,
    computePool: click.regularCaddyPool,
    click,
    prepared,
  };
}

section("golden A→B→C→D→E→S1→S2→X, B 병가");
{
  const A = house(1, "A", 0);
  const B = house(2, "B", 1);
  const C = house(3, "C", 2);
  const D = house(4, "D", 3);
  const E = house(5, "E", 4);
  const S1 = house(6, "S1", 5);
  const S2 = house(7, "S2", 6);
  const X = house(8, "X", 7);
  const pool = [A, B, C, D, E, S1, S2, X];
  const result = computeAutoAssignmentsV1({
    date: "2099-12-21",
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: A.id,
    reservations: [
      { date: "2099-12-21", course: "VERTHILL", shift: "1부", teeTime: "07:00", teamName: "T1", rawRowIndex: 1, sourceSheet: "예약1부" },
      { date: "2099-12-21", course: "SKY", shift: "1부", teeTime: "07:00", teamName: "T2", rawRowIndex: 2, sourceSheet: "예약1부" },
      { date: "2099-12-21", course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "T3", rawRowIndex: 3, sourceSheet: "예약1부" },
      { date: "2099-12-21", course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "T4", rawRowIndex: 4, sourceSheet: "예약1부" },
      { date: "2099-12-21", course: "VERTHILL", shift: "1부", teeTime: "07:08", teamName: "T5", rawRowIndex: 5, sourceSheet: "예약1부" },
    ],
  });
  const draft = createDraftFromAutoResult(result, pool);
  const before = regularNames(draft.assignments, "1부");
  assert(before.join("→") === "A→B→C→D→E", `before HOUSE ${before.join("→")}`);
  const [bS1, bS2] = spareNames(draft.sparesByShift, "1부");
  assert(bS1 === "S1" && bS2 === "S2", `before spare ${bS1}/${bS2}`);
  // Scramble teamOrder so a team-sort rebuild would not keep A→C→D→E→S1.
  const scrambledMeta: Record<number, { team: string; teamOrder: number }> = {
    [A.id]: { team: "8조", teamOrder: 90 },
    [B.id]: { team: "1조", teamOrder: 1 },
    [C.id]: { team: "7조", teamOrder: 2 },
    [D.id]: { team: "3조", teamOrder: 40 },
    [E.id]: { team: "2조", teamOrder: 3 },
    [S1.id]: { team: "5조", teamOrder: 8 },
    [S2.id]: { team: "4조", teamOrder: 4 },
    [X.id]: { team: "6조", teamOrder: 7 },
  };
  const applyScramble = (caddy: AutoAssignCaddy) => {
    const meta = scrambledMeta[caddy.id];
    if (!meta) return caddy;
    caddy.team = meta.team;
    caddy.teamOrder = meta.teamOrder;
    return caddy;
  };
  for (const row of draft.assignments) applyScramble(row.caddy);
  for (const caddy of draft.caddyPool) applyScramble(caddy);
  const extraUsable = [B, D, A, X, C, S2, E, S1].map((caddy) =>
    applyScramble({ ...caddy })
  );
  const compute = snapshotComputePoolFromDraft(draft, result, { extraUsable });
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: B.id, shift: "1부" },
    regularCaddyPool: compute,
  });
  const after = regularNames(preview.after.assignments, "1부");
  const [aS1, aS2] = spareNames(preview.after.sparesByShift, "1부");
  assert(after.join("→") === "A→C→D→E→S1", `after HOUSE ${after.join("→")}`);
  assert(aS1 === "S2" && aS2 === "X", `after spare ${aS1}/${aS2}`);
  assert(after[0] === "A", "A보다 앞선 정상 캐디 순서 변경 금지");
  assert(after.slice(1).join("→") === "C→D→E→S1", "B 이후 정상 캐디 상대 순서 유지");
  assert(!after.includes("B"), "병가 대상 제거");
  assert(after[0] === "A", "다른 조 첫 순번으로 reset 금지");
}

section("production-like 2026-08-28 anonymous Draft + extraUsable 93");
{
  // Original names (anonymized in fixture): 112 최루비, 190 강보미, 113 이연호,
  // 191 정윤지, 146 김현정1, 141 안한빛, 152 남궁정호, 94 김수현, 106 박솔.
  const VICTIM = 112;
  const NEXT1 = 190;
  const NEXT2 = 113;
  const SKIP_TO = 191;
  const SPARE1 = 146;
  const SPARE2 = 141;
  const NEXT_UNUSED = 152;
  const BAD_SPARE1 = 94;
  const BAD_SPARE2 = 106;
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/prod-2026-08-28-choi-sick.json"), "utf8")
  );
  const parsed = parseDailyBoardDraftPayload({ ...raw, schemaVersion: 1 }, "2026-08-28");
  const draft = payloadToAssignmentDraft(parsed);
  const before1 = regularIds(draft.assignments, "1부");
  const [bS1, bS2] = spareIds(draft.sparesByShift, "1부");
  assert(before1[0] === VICTIM, "draft starts at victim");
  assert(bS1 === SPARE1 && bS2 === SPARE2, `draft spare ${bS1}/${bS2}`);
  const sick = new Set([14, 192, 113, 40, 193, 15, 277, 12, 9, 51, 56, 235]);
  const used = new Set<number>();
  for (const row of draft.assignments) {
    if (row.kind === "regular") used.add(row.caddy.id);
  }
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) used.add(s.spare1.caddyId);
    if (s.spare2?.caddyId) used.add(s.spare2.caddyId);
  }
  const extraUsable = draft.caddyPool
    .filter(
      (c) => (c.caddyType || "HOUSE") === "HOUSE" && used.has(c.id) && !sick.has(c.id)
    )
    .sort(compareCaddyOrder);
  assert(extraUsable.length === 93, `extraUsable 93 (got ${extraUsable.length})`);
  const compute = snapshotComputePoolFromDraft(draft, null, { extraUsable });
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" },
    regularCaddyPool: compute,
  });
  const after1 = regularIds(preview.after.assignments, "1부");
  const after2 = regularIds(preview.after.assignments, "2부");
  const after3 = regularIds(preview.after.assignments, "3부");
  const [aS1, aS2] = spareIds(preview.after.sparesByShift, "1부");
  const [a3s1, a3s2] = spareIds(preview.after.sparesByShift, "3부");
  assert(after1[0] === NEXT1, `1부 first ${after1[0]}`);
  assert(after1[1] === NEXT2, `1부 second ${after1[1]} (keep relative, do not skip to ${SKIP_TO})`);
  assert(!after1.includes(VICTIM), "victim removed from 1부");
  assert(after1[after1.length - 1] === SPARE1, `1부 last pulled spare1 ${after1[after1.length - 1]}`);
  assert(aS1 === SPARE2 && aS2 === NEXT_UNUSED, `1부 spare ${aS1}/${aS2}`);
  assert(aS1 !== BAD_SPARE1 && aS2 !== BAD_SPARE2, "availability team-sort spare 94/106 금지");
  const before2 = regularIds(draft.assignments, "2부");
  const [b2s1, b2s2] = spareIds(draft.sparesByShift, "2부");
  const expected2 = dualShift2After1Consume(before2, VICTIM, b2s1, b2s2);
  assert(after2.join(",") === expected2.join(","), `2부 1부-consume+결원 2칸 ${after2.slice(0, 3)}`);
  assert(after2[0] === NEXT2, `2부 first ${after2[0]} (start cursor +1 after 1부 consume)`);
  assert(!after2.includes(VICTIM), "victim removed from 2부");
  const before3 = regularIds(draft.assignments, "3부");
  const leftover3 = [157, 149, 143, 144, 148, 204, 153, 142];
  assert(after3.join(",") === leftover3.join(","), `3부 HOUSE leftover ${after3.join(",")}`);
  assert(after3.join(",") !== before3.join(","), "3부 HOUSE leftover is not pre-SICK freeze");
  assert(a3s1 === 96 && a3s2 === 94, `3부 HOUSE spare leftover ${a3s1}/${a3s2}`);
  const thirdBefore = draft.assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === "3부" &&
        !(row.kind === "regular" && (row.caddy.caddyType || "HOUSE") === "HOUSE")
    )
    .map((row) => row.caddy.id);
  const thirdAfter = preview.after.assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === "3부" &&
        !(row.kind === "regular" && (row.caddy.caddyType || "HOUSE") === "HOUSE")
    )
    .map((row) => row.caddy.id);
  assert(thirdAfter.join(",") === thirdBefore.join(","), "3부 1·3/THIRD identity kept");
}

section("production-like 정윤지 191 dual 1·2 SICK fingerprints");
{
  const VICTIM = 191;
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/prod-2026-08-28-choi-sick.json"), "utf8")
  );
  const parsed = parseDailyBoardDraftPayload({ ...raw, schemaVersion: 1 }, "2026-08-28");
  const draft = payloadToAssignmentDraft(parsed);
  const sick = new Set([14, 192, 113, 40, 193, 15, 277, 12, 9, 51, 56, 235]);
  const used = new Set<number>();
  for (const row of draft.assignments) {
    if (row.kind === "regular") used.add(row.caddy.id);
  }
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) used.add(s.spare1.caddyId);
    if (s.spare2?.caddyId) used.add(s.spare2.caddyId);
  }
  const extraUsable = draft.caddyPool
    .filter(
      (c) => (c.caddyType || "HOUSE") === "HOUSE" && used.has(c.id) && !sick.has(c.id)
    )
    .sort(compareCaddyOrder);
  const ui = uiHydrateAndEnqueueSick({
    payloadDraft: draft,
    liveUnavailableIds: [...sick],
    extraUsable,
    change: { type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" },
    id: "jung",
  });
  assert(ui.prepared.ok, "정윤지 prepare ok");
  const persistDraft = applyLiveResultToDraft(
    ui.confirmed,
    ui.prepared.ok ? ui.prepared.preview.after : ui.click.draft
  );
  const serverPreview = previewLiveChangeFromDraft({
    draft: ui.confirmed,
    change: { type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" },
    regularCaddyPool: ui.computePool,
  });
  const stageFp = (d: AssignmentDraft) => ({
    "1부": regularIds(d.assignments, "1부"),
    "2부": regularIds(d.assignments, "2부"),
    "3부": regularIds(d.assignments, "3부"),
    spare: {
      "1부": spareIds(d.sparesByShift, "1부"),
      "2부": spareIds(d.sparesByShift, "2부"),
      "3부": spareIds(d.sparesByShift, "3부"),
    },
  });
  const before = stageFp(draft);
  const click = stageFp(ui.click.draft);
  const server = stageFp(applyLiveResultToDraft(ui.confirmed, serverPreview.after));
  const persist = stageFp(persistDraft);
  const expected2 = dualShift2After1Consume(
    before["2부"],
    VICTIM,
    before.spare["2부"][0],
    before.spare["2부"][1]
  );
  assert(before["1부"].includes(VICTIM) && before["2부"].includes(VICTIM), "정윤지 1·2 투대기");
  assert(!click["1부"].includes(VICTIM) && !click["2부"].includes(VICTIM), "click removes 정윤지");
  assert(click["2부"].join(",") === expected2.join(","), "정윤지 2부 2칸");
  assert(JSON.stringify(click) === JSON.stringify(server), "정윤지 click = server");
  assert(JSON.stringify(click) === JSON.stringify(persist), "정윤지 click = persist/reload");
  console.log(
    "  정윤지 fingerprint spare",
    JSON.stringify({
      before: before.spare,
      click: click.spare,
      server: server.spare,
      persist: persist.spare,
      "1부_head": { before: before["1부"].slice(0, 5), after: click["1부"].slice(0, 5) },
      "2부_head": { before: before["2부"].slice(0, 5), after: click["2부"].slice(0, 5) },
      "3부": { before: before["3부"], after: click["3부"] },
    })
  );
}

section("production v51 live SICK overlay: click = persist overlay, not 94/106");
{
  const VICTIM = 112;
  const SECOND = 190;
  const NEXT2 = 113;
  const SPARE1 = 146;
  const SPARE2 = 141;
  const NEXT_UNUSED = 152;
  const BAD_SPARE1 = 94;
  const BAD_SPARE2 = 106;
  const LIVE_SICK = [14, 192, 113, 40, 193, 15, 277, 12, 9, 51, 56, 235];
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/prod-2026-08-28-choi-sick.json"), "utf8")
  );
  const parsed = parseDailyBoardDraftPayload({ ...raw, schemaVersion: 1 }, "2026-08-28");
  const draft = payloadToAssignmentDraft(parsed);
  assert(!(draft.unavailableCaddyIds || []).length, "v51 unavailableCaddyIds=[]");
  const placed = placedCaddyIdsFromBoard(draft);
  for (const id of LIVE_SICK) {
    assert(placed.has(id), `live SICK ${id} still placed on v51 Draft`);
  }
  const used = new Set<number>();
  for (const row of draft.assignments) if (row.kind === "regular") used.add(row.caddy.id);
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) used.add(s.spare1.caddyId);
    if (s.spare2?.caddyId) used.add(s.spare2.caddyId);
  }
  const extraUsable = draft.caddyPool
    .filter(
      (c) => (c.caddyType || "HOUSE") === "HOUSE" && used.has(c.id) && !LIVE_SICK.includes(c.id)
    )
    .sort(compareCaddyOrder);
  const overlay = overlayUnavailableIdsKeepingPlaced({
    dailyUnavailableIds: LIVE_SICK,
    placedIds: placed,
  });
  assert(overlay.length === 0, `overlay drops still-placed live SICK (got ${overlay.join(",")})`);

  const [beforeS1, beforeS2] = spareIds(draft.sparesByShift, "1부");
  assert(beforeS1 === SPARE1 && beforeS2 === SPARE2, `before spare ${beforeS1}/${beforeS2}`);

  const badIncoming: AssignmentDraft = { ...draft, unavailableCaddyIds: LIVE_SICK };
  const badPool = snapshotComputePoolFromDraft(badIncoming, null, {
    extraUsable,
    unavailableIds: LIVE_SICK,
  });
  const badClick = projectPendingIntents({
    confirmedDraft: badIncoming,
    pending: [makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "bad")!],
    regularCaddyPool: badPool,
  });
  const [badS1, badS2] = spareIds(badClick.draft.sparesByShift, "1부");
  assert(
    badS1 === BAD_SPARE1 && badS2 === BAD_SPARE2,
    `unfiltered live 12 pool still 94/106 (${badS1}/${badS2})`
  );

  const ui = uiHydrateAndEnqueueSick({
    payloadDraft: draft,
    liveUnavailableIds: LIVE_SICK,
    extraUsable,
    change: { type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" },
    id: "click",
  });
  assert(ui.confirmed.unavailableCaddyIds?.length === 0, "hydrate overlay drops still-placed live SICK");
  const liveStillInClickPool = LIVE_SICK.filter((id) => ui.computePool.some((c) => c.id === id));
  assert(
    liveStillInClickPool.length === LIVE_SICK.length,
    `click pool keeps placed live SICK (${liveStillInClickPool.length}/${LIVE_SICK.length})`
  );

  const dirtyConfirmed: AssignmentDraft = { ...draft, unavailableCaddyIds: LIVE_SICK };
  const dirtyClick = projectEnqueuedIntents({
    confirmedDraft: dirtyConfirmed,
    pending: [makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "dirty")!],
    extraUsable,
    liveUnavailableIds: LIVE_SICK,
  });

  const persistPool = snapshotComputePool({
    rosterBaseline: draft.caddyPool,
    assigned: draft.assignments.map((row) => row.caddy),
    spareIds: placed,
    extraUsable: ui.computePool,
    unavailableIds: overlay,
  });
  const persistPrepared = ui.prepared;
  assert(persistPrepared.ok, "prepareIntentOnConfirmedDraft ok");
  if (!persistPrepared.ok) throw new Error(persistPrepared.message);
  const persistPreview = persistPrepared.preview;
  const persistDraft = applyLiveResultToDraft(ui.confirmed, persistPreview.after);
  const serverPreview = previewLiveChangeFromDraft({
    draft: ui.confirmed,
    change: { type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" },
    regularCaddyPool: persistPool,
  });
  const serverDraft = applyLiveResultToDraft(ui.confirmed, serverPreview.after);

  const click1 = regularIds(ui.click.draft.assignments, "1부");
  const dirty1 = regularIds(dirtyClick.draft.assignments, "1부");
  const persist1 = regularIds(persistDraft.assignments, "1부");
  const server1 = regularIds(serverDraft.assignments, "1부");
  const reload1 = regularIds(persistDraft.assignments, "1부");
  const [cS1, cS2] = spareIds(ui.click.draft.sparesByShift, "1부");
  const [dS1, dS2] = spareIds(dirtyClick.draft.sparesByShift, "1부");
  const [pS1, pS2] = spareIds(persistDraft.sparesByShift, "1부");
  const [svS1, svS2] = spareIds(serverDraft.sparesByShift, "1부");
  const before3 = regularIds(draft.assignments, "3부");
  const [c3s1, c3s2] = spareIds(ui.click.draft.sparesByShift, "3부");
  const [p3s1, p3s2] = spareIds(persistDraft.sparesByShift, "3부");
  const before2 = regularIds(draft.assignments, "2부");
  const click2 = regularIds(ui.click.draft.assignments, "2부");
  const persist2 = regularIds(persistDraft.assignments, "2부");
  const [b2s1, b2s2] = spareIds(draft.sparesByShift, "2부");
  const expected2 = dualShift2After1Consume(before2, VICTIM, b2s1, b2s2);

  assert(cS1 === SPARE2 && cS2 === NEXT_UNUSED, `click spare ${cS1}/${cS2}`);
  assert(dS1 === SPARE2 && dS2 === NEXT_UNUSED, `dirty-confirmed click spare ${dS1}/${dS2}`);
  assert(svS1 === SPARE2 && svS2 === NEXT_UNUSED, `server spare ${svS1}/${svS2}`);
  assert(pS1 === SPARE2 && pS2 === NEXT_UNUSED, `persist spare ${pS1}/${pS2}`);
  assert(cS1 !== BAD_SPARE1 && cS2 !== BAD_SPARE2, "94/106 FAIL gate");
  assert(dS1 !== BAD_SPARE1 && dS2 !== BAD_SPARE2, "dirty-confirmed 94/106 FAIL gate");
  assert(click1.join(",") === dirty1.join(","), "hydrate overlay click = dirty-confirmed click");
  assert(click1.join(",") === persist1.join(","), "click HOUSE 1부 = persist overlay");
  assert(click1.join(",") === server1.join(","), "click HOUSE 1부 = server overlay");
  assert(persist1.join(",") === reload1.join(","), "persist overlay = reload Draft");
  assert(cS1 === pS1 && cS2 === pS2 && cS1 === svS1 && cS2 === svS2, "click spare = server = persist spare");
  assert(click1[1] === NEXT2, "1부 keeps 이연호 relative order");
  assert(click1[click1.length - 1] === SPARE1, "1부 last is spare1 pull-forward");
  assert(LIVE_SICK.filter((id) => id !== VICTIM).every((id) => click1.includes(id) || !placed.has(id) || !regularIds(draft.assignments, "1부").includes(id)), "live SICK still on 1부 stay except victim");
  for (const id of LIVE_SICK) {
    if (regularIds(draft.assignments, "1부").includes(id)) {
      assert(click1.includes(id), `1부 still has placed live SICK ${id}`);
    }
  }
  assert(!click1.includes(VICTIM), "최루비 removed from 1부");
  assert(click2.join(",") === expected2.join(","), "2부 1부-consume+결원 2칸");
  assert(persist2.join(",") === expected2.join(","), "2부 persist matches click");
  const [c2s1, c2s2] = spareIds(ui.click.draft.sparesByShift, "2부");
  assert(c2s1 !== b2s1 && c2s1 !== b2s2, "2부 spare advanced 2 slots, not spare2→spare1");
  assert(c2s2 != null, "2부 spare2 filled");
  const leftover3 = [157, 149, 143, 144, 148, 204, 153, 142];
  const click3 = regularIds(ui.click.draft.assignments, "3부");
  const persist3 = regularIds(persistDraft.assignments, "3부");
  const server3 = regularIds(serverDraft.assignments, "3부");
  assert(click3.join(",") === leftover3.join(","), `click 3부 HOUSE leftover ${click3.join(",")}`);
  assert(persist3.join(",") === leftover3.join(","), "persist 3부 HOUSE leftover");
  assert(server3.join(",") === leftover3.join(","), "server 3부 HOUSE leftover");
  assert(click3.join(",") !== before3.join(","), "3부 HOUSE leftover is not pre-SICK freeze");
  assert(c3s1 === 96 && c3s2 === 94 && p3s1 === 96 && p3s2 === 94, `3부 HOUSE spare leftover ${c3s1}/${c3s2}`);
  const thirdBefore = draft.assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === "3부" &&
        !(row.kind === "regular" && (row.caddy.caddyType || "HOUSE") === "HOUSE")
    )
    .map((row) => row.caddy.id);
  const thirdClick = ui.click.draft.assignments
    .filter(
      (row) =>
        (row.reservation?.shift || row.shift) === "3부" &&
        !(row.kind === "regular" && (row.caddy.caddyType || "HOUSE") === "HOUSE")
    )
    .map((row) => row.caddy.id);
  assert(thirdClick.join(",") === thirdBefore.join(","), "click keeps 3부 1·3/THIRD identity");

  const afterFirst = persistDraft;
  const second = uiHydrateAndEnqueueSick({
    payloadDraft: afterFirst,
    liveUnavailableIds: [...LIVE_SICK, VICTIM],
    extraUsable,
    change: { type: "CADDY_SICK", caddyId: SECOND, shift: "1부" },
    id: "s2",
  });
  const a1 = regularIds(second.click.draft.assignments, "1부");
  const b1 = regularIds(afterFirst.assignments, "1부");
  const i = b1.indexOf(SECOND);
  const [s1] = spareIds(afterFirst.sparesByShift, "1부");
  assert(!a1.includes(VICTIM), "second click: first victim stays gone");
  assert(!a1.includes(SECOND), "second click: second victim gone");
  assert(a1.join(",") === [...b1.slice(0, i), ...b1.slice(i + 1), s1].join(","), "consecutive SICK is 1-slot only");
  for (const id of LIVE_SICK) {
    if (b1.includes(id)) assert(a1.includes(id), `second click did not mass-drop live SICK ${id}`);
  }
  const pendingTwo = projectEnqueuedIntents({
    confirmedDraft: ui.confirmed,
    pending: [
      makeMutationIntent({ type: "CADDY_SICK", caddyId: VICTIM, shift: "1부" }, "p1")!,
      makeMutationIntent({ type: "CADDY_SICK", caddyId: SECOND, shift: "1부" }, "p2")!,
    ],
    extraUsable,
    liveUnavailableIds: LIVE_SICK,
  });
  const two1 = regularIds(pendingTwo.draft.assignments, "1부");
  assert(!two1.includes(VICTIM) && !two1.includes(SECOND), "pending 2 SICK via enqueue projection");
  for (const id of LIVE_SICK) {
    if (regularIds(draft.assignments, "1부").includes(id)) {
      assert(two1.includes(id), `pending 2 SICK did not mass-drop live SICK ${id}`);
    }
  }
}

function shiftReservations(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  prefix: string
) {
  const hour = shift === "1부" ? 7 : shift === "2부" ? 12 : 16;
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  return Array.from({ length: count }, (_, i) => ({
    date,
    course: courses[i % 4],
    shift,
    teeTime: `${String(hour).padStart(2, "0")}:${String((i * 8) % 60).padStart(2, "0")}`,
    teamName: `${prefix}${i + 1}`,
    rawRowIndex: i + 1,
    sourceSheet: `예약${shift}`,
  }));
}

section("1·2부 투대기 1부 SICK: 2부 start +1부소비 + 결원 = 2칸");
{
  const date = "2099-12-22";
  const names = [
    "A",
    "B",
    "C",
    "정윤지",
    "D",
    "E",
    "조정혜",
    "장혜원",
    "지석준",
    "윤숙영",
    "지선영",
    "홍정자",
    "다음",
    "X",
  ];
  const pool = names.map((name, i) => house(300 + i, name, i));
  const V = pool[3];
  const r1 = shiftReservations(date, "1부", 6, "A");
  const r2 = shiftReservations(date, "2부", 9, "B");
  const r3 = shiftReservations(date, "3부", 2, "C");
  const s1 = computeAutoAssignmentsV1({
    date,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: pool[0].id,
    reservations: r1,
  });
  const s2 = computeAutoAssignmentsV1({
    date,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: pool[0].id,
    reservations: r2,
  });
  const s3 = computeAutoAssignmentsV1({
    date,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: pool[0].id,
    reservations: r3,
  });
  const previous = {
    ...s1,
    assignments: [
      ...s1.assignments.filter((row) => row.shift === "1부"),
      ...s2.assignments.filter((row) => row.shift === "2부"),
      ...s3.assignments.filter((row) => row.shift === "3부"),
    ],
    regularAssignments: [
      ...s1.regularAssignments.filter((row) => row.shift === "1부"),
      ...s2.regularAssignments.filter((row) => row.shift === "2부"),
      ...s3.regularAssignments.filter((row) => row.shift === "3부"),
    ],
    sparesByShift: [
      s1.sparesByShift.find((s) => s.shift === "1부")!,
      s2.sparesByShift.find((s) => s.shift === "2부")!,
      s3.sparesByShift.find((s) => s.shift === "3부")!,
    ],
  };
  const draft = createDraftFromAutoResult(previous, pool);
  const before1 = regularNames(draft.assignments, "1부");
  const before2 = regularNames(draft.assignments, "2부");
  const [b1s1, b1s2] = spareNames(draft.sparesByShift, "1부");
  const [b2s1, b2s2] = spareNames(draft.sparesByShift, "2부");
  assert(before1.join("→") === "A→B→C→정윤지→D→E", `before 1부 ${before1.join("→")}`);
  assert(
    before2.join("→") === "A→B→C→정윤지→D→E→조정혜→장혜원→지석준",
    `before 2부 ${before2.join("→")}`
  );
  assert(b1s1 === "조정혜" && b1s2 === "장혜원", `before 1부 spare ${b1s1}/${b1s2}`);
  assert(b2s1 === "윤숙영" && b2s2 === "지선영", `before 2부 spare ${b2s1}/${b2s2}`);
  const extraUsable = pool.filter((c) => c.id !== V.id);
  const compute = snapshotComputePoolFromDraft(draft, previous, { extraUsable });
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: V.id, shift: "1부" },
    regularCaddyPool: compute,
  });
  const after1 = regularNames(preview.after.assignments, "1부");
  const after2 = regularNames(preview.after.assignments, "2부");
  const [a1s1, a1s2] = spareNames(preview.after.sparesByShift, "1부");
  const [a2s1, a2s2] = spareNames(preview.after.sparesByShift, "2부");
  assert(after1.join("→") === "A→B→C→D→E→조정혜", `after 1부 ${after1.join("→")}`);
  assert(a1s1 === "장혜원" && a1s2 === "지석준", `after 1부 spare ${a1s1}/${a1s2}`);
  assert(
    after2.join("→") === "B→C→D→E→조정혜→장혜원→지석준→윤숙영→지선영",
    `after 2부 ${after2.join("→")}`
  );
  assert(a2s1 === "홍정자" && a2s2 === "다음", `after 2부 spare ${a2s1}/${a2s2}`);
  assert(!after2.includes("정윤지"), "2부 victim gone");
  assert(after2[0] === "B", "2부 start cursor +1 keeps relative tail");

  const only1Victim = pool.find((c) => c.name === "E")!;
  const only1Draft = createDraftFromAutoResult(
    {
      ...previous,
      assignments: previous.assignments.filter(
        (row) => !(row.shift === "2부" && row.caddy.id === only1Victim.id)
      ),
    },
    pool
  );
  const only1Before2 = regularNames(only1Draft.assignments, "2부");
  const only1Preview = previewLiveChangeFromDraft({
    draft: only1Draft,
    change: { type: "CADDY_SICK", caddyId: only1Victim.id, shift: "1부" },
    regularCaddyPool: snapshotComputePoolFromDraft(only1Draft, null, {
      extraUsable: pool.filter((c) => c.id !== only1Victim.id),
    }),
  });
  const only1After2 = regularNames(only1Preview.after.assignments, "2부");
  assert(
    only1After2.join("→") === only1Before2.join("→"),
    `단일 1부 병가 2부 identity ${only1After2.join("→")}`
  );

  const only2Victim = pool.find((c) => c.name === "장혜원")!;
  const only2Preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: only2Victim.id, shift: "2부" },
    regularCaddyPool: snapshotComputePoolFromDraft(draft, previous, {
      extraUsable: pool.filter((c) => c.id !== only2Victim.id),
    }),
  });
  const only2After1 = regularNames(only2Preview.after.assignments, "1부");
  const only2After2 = regularNames(only2Preview.after.assignments, "2부");
  const [o2s1, o2s2] = spareNames(only2Preview.after.sparesByShift, "2부");
  assert(only2After1.join("→") === before1.join("→"), "단일 2부 병가 1부 identity");
  assert(
    only2After2.join("→") === "A→B→C→정윤지→D→E→조정혜→지석준→윤숙영",
    `단일 2부 병가 1칸 ${only2After2.join("→")}`
  );
  assert(o2s1 === "지선영" && o2s2 === "홍정자", `단일 2부 spare ${o2s1}/${o2s2}`);

  const ui = uiHydrateAndEnqueueSick({
    payloadDraft: draft,
    liveUnavailableIds: [],
    extraUsable,
    change: { type: "CADDY_SICK", caddyId: V.id, shift: "1부" },
    id: "dual",
  });
  const persistDraft = applyLiveResultToDraft(ui.confirmed, ui.prepared.ok ? ui.prepared.preview.after : preview.after);
  const serverPreview = previewLiveChangeFromDraft({
    draft: ui.confirmed,
    change: { type: "CADDY_SICK", caddyId: V.id, shift: "1부" },
    regularCaddyPool: compute,
  });
  const serverDraft = applyLiveResultToDraft(ui.confirmed, serverPreview.after);
  const stages = {
    before: { "1부": before1, "2부": before2, spare1: [b1s1, b1s2], spare2: [b2s1, b2s2] },
    click: {
      "1부": regularNames(ui.click.draft.assignments, "1부"),
      "2부": regularNames(ui.click.draft.assignments, "2부"),
      spare1: spareNames(ui.click.draft.sparesByShift, "1부"),
      spare2: spareNames(ui.click.draft.sparesByShift, "2부"),
    },
    server: {
      "1부": regularNames(serverDraft.assignments, "1부"),
      "2부": regularNames(serverDraft.assignments, "2부"),
      spare1: spareNames(serverDraft.sparesByShift, "1부"),
      spare2: spareNames(serverDraft.sparesByShift, "2부"),
    },
    persist: {
      "1부": regularNames(persistDraft.assignments, "1부"),
      "2부": regularNames(persistDraft.assignments, "2부"),
      spare1: spareNames(persistDraft.sparesByShift, "1부"),
      spare2: spareNames(persistDraft.sparesByShift, "2부"),
    },
  };
  const reload = persistDraft;
  assert(
    JSON.stringify(stages.click) === JSON.stringify(stages.server),
    "click = server preview.after"
  );
  assert(
    JSON.stringify(stages.click) === JSON.stringify(stages.persist),
    "click = persist"
  );
  assert(
    regularNames(reload.assignments, "2부").join("→") === stages.persist["2부"].join("→"),
    "reload keeps 2부"
  );
  console.log(
    "  fingerprint",
    JSON.stringify({
      ...stages,
      reload: {
        "1부": regularNames(reload.assignments, "1부"),
        "2부": regularNames(reload.assignments, "2부"),
        spare1: spareNames(reload.sparesByShift, "1부"),
        spare2: spareNames(reload.sparesByShift, "2부"),
        "3부": regularNames(reload.assignments, "3부"),
        spare3: spareNames(reload.sparesByShift, "3부"),
      },
    })
  );
}

const fs = require("node:fs") as typeof import("node:fs");
const canonical = fs.readFileSync("src/lib/caddyPoolCanonical.ts", "utf8");
const page = fs.readFileSync("src/app/manage/assignments/page.tsx", "utf8");
const pipeline = fs.readFileSync("src/lib/boardMutationPipeline.ts", "utf8");
assert(
  !/return usableComputePool\(\{\s*rosterBaseline: extra/.test(canonical),
  "snapshotComputePool does not replace assigned order with extraUsable"
);
assert(
  /overlayUnavailableIdsKeepingPlaced/.test(canonical) && /!placed\.has\(id\)/.test(canonical),
  "click/persist overlay keeps still-placed HOUSE"
);
assert(
  /projectEnqueuedIntents\(/.test(page) &&
    /confirmedDraftKeepingPlacedUnavailable\(incoming\)/.test(page) &&
    /function liveSnapshotPool/.test(page),
  "UI hydrate+enqueue uses keeping-placed snapshot, not raw live unavailable"
);
assert(
  /export function projectEnqueuedIntents/.test(pipeline) &&
    /confirmedDraftKeepingPlacedUnavailable\(/.test(pipeline) &&
    /liveClickSnapshotPool\(/.test(pipeline),
  "enqueue projection overlays placed live SICK before reflow"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
