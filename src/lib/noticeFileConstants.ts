export const NOTICE_FILE_MAX = 5;
export const NOTICE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const NOTICE_FILE_SIGNED_PUT_TTL_MS = 10 * 60 * 1000;
export const LOCAL_NOTICE_FILE_PUT_PATH = "/api/notice/local-blob-put";
export const NOTICE_FILE_MAGIC_PREFIX_BYTES = 256;
export const NOTICE_FILE_ZIP_MAX_ENTRIES = 4096;
export const NOTICE_FILE_ZIP_MAX_CD_BYTES = 2 * 1024 * 1024;

export const NOTICE_FILE_EXTS = ["pdf", "xlsx", "xls", "hwp", "hwpx"] as const;
export type NoticeFileExt = (typeof NOTICE_FILE_EXTS)[number];

export const NOTICE_FILE_PDF_MIME = "application/pdf";
export const NOTICE_FILE_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const NOTICE_FILE_XLS_MIME = "application/vnd.ms-excel";
export const NOTICE_FILE_HWP_MIME = "application/x-hwp";
export const NOTICE_FILE_HWPX_MIME = "application/hwp+zip";

export const NOTICE_FILE_MIME_BY_EXT: Record<NoticeFileExt, string> = {
  pdf: NOTICE_FILE_PDF_MIME,
  xlsx: NOTICE_FILE_XLSX_MIME,
  xls: NOTICE_FILE_XLS_MIME,
  hwp: NOTICE_FILE_HWP_MIME,
  hwpx: NOTICE_FILE_HWPX_MIME,
};

const MIME_TO_EXT: Record<string, NoticeFileExt> = {
  [NOTICE_FILE_PDF_MIME]: "pdf",
  [NOTICE_FILE_XLSX_MIME]: "xlsx",
  [NOTICE_FILE_XLS_MIME]: "xls",
  [NOTICE_FILE_HWP_MIME]: "hwp",
  "application/haansofthwp": "hwp",
  "application/vnd.hancom.hwp": "hwp",
  [NOTICE_FILE_HWPX_MIME]: "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
};

export const NOTICE_FILE_ACCEPT = [
  NOTICE_FILE_PDF_MIME,
  ".pdf",
  NOTICE_FILE_XLSX_MIME,
  ".xlsx",
  NOTICE_FILE_XLS_MIME,
  ".xls",
  NOTICE_FILE_HWP_MIME,
  ".hwp",
  NOTICE_FILE_HWPX_MIME,
  ".hwpx",
].join(",");

/** @deprecated Use NOTICE_FILE_PDF_MIME. Kept so older imports keep compiling. */
export const NOTICE_FILE_MIME = NOTICE_FILE_PDF_MIME;
/** @deprecated Use per-type ext. Kept so older imports keep compiling. */
export const NOTICE_FILE_EXT = "pdf";

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
  return `첨부파일은 최대 ${NOTICE_FILE_MAX}개까지 올릴 수 있습니다.`;
}

export function noticeFileSizeMessage(): string {
  return `첨부파일은 파일당 ${Math.round(NOTICE_FILE_MAX_BYTES / (1024 * 1024))}MB 이하만 올릴 수 있습니다.`;
}

export function noticeFileTypeMessage(): string {
  return "PDF, Excel, 한글 파일만 첨부할 수 있습니다.";
}

export function isNoticeFileExt(value: string | null | undefined): value is NoticeFileExt {
  return (NOTICE_FILE_EXTS as readonly string[]).includes(String(value || "").toLowerCase());
}

export function noticeFileExtFromMime(mime: string | null | undefined): NoticeFileExt | null {
  const key = String(mime || "")
    .trim()
    .toLowerCase()
    .split(";", 1)[0];
  return MIME_TO_EXT[key] ?? null;
}

export function noticeFileExtFromName(raw: string | null | undefined): NoticeFileExt | null {
  const base = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.trim()
    .toLowerCase() ?? "";
  if (base.endsWith(".xlsx")) return "xlsx";
  if (base.endsWith(".xls")) return "xls";
  if (base.endsWith(".hwpx")) return "hwpx";
  if (base.endsWith(".hwp")) return "hwp";
  if (base.endsWith(".pdf")) return "pdf";
  return null;
}

export function canInlineNoticeFile(mimeType: string | null | undefined): boolean {
  return String(mimeType || "").toLowerCase().split(";", 1)[0] === NOTICE_FILE_PDF_MIME;
}

function stripKnownOrAnyExt(name: string): string {
  let base = name;
  for (let i = 0; i < 4; i++) {
    const next = base.replace(/\.(pdf|xlsx|xls|hwpx|hwp)$/i, "");
    if (next === base) break;
    base = next;
  }
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

export function sanitizeNoticeFileName(
  raw: string | null | undefined,
  ext: NoticeFileExt = "pdf"
): string {
  const base = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\0/g, "") ?? "";
  const stripped = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  const noExt = stripKnownOrAnyExt(stripped);
  const cleaned = noExt
    .replace(/[^\w.\u3131-\u318E\uAC00-\uD7A3 ()_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120)
    .trim();
  const name = cleaned || "attachment";
  return `${name}.${ext}`;
}
