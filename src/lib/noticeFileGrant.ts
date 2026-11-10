import { createHmac, timingSafeEqual } from "node:crypto";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  LOCAL_NOTICE_FILE_PUT_PATH,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME_BY_EXT,
  NOTICE_FILE_SIGNED_PUT_TTL_MS,
  isNoticeFileExt,
  noticeFileSizeMessage,
  noticeFileTypeMessage,
  type NoticeFileExt,
} from "@/lib/noticeFileConstants";
import { NoticeFileValidationError } from "@/lib/noticeFileMagic";
import { getSessionSecret } from "@/lib/sessionCookies";

export { LOCAL_NOTICE_FILE_PUT_PATH };
export const NOTICE_FILE_STORAGE_KEY_RE =
  /^notices\/(\d+)\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|xlsx|xls|hwp|hwpx)$/;

export type NoticeFileUploadGrant = {
  noticeId: number;
  actor: string;
  storageKey: string;
  ext: NoticeFileExt;
  contentType: string;
  maxBytes: number;
  exp: number;
};

export function noticeFileActorKey(auth: ResolvedAuthUser): string {
  return `${auth.userId ?? "env"}:${auth.username}`;
}

export function parseNoticeFileStorageKey(
  raw: string | null | undefined
): { noticeId: number; id: string; ext: NoticeFileExt } | null {
  const match = NOTICE_FILE_STORAGE_KEY_RE.exec(String(raw || "").trim());
  if (!match) return null;
  const noticeId = Number(match[1]);
  const id = match[2] ?? "";
  const ext = match[3];
  if (!Number.isInteger(noticeId) || noticeId <= 0 || !isNoticeFileExt(ext)) return null;
  return { noticeId, id, ext };
}

function canonicalGrant(grant: NoticeFileUploadGrant): string {
  return [
    String(grant.noticeId),
    grant.actor,
    grant.storageKey,
    grant.ext,
    grant.contentType,
    String(grant.maxBytes),
    String(grant.exp),
  ].join("\n");
}

function hmacSha256B64Url(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireNoticeFileSecret(): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new NoticeFileValidationError(
      "storage_not_configured",
      "첨부파일 저장소가 설정되지 않았습니다.",
      503
    );
  }
  return secret;
}

export function parseNoticeFileUploadSize(raw: unknown): number {
  const size = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
    throw new NoticeFileValidationError("empty_file", "첨부파일이 필요합니다.");
  }
  if (size > NOTICE_FILE_MAX_BYTES) {
    throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
  }
  return size;
}

export function signNoticeFileUploadGrant(
  grant: Omit<NoticeFileUploadGrant, "exp"> & { exp?: number }
): { token: string; expiresAt: number } {
  const secret = requireNoticeFileSecret();
  const expiresAt = grant.exp ?? Date.now() + NOTICE_FILE_SIGNED_PUT_TTL_MS;
  const full: NoticeFileUploadGrant = { ...grant, exp: expiresAt };
  const sig = hmacSha256B64Url(secret, canonicalGrant(full));
  const token = Buffer.from(JSON.stringify({ ...full, sig }), "utf8").toString("base64url");
  return { token, expiresAt };
}

export function parseSignedNoticeFileGrant(token: string): NoticeFileUploadGrant {
  const secret = requireNoticeFileSecret();
  let parsed: {
    noticeId?: unknown;
    actor?: unknown;
    storageKey?: unknown;
    ext?: unknown;
    contentType?: unknown;
    maxBytes?: unknown;
    exp?: unknown;
    sig?: unknown;
  };
  try {
    parsed = JSON.parse(Buffer.from(String(token || ""), "base64url").toString("utf8"));
  } catch {
    throw new NoticeFileValidationError("unauthorized", "업로드 권한이 없습니다.", 401);
  }
  const ext = String(parsed.ext || "");
  if (!isNoticeFileExt(ext)) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  const grant: NoticeFileUploadGrant = {
    noticeId: Number(parsed.noticeId),
    actor: String(parsed.actor || ""),
    storageKey: String(parsed.storageKey || ""),
    ext,
    contentType: String(parsed.contentType || ""),
    maxBytes: parseNoticeFileUploadSize(parsed.maxBytes),
    exp: Number(parsed.exp),
  };
  const key = parseNoticeFileStorageKey(grant.storageKey);
  if (
    !Number.isInteger(grant.noticeId) ||
    grant.noticeId <= 0 ||
    !key ||
    key.noticeId !== grant.noticeId ||
    key.ext !== grant.ext ||
    grant.contentType !== NOTICE_FILE_MIME_BY_EXT[grant.ext] ||
    !Number.isFinite(grant.exp)
  ) {
    throw new NoticeFileValidationError("unauthorized", "업로드 권한이 없습니다.", 401);
  }
  const expectedSig = hmacSha256B64Url(secret, canonicalGrant(grant));
  if (!safeEqual(expectedSig, String(parsed.sig || ""))) {
    throw new NoticeFileValidationError("unauthorized", "업로드 권한이 없습니다.", 401);
  }
  return grant;
}

export function assertNoticeFileGrantFresh(grant: NoticeFileUploadGrant): void {
  if (grant.exp <= Date.now()) {
    throw new NoticeFileValidationError("expired", "업로드 유효시간이 지났습니다.", 410);
  }
}

export function verifyNoticeFileUploadGrant(
  token: string,
  expected: { noticeId: number; actor: string }
): NoticeFileUploadGrant {
  const grant = parseSignedNoticeFileGrant(token);
  if (grant.noticeId !== expected.noticeId || grant.actor !== expected.actor) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
  }
  assertNoticeFileGrantFresh(grant);
  return grant;
}

export function signLocalNoticeFilePutUrl(grant: NoticeFileUploadGrant): string {
  const { token } = signNoticeFileUploadGrant(grant);
  return `${LOCAL_NOTICE_FILE_PUT_PATH}?token=${token}`;
}
