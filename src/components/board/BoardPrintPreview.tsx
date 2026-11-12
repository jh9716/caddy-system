"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AssignmentBoardPrintSheet } from "@/components/board/AssignmentBoardPrintSheet";
import {
  BOARD_PRINT_BODY_CLASS,
  BOARD_PRINT_PORTAL_CLASS,
  assignmentBoardPrintOverlayCss,
  assignmentBoardPrintSheetCss,
} from "@/components/board/assignmentBoardPrintCss";
import {
  BOARD_PRINT_SHIFTS,
  boardPrintDocumentTitle,
  buildBoardPrintSheet,
} from "@/lib/assignmentBoardPrint";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { ShiftPart } from "@/lib/reservationParser";

/** A4 297mm ≈ 1123 CSS px (96dpi) */
const PAPER_WIDTH_PX = 1123;

function nowLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 배치표 A4 인쇄 미리보기 (읽기 전용).
 * draft는 화면이 들고 있는 최신 상태를 그대로 읽는다. 저장/자동배치/API 호출 없음.
 */
export const BOARD_PRINT_DEFAULT_HINT =
  "인쇄 창에서 용지 A4 · 가로 방향 · 배율 기본(100%)을 확인하세요. 저장되지 않은 화면 수정도 그대로 반영됩니다.";

export function BoardPrintPreview({
  draft,
  initialShift,
  onClose,
  allowTeamName = true,
  hint = BOARD_PRINT_DEFAULT_HINT,
}: {
  draft: AssignmentDraft;
  initialShift?: ShiftPart | null;
  onClose: () => void;
  /** false면 "예약자명 표시" 옵션 자체를 숨기고 항상 비표시 (/board Published 정책) */
  allowTeamName?: boolean;
  hint?: string;
}) {
  const [shift, setShift] = useState<ShiftPart>(initialShift || "1부");
  const [teamNameChecked, setIncludeTeamName] = useState(false);
  const includeTeamName = allowTeamName && teamNameChecked;
  const [fit, setFit] = useState(true);
  const [viewportW, setViewportW] = useState<number>(() =>
    typeof window === "undefined" ? PAPER_WIDTH_PX : window.innerWidth
  );
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const [printedAt, setPrintedAt] = useState<string>(() => nowLabel());
  /** 인쇄 중 바꾼 문서 제목. afterprint가 오지 않는 브라우저도 닫을 때 원복한다. */
  const savedTitleRef = useRef<string | null>(null);

  const sheet = useMemo(
    () => buildBoardPrintSheet(draft, shift, { includeTeamName }),
    [draft, shift, includeTeamName]
  );

  useEffect(() => {
    const node = document.createElement("div");
    node.className = BOARD_PRINT_PORTAL_CLASS;
    node.setAttribute("data-board-print-preview", "");
    document.body.appendChild(node);
    document.body.classList.add(BOARD_PRINT_BODY_CLASS);
    setMountNode(node);
    const onResize = () => setViewportW(window.innerWidth);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove(BOARD_PRINT_BODY_CLASS);
      node.remove();
      if (savedTitleRef.current != null) {
        document.title = savedTitleRef.current;
        savedTitleRef.current = null;
      }
    };
  }, [onClose]);

  function doPrint() {
    setPrintedAt(nowLabel());
    if (savedTitleRef.current == null) savedTitleRef.current = document.title;
    document.title = boardPrintDocumentTitle(sheet);
    const restore = () => {
      if (savedTitleRef.current != null) document.title = savedTitleRef.current;
      savedTitleRef.current = null;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    // printedAt 반영 후 인쇄
    window.setTimeout(() => window.print(), 50);
  }

  const zoom = fit ? Math.min(1, Math.max(0.25, (viewportW - 16) / PAPER_WIDTH_PX)) : 1;

  if (!mountNode) return null;
  return createPortal(
    <>
      <div className="bp-toolbar" role="toolbar" aria-label="배치표 인쇄">
        <span className="bp-toolbar-title">배치표 인쇄 (A4 가로)</span>
        <div className="bp-shift-tabs" role="group" aria-label="인쇄할 부">
          {BOARD_PRINT_SHIFTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={shift === s}
              data-print-shift-tab={s}
              onClick={() => setShift(s)}
            >
              {s}
            </button>
          ))}
        </div>
        {allowTeamName ? (
          <label>
            <input
              type="checkbox"
              data-print-team-name="1"
              checked={includeTeamName}
              onChange={(e) => setIncludeTeamName(e.target.checked)}
            />
            예약자명 표시
          </label>
        ) : null}
        <label>
          <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
          화면 맞춤
        </label>
        <div className="bp-toolbar-end">
          <button type="button" className="bp-btn primary" data-board-print-go="1" onClick={doPrint}>
            {shift} 인쇄
          </button>
          <button type="button" className="bp-btn" data-board-print-close="1" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="bp-hint">{hint}</p>
      </div>
      <div className="bp-stage">
        <div className="bp-paper" style={zoom !== 1 ? { zoom } : undefined}>
          <AssignmentBoardPrintSheet sheet={sheet} printedAt={printedAt} />
        </div>
      </div>
      <style>{assignmentBoardPrintSheetCss + assignmentBoardPrintOverlayCss}</style>
    </>,
    mountNode
  );
}

export default BoardPrintPreview;
