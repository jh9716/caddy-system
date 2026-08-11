/**
 * 배치 운영 draft 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-assignment-draft-unit.ts
 */
import {
  assignCaddyToUnassigned,
  confirmDraft,
  createDraftFromAutoResult,
  detectDraftWarnings,
  replaceAssignmentCaddy,
  swapAssignmentCaddies,
  unassignReservation,
  unusedCaddies,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";

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

function pool(n: number): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `C${i + 1}`,
    team: `${(i % 12) + 1}조`,
    teamOrder: 1,
  }));
}

function reservations(date: string): AutoAssignReservation[] {
  return [
    {
      id: "A",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:00",
      teamName: "a",
      rawRowIndex: 2,
    },
    {
      id: "B",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:08",
      teamName: "b",
      rawRowIndex: 3,
    },
    {
      id: "C",
      date,
      course: "SKY",
      shift: "2부",
      teeTime: "13:00",
      teamName: "c",
      rawRowIndex: 4,
    },
  ];
}

section("create DRAFT + confirm");
{
  const date = "2026-11-01";
  const result = computeAutoAssignmentsV1({
    date,
    available: pool(5),
    reservations: reservations(date),
  });
  const draft = createDraftFromAutoResult(result);
  assert(draft.status === "DRAFT", "status DRAFT");
  assert(draft.assignments.length === 3, "3 assignments");
  const confirmed = confirmDraft(draft);
  assert(confirmed.status === "CONFIRMED", "CONFIRMED");
  assert(!!confirmed.confirmedAt, "confirmedAt set");
}

section("replace / swap / assign unassigned → EDITED");
{
  const date = "2026-11-02";
  const available = pool(5);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date),
  });
  let draft = createDraftFromAutoResult(result, available);
  const keyA = reservationKey(draft.assignments[0].reservation);
  const keyB = reservationKey(draft.assignments[1].reservation);
  const free = unusedCaddies(draft)[0];
  assert(!!free, "has unused");

  const replaced = replaceAssignmentCaddy(draft, keyA, free.id);
  assert(replaced.draft.status === "EDITED", "replace → EDITED");
  assert(replaced.draft.assignments[0].caddy.id === free.id, "replaced caddy");
  draft = replaced.draft;

  const swapped = swapAssignmentCaddies(
    draft,
    reservationKey(draft.assignments[0].reservation),
    keyB
  );
  assert(swapped.draft.status === "EDITED", "swap keeps EDITED");
  draft = swapped.draft;

  // unassign one then reassign
  const key0 = reservationKey(draft.assignments[0].reservation);
  const u = unassignReservation(draft, key0);
  draft = u.draft;
  assert(draft.unassignedReservations.length >= 1, "unassigned exists");
  const free2 = unusedCaddies(draft)[0];
  const assigned = assignCaddyToUnassigned(
    draft,
    reservationKey(draft.unassignedReservations[0].reservation),
    free2.id
  );
  assert(assigned.draft.assignments.length >= 2, "reassigned");
  assert(
    assigned.draft.assignments.some((a) => a.reason === "MANUAL_ASSIGN"),
    "MANUAL_ASSIGN reason"
  );
}

section("same-shift duplicate / multi-shift ok");
{
  const date = "2026-11-03";
  const available = pool(3);
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date).slice(0, 2),
  });
  let draft = createDraftFromAutoResult(result, available);
  const keyB = reservationKey(draft.assignments[1].reservation);
  const sameId = draft.assignments[0].caddy.id;
  const dup = replaceAssignmentCaddy(draft, keyB, sameId);
  assert(
    dup.warnings.some((w) => w.code === "SAME_SHIFT_DUPLICATE"),
    "same-shift duplicate warning"
  );
  const detected = detectDraftWarnings(dup.draft);
  assert(
    detected.some((w) => w.code === "SAME_SHIFT_DUPLICATE"),
    "detectDraftWarnings finds SAME_SHIFT_DUPLICATE"
  );

  // 정상 1부+2부 다회근무는 duplicate error 없음
  const multiDate = "2026-11-13";
  const multi = computeAutoAssignmentsV1({
    date: multiDate,
    available: pool(5),
    reservations: [
      {
        id: "M1",
        date: multiDate,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "a",
        rawRowIndex: 1,
      },
      {
        id: "M2",
        date: multiDate,
        course: "LAKE",
        shift: "2부",
        teeTime: "13:00",
        teamName: "b",
        rawRowIndex: 2,
      },
    ],
  });
  const multiDraft = createDraftFromAutoResult(multi, pool(5));
  // 강제로 같은 캐디를 1·2부에 배치
  const k2 = reservationKey(multiDraft.assignments[1].reservation);
  const forced = replaceAssignmentCaddy(
    multiDraft,
    k2,
    multiDraft.assignments[0].caddy.id
  );
  const multiWarns = detectDraftWarnings(forced.draft);
  assert(
    !multiWarns.some((w) => w.code === "SAME_SHIFT_DUPLICATE"),
    "1+2 multi-duty is not SAME_SHIFT_DUPLICATE"
  );
  assert(
    !multiWarns.some((w) => w.code === "DUPLICATE_CADDY"),
    "no legacy DUPLICATE_CADDY for multi-shift"
  );
}

section("special edit requires confirm");
{
  const date = "2026-11-04";
  const available = pool(4);
  const fixed = { id: 99, name: "고정", team: "1조", teamOrder: 1 };
  const result = computeAutoAssignmentsV1({
    date,
    available,
    caddyDirectory: [fixed],
    fixedAssignments: [
      { caddyId: 99, reservationId: "FX", type: "FIXED" },
    ],
    reservations: [
      {
        id: "FX",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:00",
        teamName: "fx",
        rawRowIndex: 2,
      },
      {
        id: "G1",
        date,
        course: "LAKE",
        shift: "1부",
        teeTime: "07:08",
        teamName: "g",
        rawRowIndex: 3,
      },
    ],
  });
  const draft = createDraftFromAutoResult(result, [...available, fixed]);
  const fx = draft.assignments.find((a) => a.kind === "fixed");
  assert(!!fx, "has fixed row");
  const key = reservationKey(fx!.reservation);
  const blocked = replaceAssignmentCaddy(draft, key, available[0].id);
  assert(blocked.specialEditWarned, "special warn");
  assert(blocked.draft.status === "DRAFT", "no edit without confirm");
  const allowed = replaceAssignmentCaddy(draft, key, available[0].id, {
    allowSpecialEdit: true,
  });
  assert(allowed.draft.status === "EDITED", "special edit after confirm");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
