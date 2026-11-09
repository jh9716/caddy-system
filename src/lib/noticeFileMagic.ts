import {
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME,
  noticeFileSizeMessage,
} from "@/lib/noticeFileConstants";

export { sanitizeNoticeFileName } from "@/lib/noticeFileConstants";

export class NoticeFileValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "NoticeFileValidationError";
  }
}

export const NOTICE_FILE_MAGIC_PREFIX_BYTES = 256;

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function isPdfMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]); // %PDF
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

function looksLikeHostilePrefix(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<script")
  );
}

function isImageMagic(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return true;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return true;
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
    return true;
  }
  return false;
}

function isZipOrOffice(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
}

export function assertNoticePdfPrefix(input: {
  prefix: Uint8Array;
  totalSize: number;
}): typeof NOTICE_FILE_MIME {
  const totalSize = input.totalSize;
  if (!Number.isFinite(totalSize) || totalSize <= 0 || input.prefix.byteLength === 0) {
    throw new NoticeFileValidationError("empty_file", "PDF 파일이 필요합니다.");
  }
  if (totalSize > NOTICE_FILE_MAX_BYTES) {
    throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
  }
  const prefix =
    input.prefix.byteLength > NOTICE_FILE_MAGIC_PREFIX_BYTES
      ? input.prefix.subarray(0, NOTICE_FILE_MAGIC_PREFIX_BYTES)
      : input.prefix;
  if (isHeic(prefix) || isImageMagic(prefix) || isZipOrOffice(prefix) || looksLikeHostilePrefix(prefix)) {
    throw new NoticeFileValidationError("unsupported_type", "PDF 파일만 첨부할 수 있습니다.");
  }
  if (!isPdfMagic(prefix)) {
    throw new NoticeFileValidationError("unsupported_type", "PDF 파일만 첨부할 수 있습니다.");
  }
  return NOTICE_FILE_MIME;
}

export function assertNoticePdfBytes(bytes: Uint8Array): typeof NOTICE_FILE_MIME {
  return assertNoticePdfPrefix({
    prefix: bytes,
    totalSize: bytes.byteLength,
  });
}
