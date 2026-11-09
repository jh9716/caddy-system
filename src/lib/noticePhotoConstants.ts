import { COURSE_REPORT_PHOTO_ACCEPT } from "@/lib/courseReportPhotoConstants";

/** Notice photos are independent of course-report / chat limits. */
export const NOTICE_PHOTO_MAX = 10;
export const NOTICE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Long captures (tall screenshots) scale by the short edge so 1080x8000
 * stays near native resolution instead of shrinking to a 1200px long edge.
 */
export const NOTICE_PHOTO_MAX_SHORT_EDGE = 2048;
/** Non-tall photos. Higher than course-report 1200 so text stays readable. */
export const NOTICE_PHOTO_LONG_EDGE = 4096;
export const NOTICE_PHOTO_JPEG_QUALITY = 0.92;
/** Treat as a long capture when the longer side is at least this times the shorter. */
export const NOTICE_PHOTO_TALL_ASPECT = 2;
export const NOTICE_PHOTO_ACCEPT = COURSE_REPORT_PHOTO_ACCEPT;

export const NOTICE_PHOTO_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type NoticePhotoMime = (typeof NOTICE_PHOTO_MIMES)[number];

export type NoticePhotoPublic = {
  id: number;
  mimeType: string;
  size: number;
  sortOrder: number;
  createdAt: string;
};

export function noticePhotoSrc(noticeId: number, photoId: number): string {
  return `/api/notice/${noticeId}/photos/${photoId}`;
}

export function noticePhotoLimitMessage(): string {
  return `사진은 최대 ${NOTICE_PHOTO_MAX}장까지 첨부할 수 있습니다.`;
}

export function noticePhotoSizeMessage(): string {
  return `사진은 장당 ${Math.round(NOTICE_PHOTO_MAX_BYTES / (1024 * 1024))}MB 이하만 첨부할 수 있습니다.`;
}
