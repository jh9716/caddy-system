"use client";

import { useState } from "react";
import {
  BOARD_EXPORT_SHIFTS,
  buildBoardExportSlice,
} from "@/lib/assignmentBoardExport";
import {
  canShareBoardPngFiles,
  downloadBoardPngBlob,
  exportAndDownloadShiftPng,
  isAndroidUserAgent,
  renderBoardExportPng,
  shareBoardPngFiles,
} from "@/lib/assignmentBoardExportPng";
import { boardExportPngFilename } from "@/lib/assignmentBoardExport";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { ShiftPart } from "@/lib/reservationParser";

export function BoardImageExportMenu({
  draft,
  onNotice,
}: {
  draft: AssignmentDraft;
  onNotice: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const android =
    typeof navigator !== "undefined" && isAndroidUserAgent(navigator.userAgent);

  async function saveShift(shift: ShiftPart) {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await exportAndDownloadShiftPng(buildBoardExportSlice(draft, shift));
      onNotice(`${shift} 배치표 이미지를 저장했습니다.`);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "이미지 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAll() {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const files: File[] = [];
      for (const shift of BOARD_EXPORT_SHIFTS) {
        const slice = buildBoardExportSlice(draft, shift);
        const blob = await renderBoardExportPng(slice);
        files.push(
          new File([blob], boardExportPngFilename(slice.date, shift), {
            type: "image/png",
          })
        );
      }
      if (canShareBoardPngFiles(files)) {
        await shareBoardPngFiles(files, `VERTHILL 배치표 ${draft.date}`);
        onNotice("1부·2부·3부 이미지를 공유합니다.");
        return;
      }
      if (android) {
        onNotice("Android에서는 각 부 이미지를 따로 저장해 주세요.");
        return;
      }
      for (const file of files) {
        downloadBoardPngBlob(file, file.name);
        await new Promise((r) => window.setTimeout(r, 350));
      }
      onNotice("1부·2부·3부 이미지를 저장했습니다.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "전체 이미지 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bx-export-menu">
      <button
        type="button"
        className="bx-export-btn"
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? "이미지…" : "이미지 저장"}
      </button>
      {open ? (
        <div className="bx-export-pop" role="menu">
          {BOARD_EXPORT_SHIFTS.map((shift) => (
            <button
              key={shift}
              type="button"
              role="menuitem"
              onClick={() => void saveShift(shift)}
            >
              {shift} 이미지 저장
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => void saveAll()}>
            전체 저장
          </button>
        </div>
      ) : null}
    </div>
  );
}
