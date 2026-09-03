/**
 * Client-only 배치표 PNG. Draft/DB write 없음.
 */

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { toPng } from "html-to-image";
import { AssignmentBoardExportView } from "@/components/board/AssignmentBoardExportView";
import {
  boardExportPngFilename,
  type BoardExportSlice,
} from "@/lib/assignmentBoardExport";
import type { ShiftPart } from "@/lib/reservationParser";

export const BOARD_EXPORT_PIXEL_RATIO = 2;
export const BOARD_EXPORT_WIDTH_PX = 720;

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);/)?.[1] || "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function waitForExportPaint() {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export async function renderBoardExportPng(slice: BoardExportSlice): Promise<Blob> {
  const host = document.createElement("div");
  host.setAttribute("data-board-export-host", "");
  host.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:0",
    `width:${BOARD_EXPORT_WIDTH_PX}px`,
    "pointer-events:none",
    "z-index:-1",
    "background:#fbf7ee",
  ].join(";");
  document.body.appendChild(host);

  let root: Root | null = null;
  try {
    root = createRoot(host);
    root.render(createElement(AssignmentBoardExportView, { slice }));
    await waitForExportPaint();
    const node = host.querySelector("[data-board-export-root]");
    if (!(node instanceof HTMLElement)) {
      throw new Error("배치표 export DOM을 만들지 못했습니다.");
    }
    const dataUrl = await toPng(node, {
      pixelRatio: BOARD_EXPORT_PIXEL_RATIO,
      backgroundColor: "#fbf7ee",
      cacheBust: true,
      width: BOARD_EXPORT_WIDTH_PX,
    });
    return dataUrlToBlob(dataUrl);
  } finally {
    root?.unmount();
    host.remove();
  }
}

export const BOARD_EXPORT_SHARE_UNSUPPORTED =
  "이 기기에서는 공유를 지원하지 않습니다. PNG 다운로드를 이용해 주세요.";

export const BOARD_EXPORT_SHARE_ALL_UNSUPPORTED =
  "이 기기에서는 여러 장 공유를 지원하지 않습니다. 부를 따로 공유하거나 PNG 다운로드를 이용해 주세요.";

export const BOARD_EXPORT_MULTI_DOWNLOAD_BLOCKED =
  "브라우저가 여러 파일 다운로드를 차단했습니다. 개별 다운로드를 이용해 주세요.";

export const BOARD_EXPORT_MULTI_DOWNLOAD_HINT =
  "1부·2부·3부 PNG를 순서대로 저장했습니다. 파일이 1장만 보이면 브라우저가 여러 파일 다운로드를 차단했습니다. 개별 다운로드를 이용해 주세요.";

export const BOARD_EXPORT_DOWNLOAD_GAP_MS = 1100;

export function makeBoardExportPngFile(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: "image/png" });
}

export function downloadBoardPngBlob(
  blob: Blob,
  filename: string,
  opts?: { revokeMs?: number }
) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), opts?.revokeMs ?? 8000);
}

export function shouldWarnMultipleDownloadBlock(
  nav?: { userActivation?: { isActive: boolean } }
): boolean {
  const n =
    nav ??
    (typeof navigator === "undefined"
      ? undefined
      : (navigator as { userActivation?: { isActive: boolean } }));
  if (!n?.userActivation) return false;
  return n.userActivation.isActive === false;
}

export async function downloadBoardPngFilesSequentially(
  files: File[],
  opts?: {
    gapMs?: number;
    wait?: (ms: number) => Promise<void>;
    nav?: { userActivation?: { isActive: boolean } };
    download?: (blob: Blob, filename: string) => void;
  }
): Promise<{ count: number; warnedBlocked: boolean }> {
  const gap = opts?.gapMs ?? BOARD_EXPORT_DOWNLOAD_GAP_MS;
  const wait =
    opts?.wait ??
    ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  const download =
    opts?.download ??
    ((blob: Blob, filename: string) =>
      downloadBoardPngBlob(blob, filename, { revokeMs: 12000 }));
  let warnedBlocked = false;
  for (let i = 0; i < files.length; i++) {
    if (i > 0) {
      if (shouldWarnMultipleDownloadBlock(opts?.nav)) warnedBlocked = true;
      await wait(gap);
    }
    download(files[i], files[i].name);
  }
  return { count: files.length, warnedBlocked };
}

export async function exportAndDownloadShiftPng(slice: BoardExportSlice) {
  const blob = await renderBoardExportPng(slice);
  downloadBoardPngBlob(blob, boardExportPngFilename(slice.date, slice.shift));
  return blob;
}

type ShareNav = {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

export function canShareBoardPngFiles(
  files: File[],
  nav?: ShareNav
): boolean {
  const n =
    nav ??
    (typeof navigator === "undefined" ? undefined : (navigator as ShareNav));
  if (typeof n?.canShare !== "function") return false;
  try {
    return n.canShare({ files });
  } catch {
    return false;
  }
}

export async function shareBoardPngFiles(
  files: File[],
  title: string,
  nav?: ShareNav
) {
  const n =
    nav ??
    (typeof navigator === "undefined" ? undefined : (navigator as ShareNav));
  if (typeof n?.share !== "function") {
    throw new Error(BOARD_EXPORT_SHARE_UNSUPPORTED);
  }
  await n.share({ files, title });
}

export function isAndroidUserAgent(ua = ""): boolean {
  return /Android/i.test(ua);
}

export function filenameForShift(date: string, shift: ShiftPart): string {
  return boardExportPngFilename(date, shift);
}
