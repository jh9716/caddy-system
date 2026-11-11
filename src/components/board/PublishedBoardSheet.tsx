"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BoardSheetTable } from "@/components/board/BoardSheetTable";
import { boardSheetCss } from "@/components/board/boardSheetCss";
import { buildBoardSheetModel } from "@/lib/boardSheet";
import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";
import { assignmentDraftForPublishedView } from "@/lib/publishedBoardPrint";
import type { ShiftPart } from "@/lib/reservationParser";

/** 시트 폭 281mm + 좌우 여백 ≈ 1094px (96dpi) */
const SHEET_PX = 1094;
const FIT_KEY = "vh-board-sheet-fit";

/**
 * /board 확정 배치표 = 인쇄·이미지와 같은 공통 시트.
 * PC/모바일 같은 표. 모바일은 가로 스크롤·핀치 확대, "화면 맞춤" 선택 가능.
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapW, setWrapW] = useState(0);
  const [fit, setFit] = useState(false);

  useEffect(() => {
    try {
      setFit(window.localStorage.getItem(FIT_KEY) === "1");
    } catch {
      /* storage 없음 */
    }
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWrapW(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const needsScroll = wrapW > 0 && wrapW < SHEET_PX;
  const zoom = fit && needsScroll ? Math.max(0.25, wrapW / SHEET_PX) : 1;

  return (
    <div className="pub-board-root" data-board-sheet-view="">
      {needsScroll ? (
        <div className="pub-sheet-tools">
          <label>
            <input
              type="checkbox"
              data-board-sheet-fit="1"
              checked={fit}
              onChange={(e) => {
                setFit(e.target.checked);
                try {
                  window.localStorage.setItem(FIT_KEY, e.target.checked ? "1" : "0");
                } catch {
                  /* storage 없음 */
                }
              }}
            />
            화면 맞춤
          </label>
          <span>{fit ? "두 손가락으로 확대할 수 있습니다." : "표를 옆으로 밀어 다른 코스를 봅니다."}</span>
        </div>
      ) : null}
      <div className="pub-sheet-scroll" ref={wrapRef}>
        <div className="pub-sheet-paper" style={zoom !== 1 ? { zoom } : undefined}>
          <BoardSheetTable model={model} />
        </div>
      </div>
      <style>{boardSheetCss + publishedSheetScreenCss}</style>
    </div>
  );
}

const publishedSheetScreenCss = `
.pub-board-root { min-width: 0; max-width: 100%; display: grid; gap: 6px; }
.pub-sheet-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.78rem; color: #475569; }
.pub-sheet-tools label { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; color: #0f172a; }
.pub-sheet-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y pinch-zoom; }
.pub-sheet-paper { box-sizing: border-box; width: max-content; padding: 4mm; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
`;
