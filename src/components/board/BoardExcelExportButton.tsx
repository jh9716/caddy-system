"use client";

import { useState } from "react";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import {
  boardExportXlsxFilename,
  downloadBoardXlsxBytes,
  writeBoardExportXlsxBytes,
} from "@/lib/assignmentBoardExportXlsx";

export function BoardExcelExportButton({
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
      const bytes = writeBoardExportXlsxBytes(draft);
      const filename = boardExportXlsxFilename(draft.date);
      downloadBoardXlsxBytes(bytes, filename);
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
      {busy ? "엑셀…" : "엑셀"}
    </button>
  );
}
