import {
  COURSE_REPORT_PHOTO_MAX_BYTES,
  COURSE_REPORT_PHOTO_MIMES,
  type CourseReportPhotoMime,
} from "@/lib/courseReportPhotoConstants";

export class CourseReportPhotoValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "CourseReportPhotoValidationError";
  }
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return (
    brand === "heic" ||
    brand === "heix" ||
    brand === "hevc" ||
    brand === "hevx" ||
    brand === "mif1" ||
    brand === "msf1"
  );
}

function isPdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]); // %PDF
}

function looksLikeSvgOrHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html")
  );
}

export function detectCourseReportPhotoMime(bytes: Uint8Array): CourseReportPhotoMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function assertCourseReportPhotoBytes(bytes: Uint8Array): CourseReportPhotoMime {
  if (!bytes.length) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  if (bytes.byteLength > COURSE_REPORT_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError(
      "file_too_large",
      "사진은 장당 3MB 이하만 첨부할 수 있습니다."
    );
  }
  if (isHeic(bytes)) {
    throw new CourseReportPhotoValidationError(
      "unsupported_type",
      "JPG/PNG/WEBP 형식으로 첨부해 주세요."
    );
  }
  if (isPdf(bytes) || looksLikeSvgOrHtml(bytes)) {
    throw new CourseReportPhotoValidationError(
      "unsupported_type",
      "JPG/PNG/WEBP 형식으로 첨부해 주세요."
    );
  }
  const mime = detectCourseReportPhotoMime(bytes);
  if (!mime || !(COURSE_REPORT_PHOTO_MIMES as readonly string[]).includes(mime)) {
    throw new CourseReportPhotoValidationError(
      "unsupported_type",
      "JPG/PNG/WEBP 형식으로 첨부해 주세요."
    );
  }
  return mime;
}
