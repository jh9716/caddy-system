export const NOTICE_FILE_MAX = 5;
export const NOTICE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const NOTICE_FILE_MIME = "application/pdf";
export const NOTICE_FILE_EXT = "pdf";
export const NOTICE_FILE_ACCEPT = "application/pdf,.pdf";

export type NoticeFilePublic = {
  id: number;
  originalName: string;
  mimeType: string;
  size: number;
  sortOrder: number;
  createdAt: string;
};

export function noticeFileSrc(
  noticeId: number,
  fileId: number,
  opts?: { download?: boolean }
): string {
  const path = `/api/notice/${noticeId}/files/${fileId}`;
  return opts?.download ? `${path}?download=1` : path;
}

export function noticeFileLimitMessage(): string {
  return `PDF는 최대 ${NOTICE_FILE_MAX}개까지 첨부할 수 있습니다.`;
}

export function noticeFileSizeMessage(): string {
  return `PDF는 파일당 ${Math.round(NOTICE_FILE_MAX_BYTES / (1024 * 1024))}MB 이하만 첨부할 수 있습니다.`;
}

export function sanitizeNoticeFileName(raw: string | null | undefined): string {
  const base = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\0/g, "") ?? "";
  const stripped = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  const noPdfExt = stripped.replace(/\.pdf$/i, "");
  const cleaned = noPdfExt
    .replace(/[^\w.\u3131-\u318E\uAC00-\uD7A3 ()_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120)
    .trim();
  const name = cleaned || "attachment";
  return `${name}.pdf`;
}
