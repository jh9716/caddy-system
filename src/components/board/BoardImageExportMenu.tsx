"use client";

import { useState } from "react";
import {
  BOARD_EXPORT_SHIFTS,
  buildBoardExportSlice,
} from "@/lib/assignmentBoardExport";
import {
  BOARD_EXPORT_MULTI_DOWNLOAD_BLOCKED,
  BOARD_EXPORT_MULTI_DOWNLOAD_HINT,
  BOARD_EXPORT_SHARE_ALL_UNSUPPORTED,
  BOARD_EXPORT_SHARE_UNSUPPORTED,
  canShareBoardPngFiles,
  downloadBoardPngFilesSequentially,
  exportAndDownloadShiftPng,
  makeBoardExportPngFile,
  renderBoardExportPng,
  shareBoardPngFiles,
} from "@/lib/assignmentBoardExportPng";
import { boardExportPngFilename } from "@/lib/assignmentBoardExport";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { ShiftPart } from "@/lib/reservationParser";

type ExportMode = "download" | "share";

export function BoardImageExportMenu({
  draft,
  onNotice,
}: {
  draft: AssignmentDraft;
  onNotice: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ExportMode | null>(null);
  const [busy, setBusy] = useState(false);

  function closeMenu() {
    setOpen(false);
    setMode(null);
  }

  async function buildShiftFile(shift: ShiftPart): Promise<File> {
    const slice = buildBoardExportSlice(draft, shift);
    const blob = await renderBoardExportPng(slice);
    return makeBoardExportPngFile(
      blob,
      boardExportPngFilename(slice.date, slice.shift)
    );
  }

  async function downloadShift(shift: ShiftPart) {
    if (busy) return;
    setBusy(true);
    closeMenu();
    try {
      await exportAndDownloadShiftPng(buildBoardExportSlice(draft, shift));
      onNotice(`${shift} PNG를 다운로드했습니다.`);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "PNG 다운로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadAll() {
    if (busy) return;
    setBusy(true);
    closeMenu();
    try {
      const files: File[] = [];
      for (const shift of BOARD_EXPORT_SHIFTS) {
        files.push(await buildShiftFile(shift));
      }
      const result = await downloadBoardPngFilesSequentially(files);
      onNotice(
        result.warnedBlocked
          ? BOARD_EXPORT_MULTI_DOWNLOAD_BLOCKED
          : BOARD_EXPORT_MULTI_DOWNLOAD_HINT
      );
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "전체 PNG 다운로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function shareShift(shift: ShiftPart) {
    if (busy) return;
    setBusy(true);
    closeMenu();
    try {
      const file = await buildShiftFile(shift);
      if (!canShareBoardPngFiles([file])) {
        onNotice(BOARD_EXPORT_SHARE_UNSUPPORTED);
        return;
      }
      await shareBoardPngFiles([file], `VERTHILL 배치표 ${draft.date} ${shift}`);
      onNotice(`${shift} 배치표 이미지를 공유합니다.`);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      onNotice(e instanceof Error ? e.message : BOARD_EXPORT_SHARE_UNSUPPORTED);
    } finally {
      setBusy(false);
    }
  }

  async function shareAll() {
    if (busy) return;
    setBusy(true);
    closeMenu();
    try {
      const files: File[] = [];
      for (const shift of BOARD_EXPORT_SHIFTS) {
        files.push(await buildShiftFile(shift));
      }
      if (!canShareBoardPngFiles(files)) {
        onNotice(
          files.some((file) => canShareBoardPngFiles([file]))
            ? BOARD_EXPORT_SHARE_ALL_UNSUPPORTED
            : BOARD_EXPORT_SHARE_UNSUPPORTED
        );
        return;
      }
      await shareBoardPngFiles(files, `VERTHILL 배치표 ${draft.date}`);
      onNotice("1부·2부·3부 이미지를 공유합니다.");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      onNotice(e instanceof Error ? e.message : BOARD_EXPORT_SHARE_UNSUPPORTED);
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
        onClick={() => {
          setOpen((v) => !v);
          setMode(null);
        }}
      >
        {busy ? "이미지…" : "이미지"}
      </button>
      {open ? (
        <div className="bx-export-pop" role="menu">
          {mode == null ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => setMode("download")}
              >
                PNG 다운로드
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setMode("share")}
              >
                공유하기
              </button>
            </>
          ) : mode === "download" ? (
            <>
              {BOARD_EXPORT_SHIFTS.map((shift) => (
                <button
                  key={shift}
                  type="button"
                  role="menuitem"
                  onClick={() => void downloadShift(shift)}
                >
                  {shift} PNG 다운로드
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => void downloadAll()}>
                전체 PNG 다운로드
              </button>
            </>
          ) : (
            <>
              {BOARD_EXPORT_SHIFTS.map((shift) => (
                <button
                  key={shift}
                  type="button"
                  role="menuitem"
                  onClick={() => void shareShift(shift)}
                >
                  {shift} 공유하기
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => void shareAll()}>
                전체 공유하기
              </button>
            </>
          )}
        </div>
      ) : null}
      <style>{`
        .bx-export-menu { position: relative; }
        .bx-export-btn {
          min-height: 32px;
          padding: 0 10px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #fff;
          color: #0f172a;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .bx-export-btn:disabled { opacity: 0.55; cursor: wait; }
        .bx-export-pop {
          position: absolute;
          right: 0;
          top: calc(100% + 4px);
          z-index: 8;
          min-width: 188px;
          display: grid;
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          box-shadow: 0 10px 24px rgb(15 23 42 / 12%);
          overflow: hidden;
        }
        .bx-export-pop button {
          border: 0;
          background: #fff;
          text-align: left;
          padding: 10px 12px;
          font-size: 0.8rem;
          font-weight: 700;
          color: #0f172a;
          cursor: pointer;
        }
        .bx-export-pop button + button { border-top: 1px solid #f1f5f9; }
        .bx-export-pop button:hover { background: #f8fafc; }
      `}</style>
    </div>
  );
}
