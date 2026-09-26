import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_MAX,
  COURSE_REPORT_PHOTO_MAX_BYTES,
  type CourseReportPhotoPublic,
} from "@/lib/courseReportPhotoConstants";

/** Same limits as course-report photos. */
export const NOTICE_PHOTO_MAX = COURSE_REPORT_PHOTO_MAX;
export const NOTICE_PHOTO_MAX_BYTES = COURSE_REPORT_PHOTO_MAX_BYTES;
export const NOTICE_PHOTO_ACCEPT = COURSE_REPORT_PHOTO_ACCEPT;

export type NoticePhotoPublic = CourseReportPhotoPublic;

export function noticePhotoSrc(noticeId: number, photoId: number): string {
  return `/api/notice/${noticeId}/photos/${photoId}`;
}
