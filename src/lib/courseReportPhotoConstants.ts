export const COURSE_REPORT_PHOTO_MAX = 3;
export const COURSE_REPORT_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const COURSE_REPORT_PHOTO_LONG_EDGE = 1600;
export const COURSE_REPORT_PHOTO_JPEG_QUALITY = 0.8;

export const COURSE_REPORT_PHOTO_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type CourseReportPhotoMime = (typeof COURSE_REPORT_PHOTO_MIMES)[number];

export const COURSE_REPORT_PHOTO_EXT: Record<CourseReportPhotoMime, "jpg" | "png" | "webp"> =
  {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };

export const COURSE_REPORT_PHOTO_ACCEPT =
  "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

export const COURSE_REPORT_BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";
export const COURSE_REPORT_BLOB_STORE_ID_ENV = "BLOB_STORE_ID";
export const COURSE_REPORT_BLOB_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";

export type CourseReportPhotoPublic = {
  id: number;
  mimeType: string;
  size: number;
  sortOrder: number;
  createdAt: string;
};

export function courseReportPhotoSrc(reportId: number, photoId: number): string {
  return `/api/course-reports/${reportId}/photos/${photoId}`;
}
