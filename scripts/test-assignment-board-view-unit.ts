/**
 * 배치표(시간×코스) 표시 헬퍼 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-assignment-board-view-unit.ts
 */

import {
  boardAssignmentMarks,
  buildShiftBoard,
  countBoardAssignments,
  filterAssignmentsByShift,
  isChageunAssignment,
  isTwoWorkAssignment,
} from "../src/lib/assignmentBoardView";
import type { AutoAssignmentRow } from "../src/lib/autoAssignEngine";
import { REASON } from "../src/lib/autoAssignEngine";
import { COURSE_CODES, type ShiftPart } from "../src/lib/reservationParser";

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

function row(
  shift: ShiftPart,
  teeTime: string,
  course: string,
  id: string,
  extra?: Partial<AutoAssignmentRow> & { caddyId?: number; caddyName?: string }
): AutoAssignmentRow {
  const base = {
    date: "2026-08-20",
    shift,
    sequenceIndex: 0,
    reason: extra?.reason ?? "TEST",
    kind: extra?.kind ?? "regular",
    pairId: null,
    reservation: {
      id,
      date: "2026-08-20",
      course,
      shift,
      teeTime,
      teamName: id,
      rawRowIndex: 1,
    },
    caddy: {
      id: extra?.caddyId ?? Number(id.replace(/\D/g, "") || 1),
      name: extra?.caddyName ?? `C${id}`,
      team: "1조",
      teamOrder: 1,
    },
  } as AutoAssignmentRow;
  if (extra?.note) base.note = extra.note;
  return base;
}

section("부 필터: reservation.shift 기준 (시간 무시)");
{
  const rows = [
    row("1부", "11:41", "VERTHILL", "A1"),
    row("2부", "11:20", "VERTHILL", "B1"),
    row("2부", "11:27", "SKY", "B2"),
    row("2부", "11:34", "OCEAN", "B3"),
    row("2부", "11:41", "LAKE", "B4"),
    row("2부", "11:48", "VERTHILL", "B5"),
    row("2부", "11:55", "SKY", "B6"),
  ];
  const s1 = filterAssignmentsByShift(rows, "1부");
  const s2 = filterAssignmentsByShift(rows, "2부");
  assert(s1.length === 1 && s1[0].reservation.teeTime === "11:41", "1부 only 11:41");
  assert(s2.length === 6, "2부 keeps 11:20–11:55");
  assert(
    !s1.some((r) => r.reservation.teeTime === "11:20"),
    "1부 must not include 11:20"
  );
}

section("회귀: 1부 후반·2부 초반 같은 시간대도 절대 합치지 않음");
{
  const rows = [
    row("1부", "11:41", "VERTHILL", "S1V"),
    row("1부", "11:41", "SKY", "S1S"),
    row("2부", "11:41", "VERTHILL", "S2V"),
    row("2부", "11:20", "OCEAN", "S2O"),
  ];
  const board1 = buildShiftBoard(rows, COURSE_CODES, "1부");
  const board2 = buildShiftBoard(rows, COURSE_CODES, "2부");
  assert(
    board1.every((tr) =>
      COURSE_CODES.every((c) => {
        const cell = tr.cells[c];
        if (cell.kind !== "assigned") return true;
        return cell.rows.every((r) => r.reservation.shift === "1부");
      })
    ),
    "board1 only 1부 rows"
  );
  assert(
    board2.every((tr) =>
      COURSE_CODES.every((c) => {
        const cell = tr.cells[c];
        if (cell.kind !== "assigned") return true;
        return cell.rows.every((r) => r.reservation.shift === "2부");
      })
    ),
    "board2 only 2부 rows"
  );
  const t1120 = board1.find((tr) => tr.teeTime === "11:20");
  assert(!t1120, "1부 board has no 11:20 row");
  const t1141_1 = board1.find((tr) => tr.teeTime === "11:41");
  const t1141_2 = board2.find((tr) => tr.teeTime === "11:41");
  assert(!!t1141_1 && !!t1141_2, "same teeTime can exist on both boards");
  assert(
    t1141_1!.cells.VERTHILL.kind === "assigned" &&
      t1141_1!.cells.VERTHILL.kind === "assigned" &&
      (t1141_1!.cells.VERTHILL as { rows: AutoAssignmentRow[] }).rows[0]
        .reservation.id === "S1V",
    "1부 11:41 VERTHILL is S1V"
  );
  assert(
    t1141_2!.cells.VERTHILL.kind === "assigned" &&
      (t1141_2!.cells.VERTHILL as { rows: AutoAssignmentRow[] }).rows[0]
        .reservation.id === "S2V",
    "2부 11:41 VERTHILL is S2V (not merged)"
  );
}

section("matrix 셀 assignment 합계 === 해당 부 assignment 개수");
{
  const rows = [
    row("1부", "06:30", "VERTHILL", "1"),
    row("1부", "06:30", "SKY", "2"),
    row("1부", "06:37", "OCEAN", "3"),
    row("2부", "11:20", "VERTHILL", "4"),
    row("2부", "11:20", "SKY", "5"),
    row("2부", "11:27", "LAKE", "6"),
    row("3부", "16:00", "VERTHILL", "7"),
  ];
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    const filtered = filterAssignmentsByShift(rows, shift);
    const board = buildShiftBoard(rows, COURSE_CODES, shift);
    assert(
      countBoardAssignments(board) === filtered.length,
      `${shift}: board count ${countBoardAssignments(board)} === ${filtered.length}`
    );
  }
}

section("닫힌 코스 셀은 개수에 포함되지 않음 / 배정 행만 카운트");
{
  const rows = [
    row("1부", "07:00", "VERTHILL", "V"),
    row("1부", "07:00", "OCEAN", "O"),
  ];
  const open = ["VERTHILL", "SKY", "LAKE"] as const;
  const board = buildShiftBoard(rows, open, "1부");
  assert(board[0].cells.OCEAN.kind === "closed", "OCEAN closed");
  // OCEAN assignment is still in filtered rows but course closed → not placed in assigned cell
  // countBoardAssignments only counts assigned cells; OCEAN row dropped from board cells
  assert(countBoardAssignments(board) === 1, "only VERTHILL counted when OCEAN closed");
}

section("row.shift와 reservation.shift 불일치 시 reservation 우선");
{
  const mismatched: AutoAssignmentRow = {
    ...row("1부", "11:20", "VERTHILL", "X"),
    shift: "1부",
    reservation: {
      id: "X",
      date: "2026-08-20",
      course: "VERTHILL",
      shift: "2부",
      teeTime: "11:20",
      teamName: "X",
    },
  };
  assert(
    filterAssignmentsByShift([mismatched], "2부").length === 1,
    "reservation.shift=2부 wins"
  );
  assert(
    filterAssignmentsByShift([mismatched], "1부").length === 0,
    "row.shift=1부 ignored when reservation says 2부"
  );
  const board1 = buildShiftBoard([mismatched], COURSE_CODES, "1부");
  assert(countBoardAssignments(board1) === 0, "1부 board empty");
  const board2 = buildShiftBoard([mismatched], COURSE_CODES, "2부");
  assert(countBoardAssignments(board2) === 1, "2부 board has it");
}

section("투근무: 같은 날짜 앞 부 근무 후 재배치만 표시");
{
  const first = row("1부", "06:00", "VERTHILL", "W1", {
    caddyId: 10,
    caddyName: "투캐디",
  });
  const second = row("2부", "11:30", "SKY", "W2", {
    caddyId: 10,
    caddyName: "투캐디",
  });
  const other = row("2부", "11:37", "OCEAN", "W3", {
    caddyId: 11,
    caddyName: "일반",
  });
  const all = [first, second, other];
  assert(isTwoWorkAssignment(first, all) === false, "1부 첫 근무는 투 아님");
  assert(isTwoWorkAssignment(second, all) === true, "2부 재배치는 투");
  assert(isTwoWorkAssignment(other, all) === false, "다른 캐디 2부는 투 아님");
  assert(
    boardAssignmentMarks(second, all).twoWork === true &&
      boardAssignmentMarks(other, all).twoWork === false,
    "marks.twoWork 구분"
  );
}

section("찾근: fixed+찾근 reason만, 일반/54홀은 유지");
{
  const call = row("1부", "06:07", "VERTHILL", "C1", {
    caddyId: 20,
    kind: "fixed",
    reason: REASON.SPECIAL_CALL,
  });
  const marshal = row("2부", "11:30", "SKY", "C2", {
    caddyId: 21,
    kind: "fixed",
    reason: REASON.MARSHAL_CALL,
    note: "마샬찾근",
  });
  const fiftyFour = row("1부", "06:14", "OCEAN", "C3", {
    caddyId: 22,
    kind: "fiftyFourHole",
    reason: REASON.FIFTY_FOUR_HOLE_PRIORITY,
  });
  const regular = row("3부", "15:00", "LAKE", "C4", { caddyId: 23 });
  assert(isChageunAssignment(call) === true, "SPECIAL_CALL = 찾근");
  assert(isChageunAssignment(marshal) === true, "마샬찾근 = 찾근");
  assert(isChageunAssignment(fiftyFour) === false, "54홀은 찾근 아님");
  assert(isChageunAssignment(regular) === false, "일반 원번은 찾근 아님");
  assert(
    boardAssignmentMarks(call, [call]).chageun === true &&
      boardAssignmentMarks(regular, [regular]).chageun === false,
    "일반 근무 표시 유지"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
