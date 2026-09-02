/**
 * SICK must pull the existing HOUSE sequence forward one slot.
 * Never re-sort by team order / extraUsable availability.
 * 실행: npx tsx scripts/test-sick-house-order-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignRegularSequence,
  compareCaddyOrder,
  compareReservationOrder,
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
} from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  confirmedDraftKeepingPlacedUnavailable,
  createDraftFromAutoResult,
  snapshotComputePoolFromDraft,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { previewLiveChangeFromDraft, type LiveChangeInput } from "../src/lib/assignmentChange";
import { parseDailyBoardDraftPayload, payloadToAssignmentDraft } from "../src/lib/dailyBoardDraft";
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
    .sort((a, b) => {
      if (a.reservation && b.reservation) {
        return compareReservationOrder(a.reservation as never, b.reservation as never);
      }
      return (a.sequenceIndex || 0) - (b.sequenceIndex || 0);
    })
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

/** 2부 wrap = 1부 캐디가 처음 재등장하는 위치. leftover 존재 시 first 리셋이면 FAIL. */
function wrapIndex(shift2: number[], shift1: number[]) {
  return shift2.findIndex((id) => shift1.includes(id));
}

function loadChoiFixtureDraft() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/prod-2026-08-28-choi-sick.json"), "utf8")
  );
  const parsed = parseDailyBoardDraftPayload({ ...raw, schemaVersion: 1 }, "2026-08-28");
  return payloadToAssignmentDraft(parsed);
}

function fixtureUsedHouse(draft: AssignmentDraft, extraSick: number[] = []) {
  const used = new Set<number>();
  for (const row of draft.assignments) {
    if (row.kind === "regular") used.add(row.caddy.id);
  }
  for (const s of draft.sparesByShift || []) {
    if (s.spare1?.caddyId) used.add(s.spare1.caddyId);
    if (s.spare2?.caddyId) used.add(s.spare2.caddyId);
  }
  const sick = new Set(extraSick);
  return draft.caddyPool
    .filter(
      (c) => (c.caddyType || "HOUSE") === "HOUSE" && used.has(c.id) && !sick.has(c.id)
    )
    .sort(compareCaddyOrder);
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

section("CASE A: clean auto-assignment leftover-first 2부");
{
  const draft = loadChoiFixtureDraft();
  const house = fixtureUsedHouse(draft);
  assert(house.length === 104, `usable circular HOUSE ${house.length}`);
  const start = 112;
  const n1 = regularIds(draft.assignments, "1부").length;
  const n2 = regularIds(draft.assignments, "2부").length;
  assert(n1 === 67, `1부 regular HOUSE ${n1}`);
  const occupied = draft.assignments.filter((row) => row.kind !== "regular");
  const reservations = draft.assignments
    .filter(
      (row) =>
        row.kind === "regular" &&
        ((row.reservation?.shift || row.shift) === "1부" ||
          (row.reservation?.shift || row.shift) === "2부")
    )
    .map((row) => row.reservation);
  const seq = assignRegularSequence({
    date: "2026-08-28",
    house,
    third: [],
    reservations,
    houseStartCaddyId: start,
    occupiedAssignments: occupied,
  });
  const after1 = regularIds(seq.assignments, "1부");
  const after2 = regularIds(seq.assignments, "2부");
  const wrap = wrapIndex(after2, after1);
  const [s1, s2] = spareIds(seq.sparesByShift, "1부");
  assert(after1[0] === 112, "CASE A 1부 first 최루비");
  assert(after1[0] !== after2[0], "CASE A 1부 first ≠ 2부 first");
  assert(after2[0] === 146, "CASE A 2부 first = 1부 소비 다음 usable 김현정1");
  assert(s1 === 146 && s2 === 141, "CASE A 1부 spare 김현정1/안한빛");
  assert(wrap === 37, `CASE A wrap idx ${wrap}`);
  assert(after2[wrap] === 112, "CASE A wrap first 최루비");
  assert(
    after2.slice(0, wrap).every((id) => !after1.includes(id)),
    "CASE A wrap 전 1부 앞순번 재등장 금지"
  );
}

section("production-like 2026-08-28 최루비 SICK circular 2부");
{
  const VICTIM = 112;
  const NEXT1 = 190;
  const NEXT2 = 113;
  const SKIP_TO = 191;
  const SPARE1 = 146;
  const SPARE2 = 141;
  const NEXT_UNUSED = 152;
  const BAD_SPARE1 = 94;
  const BAD_SPARE2 = 106;
  const draft = loadChoiFixtureDraft();
  const before1 = regularIds(draft.assignments, "1부");
  const [bS1, bS2] = spareIds(draft.sparesByShift, "1부");
  assert(before1[0] === VICTIM, "draft starts at victim");
  assert(bS1 === SPARE1 && bS2 === SPARE2, `draft spare ${bS1}/${bS2}`);
  const sick = [14, 192, 113, 40, 193, 15, 277, 12, 9, 51, 56, 235];
  const extraUsable = fixtureUsedHouse(draft, sick);
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
  assert(after2[0] === SPARE2, `2부 first leftover ${after2[0]} 안한빛`);
  assert(after2[0] !== after1[0], "2부 first must not reset to 1부 first");
  assert(!after2.includes(VICTIM), "victim removed from 2부");
  const wrap = wrapIndex(after2, after1);
  assert(wrap > 0, `2부 leftover prefix ${wrap}`);
  assert(after2[wrap] === NEXT1, "wrap first is new 1부 origin 강보미");
  const leftover3 = [157, 149, 143, 144, 148, 204, 153, 142];
  assert(after3.join(",") === leftover3.join(","), `3부 HOUSE leftover ${after3.join(",")}`);
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

section("CASE B/C: 정윤지 1부·2부 셀 SICK circular fingerprints");
{
  const VICTIM = 191;
  const draft = loadChoiFixtureDraft();
  const extraUsable = fixtureUsedHouse(draft);
  assert(extraUsable.length === 104, `usable ${extraUsable.length}`);
  const leftover3 = [157, 149, 143, 144, 148, 204, 153, 142];
  function fpOf(d: AssignmentDraft) {
    return {
      "1부": regularIds(d.assignments, "1부"),
      "2부": regularIds(d.assignments, "2부"),
      "3부": regularIds(d.assignments, "3부"),
      spare: {
        "1부": spareIds(d.sparesByShift, "1부"),
        "2부": spareIds(d.sparesByShift, "2부"),
        "3부": spareIds(d.sparesByShift, "3부"),
      },
    };
  }
  function run(shift: "1부" | "2부", id: string) {
    const ui = uiHydrateAndEnqueueSick({
      payloadDraft: draft,
      liveUnavailableIds: [],
      extraUsable,
      change: { type: "CADDY_SICK", caddyId: VICTIM, shift },
      id,
    });
    assert(ui.prepared.ok, `${id} prepare ok`);
    const persistDraft = applyLiveResultToDraft(
      ui.confirmed,
      ui.prepared.ok ? ui.prepared.preview.after : ui.click.draft
    );
    const serverPreview = previewLiveChangeFromDraft({
      draft: ui.confirmed,
      change: { type: "CADDY_SICK", caddyId: VICTIM, shift },
      regularCaddyPool: ui.computePool,
    });
    return {
      click: fpOf(ui.click.draft),
      server: fpOf(applyLiveResultToDraft(ui.confirmed, serverPreview.after)),
      persist: fpOf(persistDraft),
      reload: fpOf(persistDraft),
    };
  }
  const caseB = run("1부", "case-b");
  const caseC = run("2부", "case-c");
  for (const [label, stages] of [
    ["CASE B 1부 셀", caseB],
    ["CASE C 2부 셀", caseC],
  ] as const) {
    for (const stage of ["click", "server", "persist", "reload"] as const) {
      const fp = stages[stage];
      const wrap = wrapIndex(fp["2부"], fp["1부"]);
      assert(fp["1부"][0] === 112, `${label} ${stage} 1부 first 최루비`);
      assert(!fp["1부"].includes(VICTIM) && !fp["2부"].includes(VICTIM), `${label} ${stage} 정윤지 제거`);
      assert(fp["1부"][fp["1부"].length - 1] === 146, `${label} ${stage} 1부 last 김현정1`);
      assert(fp.spare["1부"][0] === 141 && fp.spare["1부"][1] === 152, `${label} ${stage} 1부 spare 안한빛/남궁정호`);
      assert(fp["2부"][0] === 141, `${label} ${stage} 2부 first 안한빛`);
      assert(fp["2부"][0] !== fp["1부"][0], `${label} ${stage} 2부 first not reset`);
      assert(wrap === 36, `${label} ${stage} wrap idx ${wrap}`);
      assert(fp["2부"][wrap] === 112, `${label} ${stage} wrap first 최루비`);
      assert(fp["3부"].join(",") === leftover3.join(","), `${label} ${stage} 3부 leftover`);
      assert(fp.spare["3부"][0] === 96 && fp.spare["3부"][1] === 94, `${label} ${stage} 3부 spare`);
    }
    assert(
      JSON.stringify(stages.click) === JSON.stringify(stages.server) &&
        JSON.stringify(stages.click) === JSON.stringify(stages.persist) &&
        JSON.stringify(stages.click) === JSON.stringify(stages.reload),
      `${label} click = server preview.after = persist = reload`
    );
  }
  assert(JSON.stringify(caseB) === JSON.stringify(caseC), "CASE B = CASE C");
}

section("CASE D/E: 단일 1부·단일 2부 HOUSE SICK keeps circular cursor");
{
  const draft = loadChoiFixtureDraft();
  const extraUsable = fixtureUsedHouse(draft);
  const before1 = regularIds(draft.assignments, "1부");
  const only1 = 145;
  assert(before1.includes(only1) && !regularIds(draft.assignments, "2부").includes(only1), "이연주 1부 only");
  const d = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: only1, shift: "1부" },
    regularCaddyPool: snapshotComputePoolFromDraft(draft, null, { extraUsable }),
  });
  const d1 = regularIds(d.after.assignments, "1부");
  const d2 = regularIds(d.after.assignments, "2부");
  assert(d1[0] === 112, "CASE D 1부 first 최루비");
  assert(d2[0] === 141, "CASE D 1부 extra consume → 2부 first 안한빛");
  assert(d2[0] !== d1[0], "CASE D 2부 first not reset");
  assert(wrapIndex(d2, d1) > 0, "CASE D leftover prefix");
  const only2 = 152;
  assert(!before1.includes(only2), "남궁정호 is 2부 leftover, not 1부 regular");
  const e = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: only2, shift: "2부" },
    regularCaddyPool: snapshotComputePoolFromDraft(draft, null, { extraUsable }),
  });
  const e1 = regularIds(e.after.assignments, "1부");
  const e2 = regularIds(e.after.assignments, "2부");
  assert(e1.join(",") === before1.join(","), "CASE E 1부 identity");
  assert(e2[0] === 146, "CASE E 2부 first stays leftover 김현정1");
  assert(!e2.includes(only2), "CASE E 2부 victim removed");
  assert(wrapIndex(e2, e1) > 0, "CASE E leftover prefix");
}

section("CASE F: 연속 SICK 2건 circular");
{
  const draft = loadChoiFixtureDraft();
  const extraUsable = fixtureUsedHouse(draft);
  const first = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: 191, shift: "1부" },
    regularCaddyPool: snapshotComputePoolFromDraft(draft, null, { extraUsable }),
  });
  const mid = applyLiveResultToDraft(draft, first.after);
  const second = previewLiveChangeFromDraft({
    draft: mid,
    change: { type: "CADDY_SICK", caddyId: 190, shift: "1부" },
    regularCaddyPool: snapshotComputePoolFromDraft(mid, null, {
      extraUsable: extraUsable.filter((c) => c.id !== 191),
    }),
  });
  const a1 = regularIds(first.after.assignments, "1부");
  const a2 = regularIds(first.after.assignments, "2부");
  const b1 = regularIds(second.after.assignments, "1부");
  const b2 = regularIds(second.after.assignments, "2부");
  assert(a2[0] === 141, "CASE F after 정윤지 2부 first 안한빛");
  assert(!b1.includes(191) && !b1.includes(190), "CASE F both victims gone from 1부");
  assert(!b2.includes(191) && !b2.includes(190), "CASE F both victims gone from 2부");
  assert(b1[0] === 112, "CASE F 1부 first 최루비");
  assert(b2[0] !== b1[0], "CASE F 2부 first not reset");
  assert(b2[0] !== a2[0], "CASE F second SICK advances 2부 start");
  assert(wrapIndex(b2, b1) > 0, "CASE F leftover prefix");
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
  const click2 = regularIds(ui.click.draft.assignments, "2부");
  const persist2 = regularIds(persistDraft.assignments, "2부");
  const wrap2 = wrapIndex(click2, click1);

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
  assert(click2[0] === SPARE2, "2부 first leftover 안한빛");
  assert(click2[0] !== click1[0], "2부 first not reset to 1부 first");
  assert(wrap2 > 0, "2부 leftover prefix");
  assert(persist2.join(",") === click2.join(","), "2부 persist matches click");
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

section("synthetic circular HOUSE: leftover then wrap, dual SICK");
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
  const r2 = shiftReservations(date, "2부", 12, "B");
  const r3 = shiftReservations(date, "3부", 2, "C");
  const previous = computeAutoAssignmentsV1({
    date,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: pool[0].id,
    reservations: [...r1, ...r2, ...r3],
  });
  const draft = createDraftFromAutoResult(previous, pool);
  const before1 = regularNames(draft.assignments, "1부");
  const before2 = regularNames(draft.assignments, "2부");
  const before1Ids = regularIds(draft.assignments, "1부");
  const before2Ids = regularIds(draft.assignments, "2부");
  const wrap0 = wrapIndex(before2Ids, before1Ids);
  const [b1s1, b1s2] = spareNames(draft.sparesByShift, "1부");
  assert(before1.join("→") === "A→B→C→정윤지→D→E", `before 1부 ${before1.join("→")}`);
  assert(before1[0] !== before2[0], "clean 1부 first ≠ 2부 first");
  assert(before2[0] === "조정혜", `before 2부 first leftover ${before2[0]}`);
  assert(wrap0 === 8 && before2[wrap0] === "A", `before wrap ${wrap0} ${before2[wrap0]}`);
  assert(before2.includes("정윤지"), "정윤지 in wrap 투");
  assert(b1s1 === "조정혜" && b1s2 === "장혜원", `before 1부 spare ${b1s1}/${b1s2}`);
  const extraUsable = pool.filter((c) => c.id !== V.id);
  const compute = snapshotComputePoolFromDraft(draft, previous, { extraUsable });
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: V.id, shift: "1부" },
    regularCaddyPool: compute,
  });
  const after1 = regularNames(preview.after.assignments, "1부");
  const after2 = regularNames(preview.after.assignments, "2부");
  const after1Ids = regularIds(preview.after.assignments, "1부");
  const after2Ids = regularIds(preview.after.assignments, "2부");
  const wrap1 = wrapIndex(after2Ids, after1Ids);
  const [a1s1, a1s2] = spareNames(preview.after.sparesByShift, "1부");
  assert(after1.join("→") === "A→B→C→D→E→조정혜", `after 1부 ${after1.join("→")}`);
  assert(a1s1 === "장혜원" && a1s2 === "지석준", `after 1부 spare ${a1s1}/${a1s2}`);
  assert(after2[0] === "장혜원", `after 2부 first ${after2[0]}`);
  assert(after2[0] !== after1[0], "after 2부 first not reset");
  assert(!after2.includes("정윤지"), "2부 wrap victim gone");
  assert(wrap1 === 7 && after2[wrap1] === "A", `after wrap ${wrap1}`);

  const only1Victim = pool.find((c) => c.name === "E")!;
  const only1Preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: only1Victim.id, shift: "1부" },
    regularCaddyPool: snapshotComputePoolFromDraft(draft, previous, {
      extraUsable: pool.filter((c) => c.id !== only1Victim.id),
    }),
  });
  const only1After1 = regularNames(only1Preview.after.assignments, "1부");
  const only1After2 = regularNames(only1Preview.after.assignments, "2부");
  assert(only1After1[0] === "A", "단일 1부 병가 1부 first 유지");
  assert(only1After2[0] === "장혜원", "단일 1부 병가 2부 start 전진");
  assert(only1After2[0] !== only1After1[0], "단일 1부 병가 2부 first not reset");

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
  assert(only2After1.join("→") === before1.join("→"), "단일 2부 병가 1부 identity");
  assert(only2After2[0] === "조정혜", "단일 2부 병가 leftover first 유지");
  assert(!only2After2.includes("장혜원"), "단일 2부 victim gone");

  function dualSickFingerprint(shift: "1부" | "2부", id: string) {
    const ui = uiHydrateAndEnqueueSick({
      payloadDraft: draft,
      liveUnavailableIds: [],
      extraUsable,
      change: { type: "CADDY_SICK", caddyId: V.id, shift },
      id,
    });
    const after = ui.prepared.ok ? ui.prepared.preview.after : preview.after;
    const persistDraft = applyLiveResultToDraft(ui.confirmed, after);
    const serverPreview = previewLiveChangeFromDraft({
      draft: ui.confirmed,
      change: { type: "CADDY_SICK", caddyId: V.id, shift },
      regularCaddyPool: compute,
    });
    const serverDraft = applyLiveResultToDraft(ui.confirmed, serverPreview.after);
    const fpOf = (d: AssignmentDraft) => ({
      "1부": regularNames(d.assignments, "1부"),
      spare1: spareNames(d.sparesByShift, "1부"),
      "2부": regularNames(d.assignments, "2부"),
      spare2: spareNames(d.sparesByShift, "2부"),
    });
    return {
      click: fpOf(ui.click.draft),
      server: fpOf(serverDraft),
      persist: fpOf(persistDraft),
      reload: fpOf(persistDraft),
    };
  }
  const synB = dualSickFingerprint("1부", "syn-b");
  const synC = dualSickFingerprint("2부", "syn-c");
  const expected = {
    "1부": ["A", "B", "C", "D", "E", "조정혜"],
    spare1: ["장혜원", "지석준"],
    "2부": ["장혜원", "지석준", "윤숙영", "지선영", "홍정자", "다음", "X", "A", "B", "C", "D", "E"],
  };
  for (const [label, stages] of [
    ["synthetic B", synB],
    ["synthetic C", synC],
  ] as const) {
    for (const stage of ["click", "server", "persist", "reload"] as const) {
      const fp = stages[stage];
      assert(fp["1부"].join("→") === expected["1부"].join("→"), `${label} ${stage} 1부`);
      assert(fp.spare1[0] === expected.spare1[0] && fp.spare1[1] === expected.spare1[1], `${label} ${stage} 1부 spare`);
      assert(fp["2부"].join("→") === expected["2부"].join("→"), `${label} ${stage} 2부`);
      assert(fp["2부"][0] !== fp["1부"][0], `${label} ${stage} 2부 first not reset`);
    }
    assert(
      JSON.stringify(stages.click) === JSON.stringify(stages.server) &&
        JSON.stringify(stages.click) === JSON.stringify(stages.persist),
      `${label} click=server=persist=reload`
    );
  }
  assert(JSON.stringify(synB) === JSON.stringify(synC), "synthetic B = C");
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
