"use client";

import { useCallback, useState, type ComponentType } from "react";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { ShiftPart } from "@/lib/reservationParser";

type PreviewProps = {
  draft: AssignmentDraft;
  initialShift?: ShiftPart | null;
  onClose: () => void;
};

/** 배치표 툴바의 "인쇄" 버튼. 미리보기 코드는 클릭 시에만 로드한다 (읽기 전용). */
export function LazyBoardPrintButton({
  draft,
  shift,
  onNotice,
}: {
  draft: AssignmentDraft;
  shift?: ShiftPart | null;
  onNotice: (msg: string) => void;
}) {
  const [Preview, setPreview] = useState<ComponentType<PreviewProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  async function openPreview() {
    if (preparing) return;
    if (Preview) {
      setOpen(true);
      return;
    }
    setPreparing(true);
    try {
      const mod = await import("@/components/board/BoardPrintPreview");
      setPreview(() => mod.BoardPrintPreview);
      setOpen(true);
    } catch {
      onNotice("인쇄 화면을 불러오지 못했습니다.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="bx-export-btn"
        disabled={preparing}
        data-board-print="1"
        onClick={() => void openPreview()}
      >
        {preparing ? "준비 중…" : "인쇄"}
      </button>
      {open && Preview ? (
        <Preview draft={draft} initialShift={shift ?? null} onClose={close} />
      ) : null}
    </>
  );
}
