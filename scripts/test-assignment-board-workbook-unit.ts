/**
 * 배치표 엑셀형 편집 헬퍼 (DB 없음)
 * 실행: npx tsx scripts/test-assignment-board-workbook-unit.ts
 */
import fs from "node:fs";
import {
  cloneDraftSnapshot,
  listWorkbookCellCoords,
  neighborWorkbookCell,
  pushWorkbookUndo,
  redoWorkbookState,
  undoWorkbookState,
} from "../src/lib/assignmentBoardWorkbook";
import {
  applyDirectCaddyVacate,
  isDirectEditProtected,
} from "../src/lib/assignmentBoardCellEdit";
import { createDraftFromAutoResult } from "../src/lib/assignmentDraft";
import { buildShiftBoard } from "../src/lib/assignmentBoardView";
import {
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
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

function caddy(id: number, name: string): AutoAssignCaddy {
  return { id, name, team: "1조", teamOrder: id, caddyType: "HOUSE" };
}

function reservation(
  id: string,
  extra: Partial<AutoAssignReservation> = {}
): AutoAssignReservation {
  return {
    id,
    date: "2026-09-16",
    course: extra.course || "SKY",
    shift: extra.shift || "1부",
    teeTime: extra.teeTime || "07:00",
    teamName: extra.teamName || id,
  };
}

function row(
  res: AutoAssignReservation,
  cad: AutoAssignCaddy,
  extra: Partial<AutoAssignmentRow> = {}
): AutoAssignmentRow {
  return {
    date: "2026-09-16",
    shift: "1부",
    sequenceIndex: 0,
    reason: "REGULAR_SEQUENCE",
    reservation: res,
    caddy: cad,
    kind: extra.kind ?? "regular",
  };
}

function makeResult(assignments: AutoAssignmentRow[]): AutoAssignResultV1 {
  return {
    date: "2026-09-16",
    assignments,
    fixedAssignments: [],
    fiftyFourHoleAssignments: [],
    oneThreeAssignments: [],
    oneTwoAssignments: [],
    twoAssignments: [],
    twoThreeAssignments: [],
    oneMakAssignments: [],
    weekendBandAssignments: [],
    regularAssignments: assignments.filter((a) => a.kind === "regular"),
    unassignedReservations: [],
    closedCourseReservations: [],
    unusedCaddies: [],
    special: [],
    specialUnassigned: [],
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    sparesByShift: [{ shift: "1부", spare1: null, spare2: null }],
    meta: {} as AutoAssignResultV1["meta"],
  };
}

section("undo/redo stack");
{
  const a = { n: 1 };
  const b = { n: 2 };
  const c = { n: 3 };
  let undo = pushWorkbookUndo([], a);
  undo = pushWorkbookUndo(undo, b);
  const stepped = undoWorkbookState({ undo, redo: [], current: c });
  assert(stepped?.current.n === 2, "undo → b");
  const redone = redoWorkbookState({
    undo: stepped!.undo,
    redo: stepped!.redo,
    current: stepped!.current,
  });
  assert(redone?.current.n === 3, "redo → c");
}

section("셀 좌표 · 화살표");
{
  const r1 = reservation("a", { course: "SKY", teeTime: "07:00" });
  const r2 = reservation("b", { course: "OCEAN", teeTime: "07:00" });
  const r3 = reservation("c", { course: "SKY", teeTime: "07:08" });
  const board = buildShiftBoard(
    [row(r1, caddy(1, "A")), row(r2, caddy(2, "B")), row(r3, caddy(3, "C"))],
    ["SKY", "OCEAN"],
    "1부"
  );
  const coords = listWorkbookCellCoords(board, ["SKY", "OCEAN"]);
  assert(coords.length >= 2, "좌표 생성");
  const right = neighborWorkbookCell(coords, coords[0], { dCol: 1 });
  assert(right?.course === "OCEAN", "오른쪽 코스");
  const down = neighborWorkbookCell(coords, coords[0], { dRow: 1 });
  assert(down?.teeTime === "07:08", "아래 티타임");
}

section("빈 칸 되돌리기 · 특수 보호");
{
  const rA = reservation("a", { course: "SKY", teeTime: "07:00" });
  const cad = caddy(1, "A");
  const draft = createDraftFromAutoResult(makeResult([row(rA, cad)]), [cad]);
  const vacated = applyDirectCaddyVacate(draft, reservationKey(rA));
  assert(vacated.ok, "vacate ok");
  if (vacated.ok && vacated.action !== "noop") {
    assert(vacated.draft.assignments[0]?.caddy.id === 0, "빈 칸");
    assert(vacated.draft.sparesByShift[0]?.spare1?.caddyId === 1, "스페어로");
  }
  assert(isDirectEditProtected(row(rA, cad, { kind: "two" })), "2부 단독 직접편집 보호");
  const cloned = cloneDraftSnapshot(draft);
  cloned.assignments[0].caddy.name = "X";
  assert(draft.assignments[0].caddy.name === "A", "snapshot 분리");
}

section("UI 재사용 · 엑셀편집");
{
  const page = fs.readFileSync("src/app/manage/assignments/page.tsx", "utf8");
  assert(/엑셀편집/.test(page), "엑셀편집 토글");
  assert(/undoWorkbookEdit/.test(page), "취소");
  assert(/applyDirectCaddyEdit/.test(page), "V3 직접편집 재사용");
  assert(/overlayUnassignedVacancies/.test(page), "빈 슬롯 overlay 재사용");
  assert(/CaddyCellEditSheet/.test(page), "검색 배치 시트 재사용");
  assert(/neighborWorkbookCell/.test(page), "화살표 셀 이동");
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nALL PASSED ${passed}`);
