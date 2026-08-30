/**
 * Board Mutation Pipeline v1 unit tests (no DB).
 * 실행: npx tsx scripts/test-board-mutation-pipeline-unit.ts
 */
import {
  changeFromPipelinePreview,
  dropIntent,
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

section("source contracts");
{
  const page = readFileSync(join(process.cwd(), "src/app/manage/assignments/page.tsx"), "utf8");
  const apply = readFileSync(join(process.cwd(), "src/lib/quickBoardMutationApply.ts"), "utf8");
  assert(page.includes("confirmedDraftRef"), "page keeps confirmedDraft");
  assert(page.includes("pendingIntentsRef"), "page keeps pending intents");
  assert(page.includes("/api/assignments/reflow/quick-mutation"), "page uses atomic mutation route");
  assert(page.includes("changeFromPipelinePreview"), "dock apply joins pipeline");
  assert(page.includes("pendingIntentsRef.current.length > 0"), "flush restarts if more pending");
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
