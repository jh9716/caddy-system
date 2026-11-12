/**
 * 배치표 A4 인쇄용 데이터 (읽기 전용).
 * 실제 표 모델은 공통 시트 모델(src/lib/boardSheet.ts)을 그대로 쓴다.
 * - 화면이 들고 있는 draft를 읽기만 한다. 자동배치/순번/Draft·Published write 없음.
 * - 고객명(teamName)은 기존 PNG/Excel export 정책과 같이 기본 제외. 관리자가 켤 때만 표시.
 */

import type { AssignmentDraft } from "@/lib/assignmentDraft";
import {
  BOARD_SHEET_CLOSED_LABEL,
  BOARD_SHEET_NO_RESERVATION_LABEL,
  BOARD_SHEET_TITLE,
  BOARD_SHEET_UNASSIGNED_LABEL,
  buildBoardSheetModel,
  type BoardSheetModel,
} from "@/lib/boardSheet";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

export {
  boardPrintMarks,
  boardPrintWeekday,
  isVacantPrintCaddy,
} from "@/lib/boardSheet";

export const BOARD_PRINT_SHIFTS: readonly ShiftPart[] = SHIFT_PARTS;
export const BOARD_PRINT_TITLE = BOARD_SHEET_TITLE;
export const BOARD_PRINT_UNASSIGNED_LABEL = BOARD_SHEET_UNASSIGNED_LABEL;
export const BOARD_PRINT_CLOSED_LABEL = BOARD_SHEET_CLOSED_LABEL;
export const BOARD_PRINT_EMPTY_COURSE_LABEL = BOARD_SHEET_NO_RESERVATION_LABEL;

export type BoardPrintSheet = BoardSheetModel;

export function isBoardPrintShift(value: unknown): value is ShiftPart {
  return typeof value === "string" && (SHIFT_PARTS as readonly string[]).includes(value);
}

export function buildBoardPrintSheet(
  draft: AssignmentDraft,
  shift: ShiftPart,
  opts?: { includeTeamName?: boolean }
): BoardPrintSheet {
  return buildBoardSheetModel(draft, shift, { includeTeamName: opts?.includeTeamName === true });
}

export function boardPrintDocumentTitle(sheet: Pick<BoardPrintSheet, "date" | "shift">): string {
  return `VERTHILL_배치표_${sheet.date}_${sheet.shift}`;
}
