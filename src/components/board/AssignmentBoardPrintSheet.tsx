import React from "react";
import { BoardSheetTable } from "@/components/board/BoardSheetTable";
import type { BoardPrintSheet } from "@/lib/assignmentBoardPrint";

/**
 * A4 가로 인쇄용 배치표 = 공통 시트 표(BoardSheetTable) 그대로.
 * /board 화면·PNG·엑셀과 같은 모델/디자인을 쓴다.
 */
export function AssignmentBoardPrintSheet({
  sheet,
  printedAt,
}: {
  sheet: BoardPrintSheet;
  /** 화면에서 만든 출력 시각 문자열 (테스트 재현성을 위해 주입) */
  printedAt?: string | null;
}) {
  return (
    <div
      className="bp-sheet"
      data-board-print-sheet=""
      data-print-shift={sheet.shift}
      data-print-date={sheet.date}
    >
      <BoardSheetTable model={sheet} footnote={printedAt ? `출력 ${printedAt}` : null} />
    </div>
  );
}
