import { createHmac, timingSafeEqual } from "node:crypto";
import {
  COURSE_REPORT_PHOTO_MIMES,
  type CourseReportPhotoMime,
} from "@/lib/courseReportPhotoConstants";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CHAT_PHOTO_MAX_BYTES } from "@/lib/chatPhotoConstants";

export const LOCAL_CHAT_PHOTO_PUT_PATH = "/api/chat/local-blob-put";

export type LocalChatPhotoPutGrant = {
  storageKey: string;
  contentType: CourseReportPhotoMime;
  maxBytes: number;
  exp: number;
};

function canonicalLocalPutGrant(grant: LocalChatPhotoPutGrant): string {
  return [
    grant.storageKey,
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

export function parseRequestedChatPhotoMime(raw: unknown): CourseReportPhotoMime {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .split(";", 1)[0];
  const mime = value === "image/jpg" ? "image/jpeg" : value;
  if (!(COURSE_REPORT_PHOTO_MIMES as readonly string[]).includes(mime)) {
    throw new CourseReportPhotoValidationError(
      "unsupported_type",
      "JPG/PNG/WEBP 형식으로 첨부해 주세요."
    );
  }
  return mime as CourseReportPhotoMime;
}

export function parseRequestedChatPhotoSize(raw: unknown): number {
  const size = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  if (size > CHAT_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError(
      "file_too_large",
      "사진은 장당 3MB 이하만 첨부할 수 있습니다."
    );
  }
  return size;
}

export function signLocalChatPhotoPutUrl(
  secret: string,
  grant: LocalChatPhotoPutGrant
): string {
  const key = String(secret || "").trim();
  if (!key) {
    throw new CourseReportPhotoValidationError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const sig = hmacSha256B64Url(key, canonicalLocalPutGrant(grant));
  const token = Buffer.from(JSON.stringify({ ...grant, sig }), "utf8").toString("base64url");
  return `${LOCAL_CHAT_PHOTO_PUT_PATH}?token=${token}`;
}

export function verifyLocalChatPhotoPutToken(
  secret: string,
  token: string
): LocalChatPhotoPutGrant {
  const key = String(secret || "").trim();
  if (!key) {
    throw new CourseReportPhotoValidationError("unauthorized", "unauthorized", 401);
  }
  let parsed: {
    storageKey?: unknown;
    contentType?: unknown;
    maxBytes?: unknown;
    exp?: unknown;
    sig?: unknown;
  };
  try {
    parsed = JSON.parse(Buffer.from(String(token || ""), "base64url").toString("utf8"));
  } catch {
    throw new CourseReportPhotoValidationError("unauthorized", "unauthorized", 401);
  }
  const grant: LocalChatPhotoPutGrant = {
    storageKey: String(parsed.storageKey || ""),
    contentType: parseRequestedChatPhotoMime(parsed.contentType),
    maxBytes: parseRequestedChatPhotoSize(parsed.maxBytes),
    exp: Number(parsed.exp),
  };
  if (!grant.storageKey.startsWith("chat/") || !Number.isFinite(grant.exp)) {
    throw new CourseReportPhotoValidationError("unauthorized", "unauthorized", 401);
  }
  const expected = hmacSha256B64Url(key, canonicalLocalPutGrant(grant));
  if (!safeEqual(expected, String(parsed.sig || ""))) {
    throw new CourseReportPhotoValidationError("unauthorized", "unauthorized", 401);
  }
  if (grant.exp * 1000 <= Date.now()) {
    throw new CourseReportPhotoValidationError("expired", "업로드 유효시간이 지났습니다.", 410);
  }
  return grant;
}
