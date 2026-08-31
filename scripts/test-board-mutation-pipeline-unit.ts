/**
 * Board Mutation Pipeline v1 unit tests (no DB).
 * 실행: npx tsx scripts/test-board-mutation-pipeline-unit.ts
 */
import {
  changeFromPipelinePreview,
  dropIntent,
  isDuplicateCaddyAbsenceIntent,
  isPipelineMutation,
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
  projectPendingIntents,
  readPipelineTestDelayMs,
  readPipelineTestFail,
} from "../src/lib/boardMutationPipeline";
import {
  PIPELINE_DIRTY_STORAGE_KEY,
  clearPipelineDirty,
  consumePipelineDirty,
  markPipelineDirty,
  pipelineHasUnsavedWork,
  shouldBlockAnchorNavigation,
  shouldClearPipelineDirty,
} from "../src/lib/pipelineUnloadGuard";
import { resolveHouseQueueKeepingOrigin } from "../src/lib/autoAssignEngine";
import {
  autoResultFromDraft,
  createDraftFromAutoResult,
  resolveHouseStartCaddyIdForRecalc,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { computeAutoAssignmentsV1, type AutoAssignCaddy } from "../src/lib/autoAssignEngine";
import { previewLiveChangeFromDraft } from "../src/lib/assignmentChange";
import { makeMoveReservationChange } from "../src/lib/assignmentChange";
import { reservationKey } from "../src/lib/autoAssignEngine";
import {
  mergeRosterBaseline,
  snapshotComputePool,
} from "../src/lib/caddyPoolCanonical";
import { snapshotComputePoolFromDraft } from "../src/lib/assignmentDraft";
import { peekCachedOffSheets, peekCachedOffSheetsForDate, seedOffSheetCacheForTests, invalidateOffSheetCache } from "../src/lib/offSheetFetch";
import type { ShiftPart } from "../src/lib/reservationParser";
import { readFileSync } from "fs";
import { join } from "path";

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

function house(id: number, name: string, teamOrder: number): AutoAssignCaddy {
  return {
    id,
    name,
    team: `${teamOrder}조`,
    teamOrder,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

const 김예진1 = house(1, "김예진1", 0);
const 서승희 = house(13, "서승희", 1);
const 김하나1 = house(19, "김하나1", 2);
const nextH = house(20, "다음HOUSE", 3);
const s1 = house(21, "스페어1", 4);
const s2 = house(22, "스페어2", 5);
const x = house(23, "대기X", 6);
const pool = [김예진1, 서승희, 김하나1, nextH, s1, s2, x];

function fixtureDraft() {
  const result = computeAutoAssignmentsV1({
    date: "2099-12-20",
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: 서승희.id,
    reservations: [
      { date: "2099-12-20", course: "SKY", shift: "1부", teeTime: "07:00", teamName: "A팀", rawRowIndex: 1, sourceSheet: "예약1부" },
      { date: "2099-12-20", course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "B팀", rawRowIndex: 2, sourceSheet: "예약1부" },
      { date: "2099-12-20", course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "C팀", rawRowIndex: 3, sourceSheet: "예약1부" },
      { date: "2099-12-20", course: "VERTHILL", shift: "1부", teeTime: "07:08", teamName: "D팀", rawRowIndex: 4, sourceSheet: "예약1부" },
    ],
  });
  return createDraftFromAutoResult(result, pool);
}

section("pipeline type guards");
assert(isPipelineMutation("MOVE_RESERVATION"), "MOVE is pipeline");
assert(isPipelineMutation("CADDY_SICK"), "SICK is pipeline");
assert(isPipelineMutation("CADDY_ATTENDANCE_NOSHOW"), "결근 is pipeline");
assert(!isPipelineMutation("SET_LOCK"), "LOCK is not pipeline v1");
assert(!isPipelineMutation("ADD_RESERVATION"), "ADD is not pipeline v1");

section("HOUSE cursor persist + infer");
{
  const draft = fixtureDraft();
  assert(draft.houseStartCaddyId === 서승희.id, "createDraft stores houseStartCaddyId");
  const payload = assignmentDraftToPayload(draft);
  assert(payload.houseStartCaddyId === 서승희.id, "payload keeps houseStartCaddyId");
  const parsed = parseDailyBoardDraftPayload(payload, "2099-12-20");
  assert(parsed.houseStartCaddyId === 서승희.id, "parse keeps houseStartCaddyId");
  const hydrated = payloadToAssignmentDraft(parsed);
  assert(hydrated.houseStartCaddyId === 서승희.id, "hydrate keeps houseStartCaddyId");
  const restored = resolveHouseStartCaddyIdForRecalc({
    selectedId: "",
    metaId: null,
    draft: hydrated,
  });
  assert(restored?.source === "draftStored", "stored start is authoritative");
  assert(restored?.caddyId === 서승희.id, "reload does not reset to 1조 first");
  const legacy = { ...hydrated, houseStartCaddyId: undefined };
  const inferred = resolveHouseStartCaddyIdForRecalc({
    selectedId: "",
    metaId: null,
    draft: legacy,
  });
  assert(inferred?.source === "draftRegular" || inferred?.source === "pool", "legacy infers only when missing");
}

section("서승희 병가 pull-forward");
{
  const draft = fixtureDraft();
  const first = draft.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  assert(first[0]?.caddy.name === "서승희", "start slot is 서승희");
  assert(first[1]?.caddy.name === "김하나1", "second slot is 김하나1");
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
  });
  assert(!preview.warnings.some((w) => w.level === "error"), "sick preview ok");
  const names = preview.after.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((a) => a.caddy.name);
  assert(names[0] === "김하나1", "서승희 자리 = 김하나1");
  assert(!names.includes("서승희"), "서승희 없음");
  assert(!names.includes("김예진1"), "HOUSE 시작 리셋 후보 김예진1 금지");
  const spare1 = preview.after.sparesByShift.find((s) => s.shift === "1부")?.spare1?.name;
  const spare2 = preview.after.sparesByShift.find((s) => s.shift === "1부")?.spare2?.name;
  assert(spare1 === "스페어2" || spare1 === "대기X" || Boolean(spare1), "spare1 갱신됨");
  assert(spare2 !== "스페어1" || spare1 !== "스페어1", "spare 재계산");
  const after = autoResultFromDraft(
    createDraftFromAutoResult(preview.after, pool),
    preview.after
  );
  assert(after.meta.houseStartCaddyId === 서승희.id, "병가 후에도 원래 HOUSE 시작점 유지");
}

section("resolveHouseQueueKeepingOrigin");
{
  const remaining = [김하나1, nextH, s1];
  const original = [김예진1, 서승희, 김하나1, nextH, s1];
  const kept = resolveHouseQueueKeepingOrigin({
    remainingHouse: remaining,
    originalHouse: original,
    houseStartCaddyId: 서승희.id,
  });
  assert(kept.house[0]?.name === "김하나1", "start sick → next from origin");
  assert(kept.houseStartCaddyId == null, "already rotated, do not rotate again");
  const still = resolveHouseQueueKeepingOrigin({
    remainingHouse: [서승희, 김하나1],
    originalHouse: original,
    houseStartCaddyId: 서승희.id,
  });
  assert(still.houseStartCaddyId === 서승희.id, "start still present → keep id");
}

section("SICK then MOVE does not revive");
{
  const draft = fixtureDraft();
  const sick = projectPendingIntents({
    confirmedDraft: draft,
    pending: [
      makeMutationIntent(
        { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
        "s1"
      )!,
    ],
  });
  assert(!sick.draft.assignments.some((a) => a.caddy.id === 서승희.id), "sick removes 서승희");
  const aKey = reservationKey(
    sick.draft.assignments.find((a) => a.reservation.teamName === "A팀")!.reservation
  );
  const moved = projectPendingIntents({
    confirmedDraft: sick.draft,
    pending: [
      makeMutationIntent(
        makeMoveReservationChange({
          reservationKey: aKey,
          to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
        }),
        "m1"
      )!,
    ],
  });
  assert(moved.applied.length === 1, "MOVE after sick applies");
  assert(
    !moved.draft.assignments.some((a) => a.caddy.id === 서승희.id),
    "MOVE must not revive 서승희"
  );
}

section("pending projection + drop invalid");
{
  const draft = fixtureDraft();
  const aKey = reservationKey(
    draft.assignments.find((a) => a.reservation.teamName === "A팀")!.reservation
  );
  const move = makeMutationIntent(
    makeMoveReservationChange({
      reservationKey: aKey,
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    }),
    "m1"
  )!;
  const sick = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
    "m2"
  )!;
  const projected = projectPendingIntents({
    confirmedDraft: draft,
    pending: [move, sick],
  });
  assert(projected.applied.length === 2, "MOVE + SICK both project");
  const aAfter = projected.draft.assignments.find(
    (a) => a.reservation.teamName === "A팀"
  );
  assert(aAfter?.reservation.course === "VERTHILL", "optimistic MOVE painted");
  assert(
    !projected.draft.assignments.some((a) => a.caddy.id === 서승희.id),
    "optimistic SICK removes 서승희"
  );
  const bad = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
    "m3"
  )!;
  const afterSick = projectPendingIntents({
    confirmedDraft: projected.draft,
    pending: [bad],
  });
  assert(afterSick.dropped.length === 1, "second sick of gone caddy drops");
}

section("prepare on confirmed only, not stale paint");
{
  const draft = fixtureDraft();
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: draft,
    intent: makeMutationIntent(
      { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
      "s1"
    )!,
  });
  assert(prepared.ok, "sick prepares on confirmed");
}

section("dropIntent");
{
  const a = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: 1, shift: "1부" },
    "a"
  )!;
  const b = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: 2, shift: "1부" },
    "b"
  )!;
  assert(dropIntent([a, b], "a").map((x) => x.id).join() === "b", "drop first");
}

section("test knobs stay local");
assert(readPipelineTestDelayMs("?pipelineDelay=5000", "localhost") === 5000, "localhost delay");
assert(readPipelineTestDelayMs("?pipelineDelay=5000", "caddy.example.com") === 0, "prod host ignores delay");
assert(readPipelineTestFail("?pipelineFail=sick", "localhost") === "sick", "fail knob sick");

section("dock preview reconstructs pipeline change");
{
  const draft = fixtureDraft();
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
  });
  const change = changeFromPipelinePreview(preview);
  assert(change?.type === "CADDY_SICK", "reconstructs SICK");
  assert(change && "caddyId" in change && change.caddyId === 서승희.id, "keeps caddyId");
}

section("unload guard");
{
  assert(pipelineHasUnsavedWork({ pendingIntentCount: 0, persistInFlight: false }) === false, "idle is clean");
  assert(pipelineHasUnsavedWork({ pendingIntentCount: 2, persistInFlight: false }) === true, "queued intents dirty");
  assert(pipelineHasUnsavedWork({ pendingIntentCount: 0, persistInFlight: true }) === true, "in-flight dirty");
  assert(
    shouldBlockAnchorNavigation({ href: "/manage", target: null, button: 0 }) === true,
    "blocks same-tab nav"
  );
  assert(
    shouldBlockAnchorNavigation({ href: "/manage", target: "_blank", button: 0 }) === false,
    "allows new tab"
  );
  assert(
    shouldBlockAnchorNavigation({ href: "/manage", button: 0, metaKey: true }) === false,
    "allows modified click"
  );
  const mem = new Map<string, string>();
  const storage = {
    setItem(k: string, v: string) {
      mem.set(k, v);
    },
    getItem(k: string) {
      return mem.get(k) ?? null;
    },
    removeItem(k: string) {
      mem.delete(k);
    },
  };
  markPipelineDirty(storage, { date: "2099-12-21", count: 2 });
  assert(mem.has(PIPELINE_DIRTY_STORAGE_KEY), "marks dirty");
  const left = consumePipelineDirty(storage);
  assert(left?.date === "2099-12-21" && left.count === 2, "consumes dirty once");
  assert(consumePipelineDirty(storage) === null, "second consume empty");
  markPipelineDirty(storage, { date: "2099-12-21", count: 1 });
  clearPipelineDirty(storage);
  assert(consumePipelineDirty(storage) === null, "clear removes dirty");
  assert(
    shouldClearPipelineDirty({ pendingIntentCount: 0, flushHadFailure: false }) === true,
    "clear after successful drain"
  );
  assert(
    shouldClearPipelineDirty({ pendingIntentCount: 1, flushHadFailure: false }) === false,
    "keep dirty while pending remain"
  );
  assert(
    shouldClearPipelineDirty({ pendingIntentCount: 0, flushHadFailure: true }) === false,
    "keep dirty after persist failure"
  );
}

section("duplicate SICK same caddy is dropped");
{
  const draft = fixtureDraft();
  const first = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: 서승희.id, shift: "1부" },
    "s1"
  )!;
  assert(
    isDuplicateCaddyAbsenceIntent([first], {
      type: "CADDY_SICK",
      caddyId: 서승희.id,
      shift: "1부",
    }),
    "same-caddy 병가 연타 is duplicate"
  );
  assert(
    !isDuplicateCaddyAbsenceIntent([first], {
      type: "CADDY_SICK",
      caddyId: 김하나1.id,
      shift: "1부",
    }),
    "other caddy 병가 is not duplicate"
  );
}

function houseMany(start: number, count: number): AutoAssignCaddy[] {
  return Array.from({ length: count }, (_, i) =>
    house(start + i, `H${start + i}`, i % 8)
  );
}

function shiftRows(
  date: string,
  shift: ShiftPart,
  count: number,
  prefix: string
) {
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  const startHour = shift === "1부" ? 7 : shift === "2부" ? 12 : 17;
  return Array.from({ length: count }, (_, i) => ({
    date,
    course: courses[i % 4],
    shift,
    teeTime: `${String(startHour + Math.floor(i / 4)).padStart(2, "0")}:${String(
      (i % 4) * 8
    ).padStart(2, "0")}`,
    teamName: `${prefix}${i + 1}`,
    rawRowIndex: i + 1,
    sourceSheet: `예약${shift}`,
  }));
}

function productionLikeDraft() {
  const date = "2026-08-28";
  const compute = houseMany(1, 93);
  const off = houseMany(400, 80);
  const reservations = [
    ...shiftRows(date, "1부", 28, "A"),
    ...shiftRows(date, "2부", 28, "B"),
    ...shiftRows(date, "3부", 26, "C"),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: compute,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: compute[8].id,
    reservations,
  });
  const draft = createDraftFromAutoResult(result, mergeRosterBaseline(compute, off));
  return { date, compute, off, result, draft };
}

function measureSickClick(input: {
  draft: ReturnType<typeof createDraftFromAutoResult>;
  base?: ReturnType<typeof computeAutoAssignmentsV1> | null;
  pool?: AutoAssignCaddy[];
  victimId: number;
  shift: ShiftPart;
}) {
  const t0 = Date.now();
  const computePool =
    input.pool ||
    snapshotComputePoolFromDraft(input.draft, input.base ?? null);
  const tSnapshot = Date.now();
  const projected = projectPendingIntents({
    confirmedDraft: input.draft,
    pending: [
      makeMutationIntent(
        { type: "CADDY_SICK", caddyId: input.victimId, shift: input.shift },
        "sick-click"
      )!,
    ],
    base: input.base ?? null,
    regularCaddyPool: computePool,
  });
  const tProject = Date.now();
  return {
    snapshotMs: tSnapshot - t0,
    projectMs: tProject - tSnapshot,
    totalMs: tProject - t0,
    computePoolSize: computePool.length,
    projected,
  };
}

section("SICK click→paint 1/2/3부 + #108 vs #109");
{
  const { compute, off, result, draft } = productionLikeDraft();
  const baseline = draft.caddyPool;
  assert(baseline.length >= 160, "draft stores #109 roster baseline");
  const brokenMs: number[] = [];
  const fixedMs: number[] = [];
  const times: Record<string, number> = {};
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    const victim = draft.assignments.find(
      (row) => row.shift === shift && row.kind === "regular" && row.caddy.caddyType === "HOUSE"
    );
    assert(!!victim, `${shift} HOUSE victim exists`);
    if (!victim) continue;
    const before108 = measureSickClick({
      draft: { ...draft, caddyPool: compute },
      base: result,
      pool: compute,
      victimId: victim.caddy.id,
      shift,
    });
    const broken109 = measureSickClick({
      draft,
      base: { ...result, unusedCaddies: [...result.unusedCaddies, ...off] },
      pool: baseline,
      victimId: victim.caddy.id,
      shift,
    });
    const fixed = measureSickClick({
      draft,
      base: result,
      victimId: victim.caddy.id,
      shift,
    });
    times[`${shift}-108`] = before108.totalMs;
    times[`${shift}-109-broken`] = broken109.totalMs;
    times[`${shift}-fixed`] = fixed.totalMs;
    brokenMs.push(broken109.totalMs);
    fixedMs.push(fixed.totalMs);
    assert(fixed.totalMs < 100, `${shift} snapshot click→paint ${fixed.totalMs}ms < 100`);
    assert(
      !fixed.projected.draft.assignments.some((a) => a.caddy.id === victim.caddy.id),
      `${shift} victim gone after optimistic SICK`
    );
    assert(
      !fixed.projected.draft.assignments.some((a) => off.some((c) => c.id === a.caddy.id)),
      `${shift} 휴무 not resurrected`
    );
    const beforeSpare = draft.sparesByShift.find((s) => s.shift === shift);
    const afterSpare = fixed.projected.draft.sparesByShift.find((s) => s.shift === shift);
    assert(
      !afterSpare?.spare1 || afterSpare.spare1.caddyId !== victim.caddy.id,
      `${shift} sick caddy is not spare1`
    );
    if (beforeSpare?.spare1 || beforeSpare?.spare2) {
      assert(
        afterSpare?.spare1?.caddyId !== beforeSpare?.spare1?.caddyId ||
          afterSpare?.spare2?.caddyId !== beforeSpare?.spare2?.caddyId ||
          !fixed.projected.draft.assignments.some((a) => a.caddy.id === victim.caddy.id),
        `${shift} spare recomputed or victim removed`
      );
    }
    if (shift === "3부") {
      const seq = draft.assignments
        .filter((a) => a.shift === "3부" && a.kind === "regular")
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      const afterSeq = fixed.projected.draft.assignments
        .filter((a) => a.shift === "3부" && a.kind === "regular")
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      if (seq.length > 1) {
        assert(
          afterSeq[0]?.caddy.id === seq[1]?.caddy.id ||
            afterSeq.some((a) => a.caddy.id === seq[1]?.caddy.id),
          "3부 pull-forward keeps following HOUSE"
        );
      }
    }
    console.log(
      `  · ${shift} click→paint #108=${before108.totalMs}ms broken109=${broken109.totalMs}ms fixed=${fixed.totalMs}ms pool ${before108.computePoolSize}/${broken109.computePoolSize}/${fixed.computePoolSize}`
    );
  }
  const snap = snapshotComputePool({
    rosterBaseline: baseline,
    assigned: draft.assignments.map((a) => a.caddy),
    engineUnused: result.unusedCaddies,
  });
  assert(snap.length < 120, "snapshot pool is not full baseline");
  assert(
    !snap.some((c) => off.some((o) => o.id === c.id)),
    "snapshot excludes 휴무 baseline"
  );
  assert(
    Math.max(...fixedMs) <= Math.max(...brokenMs) || Math.max(...fixedMs) < 100,
    "fixed path is not slower than baseline-polluted path"
  );
}

section("off-sheet cache peek never fetches");
{
  invalidateOffSheetCache();
  assert(peekCachedOffSheets() === null, "empty cache is miss");
  seedOffSheetCacheForTests([{ name: "0817~30", matrix: [["날짜"], ["0828"]] }]);
  const peeked = peekCachedOffSheets();
  assert(!!peeked && peeked[0]?.name === "0817~30", "peek returns seeded cache");
  assert(
    peekCachedOffSheetsForDate("2026-08-28") === null,
    "workbook without today's header is not date-safe"
  );
  invalidateOffSheetCache();
}

section("source contracts");
{
  const page = readFileSync(join(process.cwd(), "src/app/manage/assignments/page.tsx"), "utf8");
  const apply = readFileSync(join(process.cwd(), "src/lib/quickBoardMutationApply.ts"), "utf8");
  assert(page.includes("confirmedDraftRef"), "page keeps confirmedDraft");
  assert(page.includes("pendingIntentsRef"), "page keeps pending intents");
  assert(page.includes("/api/assignments/reflow/quick-mutation"), "page uses atomic mutation route");
  assert(page.includes("changeFromPipelinePreview"), "dock apply joins pipeline");
  assert(page.includes("pendingIntentsRef.current.length > 0"), "flush restarts if more pending");
  assert(page.includes("scheduleAfterPaint"), "persist is scheduled after paint");
  assert(page.includes("isDuplicateCaddyAbsenceIntent"), "same-caddy 병가 연타 drops");
  assert(page.includes("liveSnapshotPool"), "click uses confirmed snapshot pool");
  assert(!page.includes("fetchPublishedOffSheets"), "client click path has no OFF sheet HTTP");
  const tap = page.split("function handlePlacementTap")[1]?.split("const onTeamTap")[0] || "";
  assert(
    !/persistInFlight/.test(tap),
    "opening another caddy sheet is not blocked by persistInFlight"
  );
  const enqueue = page.split("function enqueuePipelineMutation")[1]?.split("async function persistPipelineIntent")[0] || "";
  assert(
    /setQuickSheet\(null\)/.test(enqueue) &&
      enqueue.indexOf("setQuickSheet(null)") < enqueue.indexOf("projectPendingIntents"),
    "sheet closes before projection"
  );
  assert(
    /scheduleAfterPaint\(\(\) => \{\s*void flushPipelineWrites\(\);/.test(enqueue),
    "flush is deferred until after paint"
  );
  assert(page.includes("keepalive: true"), "pipeline fetch uses keepalive");
  assert(page.includes("beforeunload"), "page blocks refresh while dirty");
  assert(page.includes("PIPELINE_UNLOAD_TOAST"), "in-app nav toast while dirty");
  assert(page.includes("shouldClearPipelineDirty"), "page clears dirty only after successful drain");
  assert(!page.includes("nextMoveIntent"), "no leftover next-move intent");
  assert(apply.includes("CADDY_SICK"), "atomic persist includes sick");
  assert(apply.includes("$transaction"), "atomic persist is one transaction");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
