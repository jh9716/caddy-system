import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_LONG_EDGE,
  COURSE_REPORT_PHOTO_MAX,
  COURSE_REPORT_PHOTO_MAX_BYTES,
} from "@/lib/courseReportPhotoConstants";

export const CHAT_PHOTO_MAX = COURSE_REPORT_PHOTO_MAX;
export const CHAT_PHOTO_MAX_BYTES = COURSE_REPORT_PHOTO_MAX_BYTES;
export const CHAT_PHOTO_LONG_EDGE = COURSE_REPORT_PHOTO_LONG_EDGE;
export const CHAT_PHOTO_ACCEPT = COURSE_REPORT_PHOTO_ACCEPT;
export const CHAT_PHOTO_PUSH_BODY = "사진을 보냈습니다.";
export const CHAT_PHOTO_REPLY_PREVIEW = "사진";
export const CHAT_PHOTO_ORPHAN_MS = 60 * 60 * 1000;

export function chatPhotoSrc(roomId: string, attachmentId: string): string {
  return `/api/chat/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
