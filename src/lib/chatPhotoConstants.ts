import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_LONG_EDGE,
  COURSE_REPORT_PHOTO_MAX,
  COURSE_REPORT_PHOTO_MAX_BYTES,
} from "@/lib/courseReportPhotoConstants";

export const CHAT_PHOTO_MAX = COURSE_REPORT_PHOTO_MAX;
export const CHAT_PHOTO_MAX_BYTES = COURSE_REPORT_PHOTO_MAX_BYTES;
export const CHAT_PHOTO_LONG_EDGE = COURSE_REPORT_PHOTO_LONG_EDGE;
/** Skip re-encode when the source is already chat-sized. */
export const CHAT_PHOTO_PASSTHROUGH_MAX_BYTES = 700 * 1024;
export const CHAT_PHOTO_ADAPTIVE_LONG_EDGE = 1600;
export const CHAT_PHOTO_JPEG_WEBP_TARGET_MAX_BYTES = 800 * 1024;
export const CHAT_PHOTO_PNG_TARGET_MAX_BYTES = 1024 * 1024;
export const CHAT_PHOTO_ENCODE_MAX_ATTEMPTS = 2;
export const CHAT_PHOTO_ACCEPT = COURSE_REPORT_PHOTO_ACCEPT;
export const CHAT_PHOTO_PUSH_BODY = "사진을 보냈습니다.";
export const CHAT_PHOTO_REPLY_PREVIEW = "사진";
export const CHAT_PHOTO_ORPHAN_MS = 60 * 60 * 1000;
/** PENDING signed-PUT intents that never finalize. */
export const CHAT_PHOTO_PENDING_ORPHAN_MS = 15 * 60 * 1000;
export const CHAT_PHOTO_SIGNED_PUT_TTL_MS = 5 * 60 * 1000;
export const CHAT_PHOTO_CLEANUP_BATCH = 50;

export function chatPhotoSrc(roomId: string, attachmentId: string): string {
  return `/api/chat/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
