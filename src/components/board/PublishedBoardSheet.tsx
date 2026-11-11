"use client";

import { useMemo } from "react";
import { BoardSheetTable } from "@/components/board/BoardSheetTable";
import { BoardSheetMobile, boardSheetMobileCss } from "@/components/board/BoardSheetMobile";
import { boardSheetCss } from "@/components/board/boardSheetCss";
import { buildBoardSheetModel } from "@/lib/boardSheet";
import { buildBoardMobileModel } from "@/lib/boardSheetMobile";
import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";
import { assignmentDraftForPublishedView } from "@/lib/publishedBoardPrint";
import type { ShiftPart } from "@/lib/reservationParser";

/**
 * 시트 폭 281mm + 좌우 여백 ≈ 1094px. 이보다 좁은 화면(휴대폰·태블릿)은
 * 가로 스크롤 대신 모바일 4코스 동시 보기로 바꾼다 (같은 모델, 배치만 다름).
 */
export const BOARD_SHEET_MOBILE_MAX_PX = 1119;

/**
 * /board 확정 배치표.
 * - 넓은 화면: 인쇄·이미지·엑셀과 같은 공통 시트(BoardSheetTable)
 * - 좁은 화면: 4코스 동시 보기(BoardSheetMobile), 가로 스크롤 없음
 * 예약자명은 서버가 준 범위(관리자·조장)만 그대로 표시 — 기존 /board 와 동일.
 */
export default function PublishedBoardSheet({
  payload,
  shift,
}: {
  payload: DailyBoardPublishedPayloadV1;
  shift: ShiftPart;
}) {
  const model = useMemo(
    () =>
      buildBoardSheetModel(assignmentDraftForPublishedView(payload), shift, {
        includeTeamName: true,
        showLock: true,
      }),
    [payload, shift]
  );
  const mobile = useMemo(() => buildBoardMobileModel(model, payload), [model, payload]);

  return (
    <div className="pub-board-root" data-board-sheet-view="">
      <div className="pub-sheet-desktop">
        <div className="pub-sheet-scroll">
          <div className="pub-sheet-paper">
            <BoardSheetTable model={model} />
          </div>
        </div>
      </div>
      <div className="pub-sheet-mobile">
        <BoardSheetMobile model={mobile} />
      </div>
      <style>{boardSheetCss + publishedSheetScreenCss + boardSheetMobileCss}</style>
    </div>
  );
}

const publishedSheetScreenCss = `
.pub-board-root { min-width: 0; max-width: 100%; display: grid; gap: 6px; }
.pub-sheet-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y pinch-zoom; }
.pub-sheet-paper { box-sizing: border-box; width: max-content; padding: 4mm; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
.pub-sheet-mobile { display: none; min-width: 0; }
@media (max-width: ${BOARD_SHEET_MOBILE_MAX_PX}px) {
  .pub-sheet-desktop { display: none; }
  .pub-sheet-mobile { display: block; }
}
`;
