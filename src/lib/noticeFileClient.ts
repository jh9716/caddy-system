import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import {
  LOCAL_NOTICE_FILE_PUT_PATH,
  NOTICE_FILE_ACCEPT,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME_BY_EXT,
  canInlineNoticeFile,
  noticeFileExtFromMime,
  noticeFileExtFromName,
  noticeFileSizeMessage,
  noticeFileSrc,
  noticeFileTypeMessage,
  sanitizeNoticeFileName,
  type NoticeFileExt,
} from "@/lib/noticeFileConstants";
import {
  NOTICE_MEDIA_UPLOAD_CONCURRENCY,
  mapNoticeBoundedSettled,
  resolveNoticeUploadOptions,
  type NoticeUploadOptions,
  type NoticeUploadProgress,
} from "@/lib/noticeMediaUpload";

export { NOTICE_FILE_ACCEPT };

export type NoticePendingFile = {
  key: string;
  file: File;
  fileId: string;
};

export function noticeFileClientExt(file: File): NoticeFileExt | null {
  const fromName = noticeFileExtFromName(file.name);
  const fromMime = noticeFileExtFromMime(file.type);
  if (fromName && fromMime && fromName !== fromMime) return null;
  return fromName ?? fromMime;
}

export function isNoticeAllowedFile(file: File): boolean {
  return noticeFileClientExt(file) != null;
}

export function isNoticePdfFile(file: File): boolean {
  return noticeFileClientExt(file) === "pdf";
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
    if (!isNoticeAllowedFile(file)) {
      note = noticeFileTypeMessage();
      continue;
    }
    if (file.size > NOTICE_FILE_MAX_BYTES) {
      note = noticeFileSizeMessage();
      continue;
    }
    if (file.size <= 0) {
      note = "첨부파일이 필요합니다.";
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

async function putNoticeFileBytes(
  uploadUrl: string,
  file: File,
  contentType: string
): Promise<void> {
  const sameOrigin = uploadUrl.startsWith("/") || uploadUrl.includes(LOCAL_NOTICE_FILE_PUT_PATH);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    credentials: sameOrigin ? "include" : "omit",
    headers: { "content-type": contentType },
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      typeof data.message === "string" ? data.message : "첨부파일 업로드에 실패했습니다."
    );
  }
}

async function abortNoticeFileGrant(
  post: typeof fetch,
  noticeId: number,
  grant: string | undefined
): Promise<void> {
  if (!grant) return;
  await post(`/api/notice/${noticeId}/files/abort`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant }),
  }).catch(() => undefined);
}

async function uploadNoticeFileDirect(
  noticeId: number,
  item: { file: File },
  post: typeof fetch,
  sortOrder?: number
): Promise<boolean> {
  const ext = noticeFileClientExt(item.file);
  if (!ext) throw new Error(noticeFileTypeMessage());
  const contentType = NOTICE_FILE_MIME_BY_EXT[ext];
  const originalName = sanitizeNoticeFileName(item.file.name, ext);
  let grant: string | undefined;
  const preparedRes = await post(`/api/notice/${noticeId}/files/prepare`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      originalName,
      contentType,
      size: item.file.size,
    }),
  });
  if (consumeUnauthorizedMemberResponse(preparedRes)) {
    throw new Error("unauthorized");
  }
  const prepared = await preparedRes.json().catch(() => ({}));
  if (!preparedRes.ok || !prepared?.upload?.uploadUrl || !prepared.upload.grant) {
    throw new Error(
      typeof prepared.message === "string" ? prepared.message : "첨부파일 업로드에 실패했습니다."
    );
  }
  grant = String(prepared.upload.grant);
  const uploadUrl = String(prepared.upload.uploadUrl);
  const putType = String(prepared.upload.contentType || contentType);
  try {
    await putNoticeFileBytes(uploadUrl, item.file, putType);
    const completeRes = await post(`/api/notice/${noticeId}/files/complete`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant,
        originalName,
        ...(sortOrder != null ? { sortOrder } : {}),
      }),
    });
    if (consumeUnauthorizedMemberResponse(completeRes)) {
      throw new Error("unauthorized");
    }
    if (!completeRes.ok) {
      const data = await completeRes.json().catch(() => ({}));
      throw new Error(
        typeof data.message === "string" ? data.message : "첨부파일 업로드에 실패했습니다."
      );
    }
    return true;
  } catch (e) {
    await abortNoticeFileGrant(post, noticeId, grant);
    throw e;
  }
}

export async function uploadNoticePendingFiles(
  noticeId: number,
  items: { file: File }[],
  postOrOpts?: typeof fetch | NoticeUploadOptions,
  onProgressArg?: (progress: NoticeUploadProgress) => void
): Promise<{ uploaded: number; failed: number; failedIndexes: number[] }> {
  const { post, onProgress, sortOrderStart } = resolveNoticeUploadOptions(
    postOrOpts,
    onProgressArg
  );
  const failedIndexes: number[] = [];
  let uploaded = 0;
  let failed = 0;
  let unauthorized = false;
  let done = 0;
  const total = items.length;
  onProgress?.({ done, total });

  await mapNoticeBoundedSettled(items, NOTICE_MEDIA_UPLOAD_CONCURRENCY, async (item, i) => {
    try {
      if (unauthorized) {
        failed += 1;
        failedIndexes.push(i);
        done += 1;
        onProgress?.({ done, total });
        return;
      }
      await uploadNoticeFileDirect(
        noticeId,
        item,
        post,
        sortOrderStart != null ? sortOrderStart + i : undefined
      );
      uploaded += 1;
      done += 1;
      onProgress?.({ done, total });
    } catch (e) {
      if (e instanceof Error && e.message === "unauthorized") unauthorized = true;
      failed += 1;
      failedIndexes.push(i);
      done += 1;
      onProgress?.({ done, total });
    }
  });

  failedIndexes.sort((a, b) => a - b);
  return { uploaded, failed, failedIndexes };
}

export function formatNoticeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function filenameForNoticeFile(originalName: string, mimeType?: string): string {
  const ext = noticeFileExtFromMime(mimeType) ?? noticeFileExtFromName(originalName) ?? "pdf";
  return sanitizeNoticeFileName(originalName, ext);
}

async function blobFromNoticeFile(
  noticeId: number,
  fileId: number,
  originalName: string,
  download: boolean,
  mimeType?: string
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
  const filename = filenameForNoticeFile(originalName, mimeType);
  const ext = noticeFileExtFromName(filename) ?? "pdf";
  const type = NOTICE_FILE_MIME_BY_EXT[ext];
  return {
    blob: blob.type === type ? blob : new Blob([blob], { type }),
    filename,
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
  mimeType?: string;
}): Promise<void> {
  const { blob, filename } = await blobFromNoticeFile(
    input.noticeId,
    input.fileId,
    input.originalName,
    true,
    input.mimeType
  );
  triggerBlobDownload(blob, filename);
}

export async function openNoticeFile(input: {
  noticeId: number;
  fileId: number;
  originalName: string;
  mimeType?: string;
  native?: boolean;
}): Promise<void> {
  const inline = canInlineNoticeFile(input.mimeType);
  if (!inline) {
    await downloadNoticeFile(input);
    return;
  }
  const inlineUrl = noticeFileSrc(input.noticeId, input.fileId);
  if (!input.native) {
    const opened = window.open(inlineUrl, "_blank", "noopener");
    if (opened) return;
  }
  const { blob, filename } = await blobFromNoticeFile(
    input.noticeId,
    input.fileId,
    input.originalName,
    false,
    input.mimeType
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
