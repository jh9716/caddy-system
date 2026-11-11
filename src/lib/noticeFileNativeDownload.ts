import {
  noticeFileExtFromMime,
  noticeFileExtFromName,
  sanitizeNoticeFileName,
} from "@/lib/noticeFileConstants";

/** Capacitor Android plugin. JS never sends a full URL or session token. */
export const NOTICE_FILE_NATIVE_PLUGIN_NAME = "NoticeFileDownload";

export const NOTICE_FILE_NATIVE_ALLOWED_HOSTS = [
  "www.verthill.kr",
  "verthill.kr",
] as const;

export const NOTICE_FILE_NATIVE_DOWNLOAD_TIMEOUT_MS = 180_000;

const NOTICE_FILE_PATHNAME_RE =
  /^\/api\/notice\/([1-9][0-9]{0,9})\/files\/([1-9][0-9]{0,9})$/;

export type NoticeFileDownloadMode = "web" | "native" | "missing_plugin";

export type NativeNoticeDownloadResult = {
  saved: true;
  displayName: string;
};

export function noticeFileDownloadMode(input: {
  isNativePlatform: boolean;
  pluginAvailable: boolean;
}): NoticeFileDownloadMode {
  if (input.isNativePlatform !== true) return "web";
  if (input.pluginAvailable !== true) return "missing_plugin";
  return "native";
}

export function isNoticeFileNativeDownloadPath(path: string): boolean {
  const raw = String(path ?? "");
  if (!raw.startsWith("/api/notice/")) return false;
  if (raw.includes("#") || raw.includes("\\") || raw.includes("..")) return false;
  const q = raw.indexOf("?");
  const pathname = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q + 1) : "";
  if (query && query !== "download=1") return false;
  return NOTICE_FILE_PATHNAME_RE.test(pathname);
}

export function noticeFileNativeDownloadPath(
  noticeId: number,
  fileId: number
): string | null {
  if (!Number.isInteger(noticeId) || noticeId <= 0) return null;
  if (!Number.isInteger(fileId) || fileId <= 0) return null;
  const path = `/api/notice/${noticeId}/files/${fileId}?download=1`;
  return isNoticeFileNativeDownloadPath(path) ? path : null;
}

export function nativeNoticeDownloadFilename(
  originalName: string,
  mimeType?: string
): string | null {
  const ext =
    noticeFileExtFromMime(mimeType) ?? noticeFileExtFromName(originalName);
  if (!ext) return null;
  const filename = sanitizeNoticeFileName(originalName, ext);
  return noticeFileExtFromName(filename) === ext ? filename : null;
}

export function confirmNativeNoticeDownloadResult(
  result: unknown
): NativeNoticeDownloadResult {
  if (!result || typeof result !== "object") {
    throw new Error("download_failed");
  }
  const saved = "saved" in result && (result as { saved?: unknown }).saved === true;
  const displayName = String(
    "displayName" in result ? (result as { displayName?: unknown }).displayName ?? "" : ""
  ).trim();
  if (!saved || !displayName || !noticeFileExtFromName(displayName)) {
    throw new Error("download_failed");
  }
  return { saved: true, displayName };
}

export function nativeNoticeDownloadErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "download_failed";
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : "";
  const raw = (code || message).trim();
  if (
    raw === "unavailable" ||
    raw === "UNIMPLEMENTED" ||
    raw === "UNAVAILABLE" ||
    raw.includes("not implemented")
  ) {
    return "unavailable";
  }
  if (
    raw === "unauthorized" ||
    raw === "invalid_url" ||
    raw === "invalid_filename" ||
    raw === "not_found" ||
    raw === "too_large" ||
    raw === "permission_denied" ||
    raw === "download_failed"
  ) {
    return raw;
  }
  return "download_failed";
}

export function nativeNoticeDownloadErrorStage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const data = "data" in error ? (error as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object") return "";
  const stage =
    "stage" in data ? String((data as { stage?: unknown }).stage ?? "") : "";
  return /^[a-z_]{1,32}$/.test(stage) ? stage : "";
}

export function nativeNoticeDownloadUserMessage(code: string, stage = ""): string {
  let message = "";
  switch (nativeNoticeDownloadErrorCode({ code })) {
    case "unavailable":
      message = "앱을 업데이트하면 첨부파일을 저장할 수 있습니다.";
      break;
    case "unauthorized":
      message = "로그인이 필요합니다.";
      break;
    case "permission_denied":
      message = "파일 저장 권한이 필요합니다.";
      break;
    case "too_large":
      message = "20MB를 초과하는 파일은 저장할 수 없습니다.";
      break;
    case "not_found":
      message = "파일을 찾을 수 없습니다.";
      break;
    case "invalid_url":
      message = "이 페이지에서는 파일을 저장할 수 없습니다.";
      break;
    case "invalid_filename":
      message = "저장할 수 없는 파일입니다.";
      break;
    default:
      message = "파일을 저장하지 못했습니다.";
      break;
  }
  const safeStage = /^[a-z_]{1,32}$/.test(stage) ? stage : "";
  return safeStage ? `${message} (${safeStage})` : message;
}
