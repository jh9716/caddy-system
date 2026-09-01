/**
 * offSnapshot parse / date gate / mutation block. No DB.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { applyLiveResultToDraft, type AssignmentDraft } from "../src/lib/assignmentDraft";
import {
  buildOffSnapshot,
  isUsableOffSnapshot,
  offCaddyIdsFromAvailability,
  OFF_SNAPSHOT_REQUIRED_USER_MESSAGE,
  parseOffSnapshot,
  pipelineMutationOffSnapshotBlock,
} from "../src/lib/offSnapshot";
import type { AutoAssignResultV1 } from "../src/lib/autoAssignEngine";

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

const DATE = "2026-08-28";

function emptyDraft(): AssignmentDraft {
  return {
    date: DATE,
    status: "CONFIRMED",
    assignments: [],
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    caddyPool: [],
    sparesByShift: [],
    confirmedAt: "2026-08-28T00:00:00.000Z",
  };
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("parse and date gate");
{
  assert(parseOffSnapshot(null) === null, "null is absent");
  assert(parseOffSnapshot({}) === null, "empty object is absent");
  assert(parseOffSnapshot({ date: DATE, caddyIds: [1] }) === null, "missing fetchedAt/version");
  const snap = buildOffSnapshot({ date: DATE, caddyIds: [12, 3, 3] });
  assert(snap.version === 1, "version 1");
  assert(snap.caddyIds.join(",") === "12,3", "unique positive ids keep first order after uniquePositive");
  assert(isUsableOffSnapshot(snap, DATE), "same date is usable");
  assert(!isUsableOffSnapshot(snap, "2026-09-01"), "other date is not usable");
  assert(!isUsableOffSnapshot(null, DATE), "missing snapshot is not usable");
  assert(
    pipelineMutationOffSnapshotBlock({ date: DATE }) ===
      OFF_SNAPSHOT_REQUIRED_USER_MESSAGE,
    "missing snapshot blocks mutation"
  );
  assert(
    pipelineMutationOffSnapshotBlock({ date: DATE, offSnapshot: snap }) === null,
    "usable snapshot allows mutation"
  );
  assert(
    pipelineMutationOffSnapshotBlock({
      date: DATE,
      offSnapshot: { ...snap, date: "2026-01-01" },
    }) === OFF_SNAPSHOT_REQUIRED_USER_MESSAGE,
    "wrong-date snapshot blocks mutation"
  );
}

section("payload optional field");
{
  const draft = emptyDraft();
  const bare = parseDailyBoardDraftPayload(assignmentDraftToPayload(draft), DATE);
  assert(bare.offSnapshot == null, "legacy payload omits offSnapshot");
  const snap = buildOffSnapshot({ date: DATE, caddyIds: [25, 31] });
  const withSnap = parseDailyBoardDraftPayload(
    assignmentDraftToPayload({ ...draft, offSnapshot: snap }),
    DATE
  );
  assert(withSnap.offSnapshot?.caddyIds.join(",") === "25,31", "roundtrip caddyIds");
  const hydrated = payloadToAssignmentDraft(withSnap);
  assert(hydrated.offSnapshot?.date === DATE, "hydrate keeps snapshot");
}

section("availability OFF ids and preserve across applyLiveResult");
{
  assert(
    offCaddyIdsFromAvailability({
      excluded: [
        { id: 10, excludedReasons: ["휴무"] },
        { id: 11, excludedReasons: ["병가"] },
        { id: 12, excludedReasons: ["휴무", "당번"] },
      ],
    }).join(",") === "10,12",
    "휴무 reason only"
  );
  const snap = buildOffSnapshot({ date: DATE, caddyIds: [10] });
  const draft: AssignmentDraft = { ...emptyDraft(), offSnapshot: snap };
  const after = {
    date: DATE,
    assignments: [],
    unusedCaddies: [],
    special: [],
    specialUnassigned: [],
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: draft.openCourses,
    sparesByShift: [],
    unavailableCaddyIds: [99],
    meta: {},
  } as AutoAssignResultV1;
  const next = applyLiveResultToDraft(draft, after);
  assert(next.offSnapshot?.caddyIds.join(",") === "10", "applyLiveResult keeps snapshot");
  assert(next.unavailableCaddyIds?.join(",") === "99", "unavailable still from after");
}

section("source contracts");
{
  const route = readFileSync(
    join(process.cwd(), "src/app/api/assignments/reflow/quick-mutation/route.ts"),
    "utf8"
  );
  const apply = readFileSync(
    join(process.cwd(), "src/lib/quickBoardMutationApply.ts"),
    "utf8"
  );
  const page = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  assert(
    /offSheetMode:\s*"snapshot"/.test(route) &&
      !/offSheetMode:\s*"cache-or-fetch"/.test(route),
    "quick-mutation never cache-or-fetch"
  );
  assert(
    /offSheetMode:\s*"snapshot"/.test(apply) &&
      !/offSheetMode:\s*"cache-or-fetch"/.test(apply),
    "apply fallback is snapshot-only"
  );
  assert(
    page.includes("pipelineMutationOffSnapshotBlock") &&
      page.includes("buildOffSnapshot") &&
      page.includes("offCaddyIdsFromAvailability"),
    "client writes snapshot on availability and gates mutation"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
