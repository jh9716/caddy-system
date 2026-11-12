import React from "react";
import { BoardSheetTable } from "@/components/board/BoardSheetTable";
import { boardSheetCss } from "@/components/board/boardSheetCss";
import type { BoardSheetModel } from "@/lib/boardSheet";

/**
 * 배치표 이미지(PNG)용 = A4 가로 용지 모양에 공통 시트 표.
 * 인쇄·/board 와 같은 모델·디자인. 예약자명은 모델에서 이미 제외(기본).
 */
export function BoardSheetExportView({ model }: { model: BoardSheetModel }) {
  return (
    <div className="bse-root" data-board-export-root="" data-export-shift={model.shift}>
      <BoardSheetTable model={model} />
      <style>{`${boardSheetCss}
        .bse-root { box-sizing: border-box; width: 297mm; padding: 8mm; background: #fff; }
      `}</style>
    </div>
  );
}
