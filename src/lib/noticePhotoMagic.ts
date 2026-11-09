import {
  CourseReportPhotoValidationError,
  detectCourseReportPhotoMime,
} from "@/lib/courseReportPhotoMagic";
import {
  NOTICE_PHOTO_MAX_BYTES,
  NOTICE_PHOTO_MIMES,
  noticePhotoSizeMessage,
} from "@/lib/noticePhotoConstants";
import type { CourseReportPhotoMime } from "@/lib/courseReportPhotoConstants";

export function assertNoticePhotoBytes(bytes: Uint8Array): CourseReportPhotoMime {
  if (!bytes || bytes.byteLength === 0) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  if (bytes.byteLength > NOTICE_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError("file_too_large", noticePhotoSizeMessage());
  }
  const mime = detectCourseReportPhotoMime(bytes);
  if (!mime || !(NOTICE_PHOTO_MIMES as readonly string[]).includes(mime)) {
    throw new CourseReportPhotoValidationError(
      "unsupported_type",
      "JPG/PNG/WEBP 형식으로 첨부해 주세요."
    );
  }
  return mime;
}
