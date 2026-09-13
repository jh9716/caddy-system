/**
 * 배치표 캐디 셀 직접편집 V1 targeted test (DB 없음)
 * 실행: npx tsx scripts/test-assignment-board-cell-edit-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyDirectCaddyEdit,
  DIRECT_EDIT_PROTECTED_MESSAGE,
  DIRECT_EDIT_SHIFT_BLOCKED_MESSAGE,
  isDirectEditProtected,
  listDirectEditCandidates,
  overlayUnassignedVacancies,
  VACANT_CADDY_PLACEHOLDER,
} from "../src/lib/assignmentBoardCellEdit";
import {
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { previewLiveAssignmentChange } from "../src/lib/assignmentChange";
import {
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "../src/lib/autoAssignEngine";
import {
  DRAFT_VERSION_CONFLICT,
  draftAutosaveCandidate,
} from "../src/lib/dailyBoardDraft";
import { buildShiftBoard } from "../src/lib/assignmentBoardView";

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

function caddy(
  id: number,
  extra: Partial<AutoAssignCaddy> = {}
): AutoAssignCaddy {
  return {
    id,
    name: extra.name || `캐디${id}`,
    team: extra.team || `${((id - 1) % 12) + 1}조`,
    teamOrder: extra.teamOrder ?? 1,
    caddyType: extra.caddyType || "HOUSE",
    employmentStatus: extra.employmentStatus || "ACTIVE",
  };
}

function reservation(
  id: string,
  extra: Partial<AutoAssignReservation> = {}
): AutoAssignReservation {
  return {
    id,
    date: "2026-09-13",
    course: extra.course || "SKY",
    shift: extra.shift || "1부",
    teeTime: extra.teeTime || "12:00",
    teamName: extra.teamName || id,
  };
}

function row(
  res: AutoAssignReservation,
  cad: AutoAssignCaddy,
  extra: Partial<AutoAssignmentRow> = {}
): AutoAssignmentRow {
  return {
    date: res.date,
    shift: (res.shift || "1부") as AutoAssignmentRow["shift"],
    sequenceIndex: extra.sequenceIndex ?? 0,
    reason: extra.reason ?? "REGULAR_SEQUENCE",
    reservation: res,
    caddy: cad,
    kind: extra.kind ?? "regular",
    locked: extra.locked,
    pairId: extra.pairId,
    note: extra.note,
  };
}

const cA = caddy(1, { name: "A", team: "1조" });
const cB = caddy(2, { name: "B", team: "1조" });
const cC = caddy(3, { name: "C", team: "2조" });
const cD = caddy(4, { name: "D", team: "2조" });
const spare = caddy(90, { name: "스페어1", team: "3조" });
const spare2 = caddy(91, { name: "스페어2", team: "4조" });
const retired = caddy(99, {
  name: "퇴사자",
  team: "5조",
  employmentStatus: "RETIRED",
});
const deleted = caddy(98, {
  name: "삭제자",
  team: "6조",
  employmentStatus: "DELETED",
});
const otherShift = caddy(7, { name: "2부캐디", team: "7조" });
const lockedCaddy = caddy(8, { name: "락", team: "8조" });

const rA = reservation("A", { teeTime: "12:00", teamName: "A팀" });
const rB = reservation("B", { teeTime: "12:07", teamName: "B팀" });
const rC = reservation("C", { teeTime: "12:14", teamName: "C팀" });
const rEmpty = reservation("E", { teeTime: "12:21", teamName: "빈팀" });
const r2 = reservation("S2", {
  shift: "2부",
  teeTime: "13:00",
  teamName: "2부팀",
  course: "OCEAN",
});
const r54a = reservation("F1", {
  teeTime: "07:00",
  teamName: "54A",
  course: "VERTHILL",
});
const r54b = reservation("F2", {
  teeTime: "13:00",
  shift: "2부",
  teamName: "54B",
  course: "VERTHILL",
});
const rLock = reservation("L", { teeTime: "12:28", teamName: "LOCK팀" });

function makeDraft(
  assignments: AutoAssignmentRow[],
  extra?: Partial<AssignmentDraft>
): AssignmentDraft {
  const pool = [
    cA,
    cB,
    cC,
    cD,
    spare,
    spare2,
    retired,
    deleted,
    otherShift,
    lockedCaddy,
  ];
  const result = {
    date: "2026-09-13",
    assignments,
    fixedAssignments: assignments.filter((a) => a.kind === "fixed"),
    fiftyFourHoleAssignments: assignments.filter((a) => a.kind === "fiftyFourHole"),
    oneThreeAssignments: assignments.filter((a) => a.kind === "oneThree"),
    oneTwoAssignments: assignments.filter((a) => a.kind === "oneTwo"),
    oneMakAssignments: assignments.filter((a) => a.kind === "oneMak"),
    weekendBandAssignments: [],
    regularAssignments: assignments.filter((a) => a.kind === "regular"),
    unassignedReservations: extra?.unassignedReservations || [],
    closedCourseReservations: [],
    unusedCaddies: [spare, spare2, retired, deleted],
    special: [],
    specialUnassigned: [],
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    sparesByShift: extra?.sparesByShift || [
      {
        shift: "1부" as const,
        spare1: {
          caddyId: spare.id,
          name: spare.name,
          team: spare.team,
          teamOrder: spare.teamOrder,
        },
        spare2: {
          caddyId: spare2.id,
          name: spare2.name,
          team: spare2.team,
          teamOrder: spare2.teamOrder,
        },
      },
    ],
    meta: {} as AutoAssignResultV1["meta"],
  };
  const draft = createDraftFromAutoResult(result, pool);
  return {
    ...draft,
    ...extra,
    caddyPool: extra?.caddyPool || pool,
    sparesByShift: extra?.sparesByShift || draft.sparesByShift,
  };
}

function namesOf(draft: AssignmentDraft, shift = "1부"): string[] {
  return draft.assignments
    .filter((a) => String(a.reservation.shift) === shift)
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime))
    .map((a) => a.caddy.name);
}

function emptyResult(assignments: AutoAssignmentRow[]): AutoAssignResultV1 {
  return {
    date: "2026-09-13",
    assignments,
    fixedAssignments: [],
    fiftyFourHoleAssignments: [],
    oneThreeAssignments: [],
    oneTwoAssignments: [],
    oneMakAssignments: [],
    weekendBandAssignments: [],
    regularAssignments: assignments,
    unassignedReservations: [],
    closedCourseReservations: [],
    unusedCaddies: [],
    special: [],
    specialUnassigned: [],
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    sparesByShift: [],
    meta: {} as AutoAssignResultV1["meta"],
  };
}

console.log("== 1. regular A ↔ regular C 직접선택 SWAP ==");
{
  const draft = makeDraft([
    row(rA, cA, { sequenceIndex: 0 }),
    row(rB, cB, { sequenceIndex: 1 }),
    row(rC, cC, { sequenceIndex: 2 }),
    row(r2, otherShift, { sequenceIndex: 0 }),
  ]);
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rA),
    caddyId: cC.id,
  });
  assert(edited.ok && edited.action === "swap", "swap action");
  if (edited.ok && edited.action === "swap") {
    assert(edited.reservationKeyA === reservationKey(rA), "swap key A");
    assert(edited.reservationKeyB === reservationKey(rC), "swap key B");
    assert(namesOf(edited.draft).join(",") === "C,B,A", "12:00 C / 12:07 B / 12:14 A");
    const shift2 = edited.draft.assignments.find(
      (a) => String(a.reservation.shift) === "2부"
    );
    assert(shift2?.caddy.id === otherShift.id, "다른 부 영향 없음");
    assert(
      edited.draft.assignments.find((a) => a.reservation.teamName === "B팀")?.caddy
        .id === cB.id,
      "중간 팀 영향 없음"
    );
    const live = previewLiveAssignmentChange({
      previous: emptyResult(draft.assignments),
      regularCaddyPool: draft.caddyPool,
      change: {
        type: "SWAP_CADDY",
        reservationKeyA: edited.reservationKeyA,
        reservationKeyB: edited.reservationKeyB,
      },
    });
    const one = live.after.assignments.filter(
      (a) => String(a.reservation.shift) === "1부"
    );
    assert(
      one.find((a) => a.reservation.teamName === "A팀")?.caddy.id === cC.id,
      "SWAP_CADDY A gets C"
    );
    assert(
      one.find((a) => a.reservation.teamName === "B팀")?.caddy.id === cB.id,
      "SWAP_CADDY middle stays"
    );
    assert(
      one.find((a) => a.reservation.teamName === "C팀")?.caddy.id === cA.id,
      "SWAP_CADDY C gets A"
    );
  }
}

console.log("== 2. 빈 셀 + spare 바로 배치 ==");
{
  const vacant = row(rEmpty, VACANT_CADDY_PLACEHOLDER, { sequenceIndex: 3 });
  const draft = makeDraft([
    row(rA, cA, { sequenceIndex: 0 }),
    row(rB, cB, { sequenceIndex: 1 }),
    row(rC, cC, { sequenceIndex: 2 }),
    vacant,
  ]);
  const beforeOthers = namesOf(draft).slice(0, 3).join(",");
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rEmpty),
    caddyId: spare.id,
  });
  assert(edited.ok && edited.action === "place", "place action");
  if (edited.ok) {
    assert(
      edited.draft.assignments.find((a) => a.reservation.teamName === "빈팀")?.caddy
        .id === spare.id,
      "빈 셀에 스페어 배치"
    );
    assert(namesOf(edited.draft).slice(0, 3).join(",") === beforeOthers, "기존 regular 유지");
    assert(
      !edited.draft.sparesByShift.some((s) => s.spare1?.caddyId === spare.id),
      "스페어 목록에서 제거"
    );
  }

  const viaUnassigned = makeDraft([row(rA, cA), row(rB, cB), row(rC, cC)], {
    unassignedReservations: [{ reservation: rEmpty, reason: "OPEN" }],
  });
  const placed = applyDirectCaddyEdit(viaUnassigned, {
    reservationKey: reservationKey(rEmpty),
    caddyId: spare.id,
  });
  assert(placed.ok && placed.action === "place", "unassigned 빈 셀 place");
  if (placed.ok) {
    assert(
      placed.draft.assignments.some(
        (a) => a.reservation.teamName === "빈팀" && a.caddy.id === spare.id
      ),
      "unassigned가 해당 셀 배치"
    );
    assert(
      placed.draft.unassignedReservations.every(
        (u) => reservationKey(u.reservation) !== reservationKey(rEmpty)
      ),
      "미배치 목록에서 제거"
    );
  }
}

console.log("== 3. regular 중간 + spare 국소 shift ==");
{
  const draft = makeDraft([
    row(rA, cA, { sequenceIndex: 0 }),
    row(rB, cB, { sequenceIndex: 1 }),
    row(rC, cC, { sequenceIndex: 2 }),
    row(r2, otherShift, { sequenceIndex: 0 }),
  ]);
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rB),
    caddyId: spare.id,
  });
  assert(edited.ok && edited.action === "insert", "insert action");
  if (edited.ok) {
    assert(namesOf(edited.draft).join(",") === "A,스페어1,B", "클릭 위치부터 한 칸씩");
    assert(
      !edited.draft.assignments.some(
        (a) => a.caddy.id === cC.id && String(a.reservation.shift) === "1부"
      ),
      "마지막 regular는 spare boundary로 이탈"
    );
    assert(
      edited.draft.sparesByShift.some(
        (s) => s.spare1?.caddyId === cC.id || s.spare2?.caddyId === cC.id
      ),
      "밀린 C는 spare"
    );
    const shift2 = edited.draft.assignments.find(
      (a) => String(a.reservation.shift) === "2부"
    );
    assert(shift2?.caddy.id === otherShift.id, "다른 부 영향 없음");
    assert(
      edited.draft.assignments.find((a) => a.reservation.teamName === "A팀")?.caddy
        .id === cA.id,
      "클릭 앞 팀 유지"
    );
  }
}

console.log("== 3b. 첫 spare/open boundary(빈 칸)에서 흡수 ==");
{
  const vacant = row(rEmpty, VACANT_CADDY_PLACEHOLDER, { sequenceIndex: 3 });
  const draft = makeDraft([
    row(rA, cA, { sequenceIndex: 0 }),
    row(rB, cB, { sequenceIndex: 1 }),
    row(rC, cC, { sequenceIndex: 2 }),
    vacant,
  ]);
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rB),
    caddyId: spare.id,
  });
  assert(edited.ok && edited.action === "insert", "insert into open boundary");
  if (edited.ok) {
    assert(namesOf(edited.draft).join(",") === "A,스페어1,B,C", "빈 칸이 C를 흡수");
  }
}

console.log("== 4. 다른 팀/다른 부 영향 없음 ==");
{
  const ocean = reservation("X", {
    teeTime: "12:00",
    teamName: "다른코스",
    course: "OCEAN",
  });
  const draft = makeDraft([
    row(rA, cA, { sequenceIndex: 0 }),
    row(rB, cB, { sequenceIndex: 1 }),
    row(rC, cC, { sequenceIndex: 2 }),
    row(ocean, cD, { sequenceIndex: 3 }),
    row(r2, otherShift, { sequenceIndex: 0 }),
  ]);
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rA),
    caddyId: cC.id,
  });
  assert(edited.ok, "swap ok");
  if (edited.ok) {
    assert(
      edited.draft.assignments.find((a) => a.reservation.teamName === "다른코스")?.caddy
        .id === cD.id,
      "다른 코스 팀 유지"
    );
    assert(
      edited.draft.assignments.find((a) => a.reservation.teamName === "2부팀")?.caddy
        .id === otherShift.id,
      "2부 유지"
    );
  }
}

console.log("== 5. RETIRED/삭제 캐디는 picker에 없음 ==");
{
  const draft = makeDraft([row(rA, cA), row(rB, cB), row(rC, cC)]);
  const candidates = listDirectEditCandidates(draft, { shift: "1부" });
  const ids = candidates.map((item) => item.caddy.id);
  assert(!ids.includes(retired.id), "RETIRED 없음");
  assert(!ids.includes(deleted.id), "DELETED 없음");
  assert(ids.includes(spare.id), "ACTIVE spare 있음");
  assert(
    candidates.some((item) => item.group === "assigned" && item.caddy.id === cB.id),
    "이 부 배치 그룹"
  );
  assert(
    candidates.some((item) => item.group === "unassigned" && item.caddy.id === spare.id),
    "미배치/스페어 그룹"
  );
  const retiredApply = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rA),
    caddyId: retired.id,
  });
  assert(!retiredApply.ok, "퇴사자 적용 차단");
}

console.log("== 6. linked 54/special/fixed 차단 ==");
{
  const fiftyFour = row(r54a, cD, {
    kind: "fiftyFourHole",
    pairId: "54H-4-07:00-13:00",
    sequenceIndex: 0,
  });
  const fiftyFourB = row(r54b, cD, {
    kind: "fiftyFourHole",
    pairId: "54H-4-07:00-13:00",
    sequenceIndex: 0,
  });
  const locked = row(rLock, lockedCaddy, { locked: true });
  const draft = makeDraft([
    row(rA, cA),
    row(rB, cB),
    row(rC, cC),
    fiftyFour,
    fiftyFourB,
    locked,
  ]);
  assert(isDirectEditProtected(fiftyFour), "54홀 protected");
  const blocked = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(r54a),
    caddyId: spare.id,
  });
  assert(!blocked.ok, "54홀 직접편집 차단");
  if (!blocked.ok) {
    assert(blocked.message === DIRECT_EDIT_PROTECTED_MESSAGE, "보호 메시지");
  }
  const swapSpecial = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rA),
    caddyId: cD.id,
  });
  assert(!swapSpecial.ok, "특수 캐디와 SWAP 차단");
  const insertIntoLock = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rLock),
    caddyId: spare.id,
  });
  assert(!insertIntoLock.ok, "LOCK 셀 spare 삽입 차단");
  if (!insertIntoLock.ok) {
    assert(
      insertIntoLock.message === DIRECT_EDIT_SHIFT_BLOCKED_MESSAGE ||
        insertIntoLock.message === DIRECT_EDIT_PROTECTED_MESSAGE,
      "LOCK 차단 메시지"
    );
  }
  assert(
    draft.assignments.find((a) => a.pairId === fiftyFour.pairId)?.caddy.id === cD.id,
    "원본 54홀 유지"
  );
}

console.log("== 7. 직접편집 후 Draft autosave candidate ==");
{
  const draft = makeDraft([row(rA, cA), row(rB, cB), row(rC, cC)]);
  const edited = applyDirectCaddyEdit(draft, {
    reservationKey: reservationKey(rA),
    caddyId: cC.id,
  });
  assert(edited.ok, "edit ok");
  if (edited.ok) {
    assert(edited.draft.status === "EDITED", "status EDITED");
    const candidate = draftAutosaveCandidate({
      mutationSucceeded: true,
      draft: edited.draft,
    });
    assert(candidate === edited.draft, "autosave candidate is edited draft");
    assert(
      candidate?.assignments.find((a) => a.reservation.teamName === "A팀")?.caddy
        .id === cC.id,
      "autosave payload has swap"
    );
  }
}

console.log("== 8. concurrent version 409 보호 유지 ==");
{
  const page = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const draftLib = fs.readFileSync(
    path.resolve("src/lib/dailyBoardDraft.ts"),
    "utf8"
  );
  assert(page.includes("applyDirectCaddyEdit"), "page uses applyDirectCaddyEdit");
  assert(
    /action === "swap"[\s\S]*SWAP_CADDY/.test(page) ||
      /SWAP_CADDY[\s\S]*reservationKeyA/.test(page),
    "swap reuses SWAP_CADDY"
  );
  assert(/queueDraftSave\(result\.draft\)/.test(page), "place/insert queueDraftSave");
  assert(
    page.includes("serverDraftVersionRef.current") &&
      page.includes(DRAFT_VERSION_CONFLICT),
    "PUT still sends expected version"
  );
  assert(
    /res\.status === 409/.test(page) && page.includes('setDraftSaveState("conflict")'),
    "409 still marks conflict"
  );
  assert(
    draftLib.includes("DRAFT_VERSION_CONFLICT") &&
      draftLib.includes("다른 직원이 이 날짜 배치표를 수정했습니다"),
    "conflict copy unchanged"
  );
  assert(
    /flushDraftSave/.test(page) && /persistAfterOwnDraftFlush/.test(page),
    "own autosave flush still gates live persist"
  );
}

console.log("== UI: 직접편집 toggle + 기존 context menu 유지 ==");
{
  const page = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const sheet = fs.readFileSync(
    path.resolve("src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const picker = fs.readFileSync(
    path.resolve("src/app/manage/assignments/CaddyCellEditSheet.tsx"),
    "utf8"
  );
  assert(/data-cell-edit-toggle/.test(page), "직접편집 toggle");
  assert(/cellEditOn/.test(page) && /setCellEditOn/.test(page), "toggle state");
  assert(/BoardQuickSheet/.test(page), "BoardQuickSheet still mounted");
  const caddyBlock = sheet.split("qa-caddy-actions")[1] || "";
  assert(/캐디 맞교환/.test(caddyBlock), "기존 SWAP 메뉴");
  assert(/CADDY_SICK/.test(caddyBlock) && /병가/.test(caddyBlock), "기존 병가");
  assert(/CADDY_ATTENDANCE_NOSHOW/.test(caddyBlock), "기존 결근");
  assert(/SET_LOCK/.test(caddyBlock), "기존 LOCK");
  assert(/onStartTeamMove/.test(sheet), "기존 TEAM MOVE");
  assert(/data-caddy-picker/.test(picker), "compact picker");
  assert(/미배치 \/ 스페어/.test(picker) && /이 부 배치/.test(picker), "후보 그룹");
  assert(/병가·결근 등 업무 메뉴/.test(picker), "context menu fallback from picker");
}

console.log("== overlay vacant unassigned cells ==");
{
  const draft = makeDraft([row(rA, cA), row(rB, cB)], {
    unassignedReservations: [{ reservation: rEmpty, reason: "OPEN" }],
  });
  const board = buildShiftBoard(draft.assignments, ["SKY", "OCEAN"], "1부");
  const overlay = overlayUnassignedVacancies({
    board,
    draft,
    shift: "1부",
    openCourses: ["SKY", "OCEAN", "LAKE", "VERTHILL"],
  });
  const emptyRow = overlay.find((tr) => tr.teeTime === "12:21");
  assert(emptyRow?.cells.SKY.kind === "assigned", "빈 예약이 보드 칸으로");
  if (emptyRow?.cells.SKY.kind === "assigned") {
    assert(emptyRow.cells.SKY.rows[0]?.caddy.id === 0, "vacant caddy");
  }
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
