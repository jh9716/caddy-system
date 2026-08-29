/**
 * Next-move intent buffer — no DB.
 * Run: npm run test:next-move-intent-unit
 */
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
} from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  createDraftFromAutoResult,
  reservationIdentity,
} from "../src/lib/assignmentDraft";
import {
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
} from "../src/lib/assignmentChange";
import {
  NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST,
  NEXT_MOVE_DEST_OCCUPIED_TOAST,
  NEXT_MOVE_SOURCE_GONE_TOAST,
  destOccupiedOnDraft,
  nextMoveIntentFromChange,
  prepareNextMoveOnConfirmedDraft,
  readQuickMoveTestDelayMs,
  readQuickMoveTestFail,
  replacePendingNextMove,
  resolvePendingAfterLeadingPersist,
  validateNextMoveIntentOnDraft,
} from "../src/lib/nextMoveIntent";

const DATE = "2099-12-15";

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

function pool(): AutoAssignCaddy[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    name: `캐디${i + 1}`,
    team: `${(i % 6) + 1}조`,
    teamOrder: i + 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  }));
}

function seededDraft() {
  const caddies = pool();
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: caddies,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    reservations: [
      {
        date: DATE,
        course: "SKY",
        shift: "1부",
        teeTime: "07:00",
        teamName: "엑셀이동팀",
        rawRowIndex: 21,
        sourceSheet: "예약1부",
      },
      {
        id: "db-sky-2",
        date: DATE,
        course: "OCEAN",
        shift: "1부",
        teeTime: "07:00",
        teamName: "DB이동팀",
        rawRowIndex: 22,
        sourceSheet: "예약1부",
      },
      {
        date: DATE,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "엑셀B",
        rawRowIndex: 23,
        sourceSheet: "예약1부",
      },
    ],
  });
  return createDraftFromAutoResult(result, caddies);
}

function teamRow(draft: ReturnType<typeof seededDraft>, teamName: string) {
  const row = draft.assignments.find((a) => a.reservation.teamName === teamName);
  if (!row) throw new Error(`missing ${teamName}`);
  return row;
}

function slot(draft: ReturnType<typeof seededDraft>, teamName: string) {
  const row = teamRow(draft, teamName);
  return `${row.reservation.course} ${row.shift || row.reservation.shift} ${row.reservation.teeTime}`;
}

const draft = seededDraft();
const uidRow = teamRow(draft, "엑셀이동팀");
const idRow = teamRow(draft, "DB이동팀");
const uidKey = reservationIdentity(uidRow.reservation);
const idKey = reservationIdentity(idRow.reservation);

console.log("== identity ==");
assert(uidKey.startsWith("uid:"), "엑셀이동팀 is uid");
assert(idKey.startsWith("id:"), "DB이동팀 is id");

console.log("== intent from change ==");
{
  const uidIntent = nextMoveIntentFromChange(
    makeMoveReservationChange({
      reservationKey: uidKey,
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    })
  );
  const idIntent = nextMoveIntentFromChange(
    makeMoveReservationChange({
      reservationKey: idKey,
      reservationId: idRow.reservation.id,
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
    })
  );
  assert(uidIntent?.sourceKey === uidKey, "uid intent keeps sourceKey");
  assert(idIntent?.sourceId === idRow.reservation.id, "id intent keeps sourceId");
  assert(
    nextMoveIntentFromChange({ type: "ADD_RESERVATION" }) === null,
    "non-MOVE is not an intent"
  );
}

console.log("== validate on draft ==");
{
  const ok = validateNextMoveIntentOnDraft(draft, {
    sourceKey: uidKey,
    dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
  });
  assert(ok.ok === true, "empty dest is valid");
  const occupied = validateNextMoveIntentOnDraft(draft, {
    sourceKey: uidKey,
    dest: { course: "OCEAN", shift: "1부", teeTime: "07:00" },
  });
  assert(
    occupied.ok === false && occupied.code === "DEST_OCCUPIED",
    "occupied dest is blocked"
  );
  assert(
    occupied.ok === false && occupied.message === NEXT_MOVE_DEST_OCCUPIED_TOAST,
    "occupied dest uses the operator message"
  );
  const missing = validateNextMoveIntentOnDraft(draft, {
    sourceKey: "uid:missing",
    dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
  });
  assert(
    missing.ok === false &&
      missing.code === "SOURCE_MISSING" &&
      missing.message === NEXT_MOVE_SOURCE_GONE_TOAST,
    "missing source is blocked"
  );
}

console.log("== prepare B on A-confirmed draft ==");
{
  const aChange = makeMoveReservationChange({
    reservationKey: uidKey,
    to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
  });
  const aPreview = previewLiveChangeFromDraft({ draft, change: aChange });
  const confirmed = applyLiveResultToDraft(draft, aPreview.after);
  assert(slot(confirmed, "엑셀이동팀") === "VERTHILL 1부 07:00", "A is on confirmed draft");
  assert(!destOccupiedOnDraft(confirmed, { course: "SKY", shift: "1부", teeTime: "07:00" }), "A old slot is empty");

  const bUidThenId = prepareNextMoveOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent: {
      sourceKey: idKey,
      sourceId: idRow.reservation.id,
      dest: { course: "SKY", shift: "1부", teeTime: "07:00" },
    },
  });
  assert(bUidThenId.ok === true, "B id move recomputes on A-confirmed draft");
  if (bUidThenId.ok) {
    assert(
      slot(bUidThenId.painted, "DB이동팀") === "SKY 1부 07:00",
      "B id painted from confirmed A, not stale original"
    );
    assert(
      slot(bUidThenId.painted, "엑셀이동팀") === "VERTHILL 1부 07:00",
      "A stays on B painted draft"
    );
  }

  const aIdChange = makeMoveReservationChange({
    reservationKey: idKey,
    reservationId: idRow.reservation.id,
    to: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
  });
  const aIdPreview = previewLiveChangeFromDraft({ draft, change: aIdChange });
  const confirmedId = applyLiveResultToDraft(draft, aIdPreview.after);
  const bIdThenUid = prepareNextMoveOnConfirmedDraft({
    confirmedDraft: confirmedId,
    intent: {
      sourceKey: uidKey,
      dest: { course: "OCEAN", shift: "1부", teeTime: "07:00" },
    },
  });
  assert(bIdThenUid.ok === true, "B uid move recomputes on A-id confirmed draft");

  const conflict = prepareNextMoveOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent: {
      sourceKey: idKey,
      dest: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    },
  });
  assert(
    conflict.ok === false && conflict.code === "DEST_OCCUPIED",
    "B dest occupied after A is blocked; A draft is unchanged"
  );
  assert(slot(confirmed, "엑셀이동팀") === "VERTHILL 1부 07:00", "A remains after B block");
  assert(slot(confirmed, "DB이동팀") === "OCEAN 1부 07:00", "B remains after dest conflict");
}

console.log("== max 1 pending + A fail cancels B ==");
{
  const first = nextMoveIntentFromChange(
    makeMoveReservationChange({
      reservationKey: uidKey,
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    })
  );
  const second = nextMoveIntentFromChange(
    makeMoveReservationChange({
      reservationKey: idKey,
      reservationId: idRow.reservation.id,
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:08" },
    })
  );
  assert(first && second, "two intents built");
  const replaced = replacePendingNextMove(first, second!);
  assert(replaced.sourceKey === idKey, "replace keeps only the latest pending");
  const fail = resolvePendingAfterLeadingPersist({
    leadingOk: false,
    pending: replaced,
  });
  assert(fail.autoRun === false, "A fail does not auto-run B");
  assert(fail.pending === null, "A fail drops pending B");
  assert(
    fail.toast === NEXT_MOVE_CANCELLED_AFTER_FAIL_TOAST,
    "A fail uses the required cancel toast"
  );
  const ok = resolvePendingAfterLeadingPersist({
    leadingOk: true,
    pending: replaced,
  });
  assert(ok.autoRun === true && ok.pending?.sourceKey === idKey, "A success auto-runs pending B");
}

console.log("== local-only test knobs ==");
{
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  assert(readQuickMoveTestDelayMs("?quickMoveDelay=1500") === 1500, "delay query is 1500");
  assert(readQuickMoveTestFail("?quickMoveFail=1") === "error", "fail query is live error");
  process.env.NODE_ENV = "production";
  assert(readQuickMoveTestDelayMs("?quickMoveDelay=1500") === 0, "production ignores delay query");
  assert(readQuickMoveTestFail("?quickMoveFail=1") === null, "production ignores fail query");
  process.env.NODE_ENV = prev;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
