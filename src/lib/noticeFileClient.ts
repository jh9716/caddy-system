import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import {
  NOTICE_FILE_ACCEPT,
  NOTICE_FILE_MAX_BYTES,
  noticeFileSizeMessage,
  noticeFileSrc,
  sanitizeNoticeFileName,
} from "@/lib/noticeFileConstants";

export { NOTICE_FILE_ACCEPT };

export type NoticePendingFile = {
  key: string;
  file: File;
  fileId: string;
};

export function isNoticePdfFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

export function noticeFilePickId(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}|${file.type}`;
}

export function pickNoticeFiles(
  files: File[],
  room: number,
  already: { fileIds?: Iterable<string> } = {}
): { items: NoticePendingFile[]; note: string } {
  const seen = new Set(already.fileIds ?? []);
  const items: NoticePendingFile[] = [];
  let note = "";
  for (const file of files) {
    if (items.length >= Math.max(0, room)) break;
    const fileId = noticeFilePickId(file);
    if (seen.has(fileId)) {
      note = "이미 추가한 파일입니다.";
      continue;
    }
    if (!isNoticePdfFile(file)) {
      note = "PDF 파일만 첨부할 수 있습니다.";
      continue;
    }
    if (file.size > NOTICE_FILE_MAX_BYTES) {
      note = noticeFileSizeMessage();
      continue;
    }
    if (file.size <= 0) {
      note = "PDF 파일이 필요합니다.";
      continue;
    }
    seen.add(fileId);
    items.push({
      key: `${Date.now()}-${items.length}-${fileId}`,
      file,
      fileId,
    });
  }
  return { items, note };
}

export async function uploadNoticePendingFiles(
  noticeId: number,
  items: { file: File }[],
  post: typeof fetch = fetch
): Promise<{ uploaded: number; failed: number; failedIndexes: number[] }> {
  let uploaded = 0;
  let failed = 0;
  const failedIndexes: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const file = items[i].file;
    const fd = new FormData();
    fd.append("file", file, sanitizeNoticeFileName(file.name));
    const res = await post(`/api/notice/${noticeId}/files`, {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (consumeUnauthorizedMemberResponse(res)) {
      for (let j = i; j < items.length; j++) failedIndexes.push(j);
      return { uploaded, failed: failed + (items.length - i), failedIndexes };
    }
    if (res.ok) uploaded += 1;
    else {
      failed += 1;
      failedIndexes.push(i);
    }
  }
  return { uploaded, failed, failedIndexes };
}

export function formatNoticeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function blobFromNoticeFile(
  noticeId: number,
  fileId: number,
  originalName: string,
  download: boolean
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(noticeFileSrc(noticeId, fileId, { download }), {
    credentials: "include",
  });
  if (consumeUnauthorizedMemberResponse(res)) {
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.message === "string" ? data.message : "파일을 열 수 없습니다.");
  }
  const blob = await res.blob();
  return {
    blob: blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }),
    filename: sanitizeNoticeFileName(originalName),
  };
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadNoticeFile(input: {
  noticeId: number;
  fileId: number;
  originalName: string;
}): Promise<void> {
  const { blob, filename } = await blobFromNoticeFile(
    input.noticeId,
    input.fileId,
    input.originalName,
    true
  );
  triggerBlobDownload(blob, filename);
}

export async function openNoticeFile(input: {
  noticeId: number;
  fileId: number;
  originalName: string;
  native?: boolean;
}): Promise<void> {
  const inlineUrl = noticeFileSrc(input.noticeId, input.fileId);
  if (!input.native) {
    const opened = window.open(inlineUrl, "_blank", "noopener");
    if (opened) return;
  }
  const { blob, filename } = await blobFromNoticeFile(
    input.noticeId,
    input.fileId,
    input.originalName,
    false
  );
  const objectUrl = URL.createObjectURL(blob);
  const opened = window.open(objectUrl, "_blank", "noopener");
  if (opened) {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
    return;
  }
  triggerBlobDownload(blob, filename);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
