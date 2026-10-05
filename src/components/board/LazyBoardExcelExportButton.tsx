"use client";

import { useState } from "react";
import type { AssignmentDraft } from "@/lib/assignmentDraft";

export function LazyBoardExcelExportButton({
  draft,
  onNotice,
}: {
  draft: AssignmentDraft;
  onNotice: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function downloadWorkbook() {
    if (busy) return;
    setBusy(true);
    try {
      const {
        boardExportXlsxFilename,
        downloadBoardXlsxBytes,
        writeBoardExportXlsxBytes,
      } = await import("@/lib/assignmentBoardExportXlsx");
      const bytes = await writeBoardExportXlsxBytes(draft);
      downloadBoardXlsxBytes(bytes, boardExportXlsxFilename(draft.date));
      onNotice("Excel 배치표를 다운로드했습니다.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Excel 다운로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="bx-export-btn"
      disabled={busy}
      data-board-excel-export="1"
      onClick={() => void downloadWorkbook()}
    >
      {busy ? "준비 중…" : "엑셀"}
    </button>
  );
}
