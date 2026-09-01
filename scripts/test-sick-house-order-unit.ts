/**
 * SICK must pull the existing HOUSE sequence forward one slot.
 * Never re-sort by team order / extraUsable availability.
 * 실행: npx tsx scripts/test-sick-house-order-unit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeAutoAssignmentsV1, type AutoAssignCaddy } from "../src/lib/autoAssignEngine";
import { createDraftFromAutoResult, snapshotComputePoolFromDraft } from "../src/lib/assignmentDraft";
import { previewLiveChangeFromDraft } from "../src/lib/assignmentChange";
import { parseDailyBoardDraftPayload, payloadToAssignmentDraft } from "../src/lib/dailyBoardDraft";
import { compareCaddyOrder } from "../src/lib/autoAssignEngine";

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
  const [b3s1, b3s2] = spareIds(draft.sparesByShift, "3부");
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
  assert(after2[0] === NEXT1, `2부 first ${after2[0]} (same origin pull-forward)`);
  assert(!after2.includes(VICTIM), "victim removed from 2부");
  assert(a3s1 === b3s1 && a3s2 === b3s2, `3부 spare frozen ${a3s1}/${a3s2}`);
  assert(after3.join("→") === regularIds(draft.assignments, "3부").join("→"), "3부 HOUSE order unchanged");
}

const fs = require("node:fs") as typeof import("node:fs");
const canonical = fs.readFileSync("src/lib/caddyPoolCanonical.ts", "utf8");
assert(
  !/return usableComputePool\(\{\s*rosterBaseline: extra/.test(canonical),
  "snapshotComputePool does not replace assigned order with extraUsable"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
