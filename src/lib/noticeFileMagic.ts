import {
  NOTICE_FILE_MAGIC_PREFIX_BYTES,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME_BY_EXT,
  NOTICE_FILE_HWPX_MIME,
  NOTICE_FILE_PDF_MIME,
  NOTICE_FILE_ZIP_MAX_CD_BYTES,
  NOTICE_FILE_ZIP_MAX_ENTRIES,
  noticeFileSizeMessage,
  noticeFileTypeMessage,
  type NoticeFileExt,
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

export type NoticeFileKind = {
  ext: NoticeFileExt;
  mime: string;
};

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function isPdfMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]); // %PDF
}

function isOleMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function isZipMagic(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
  );
}

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!).toLowerCase();
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

function findAscii(bytes: Uint8Array, ascii: string): boolean {
  const n = ascii.length;
  if (n === 0 || bytes.length < n) return false;
  const first = ascii.charCodeAt(0);
  outer: for (let i = 0; i <= bytes.length - n; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < n; j++) {
      if (bytes[i + j] !== ascii.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

function findAsciiAsUtf16le(bytes: Uint8Array, ascii: string): boolean {
  const n = ascii.length;
  if (n === 0 || bytes.length < n * 2) return false;
  const first = ascii.charCodeAt(0);
  outer: for (let i = 0; i + n * 2 <= bytes.length; i++) {
    if (bytes[i] !== first || bytes[i + 1] !== 0) continue;
    for (let j = 1; j < n; j++) {
      if (bytes[i + j * 2] !== ascii.charCodeAt(j) || bytes[i + j * 2 + 1] !== 0) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function decodeZipName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0/g, "");
}

export function zipCentralDirectoryNames(bytes: Uint8Array): string[] | null {
  if (!isZipMagic(bytes)) return null;
  const maxScan = Math.min(bytes.length, 0xffff + 22);
  let eocd = -1;
  const start = bytes.length - 22;
  const end = bytes.length - maxScan;
  for (let i = start; i >= end && i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const disk = readU16LE(bytes, eocd + 4);
  const cdDisk = readU16LE(bytes, eocd + 6);
  const totalEntries = readU16LE(bytes, eocd + 10);
  const cdSize = readU32LE(bytes, eocd + 12);
  const cdOffset = readU32LE(bytes, eocd + 16);
  if (
    disk == null ||
    cdDisk == null ||
    totalEntries == null ||
    cdSize == null ||
    cdOffset == null
  ) {
    return null;
  }
  if (disk !== 0 || cdDisk !== 0) return null;
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
  if (totalEntries > NOTICE_FILE_ZIP_MAX_ENTRIES) return null;
  if (cdSize > NOTICE_FILE_ZIP_MAX_CD_BYTES) return null;
  if (cdOffset + cdSize > bytes.length) return null;
  const names: string[] = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdEnd) return null;
    if (
      bytes[p] !== 0x50 ||
      bytes[p + 1] !== 0x4b ||
      bytes[p + 2] !== 0x01 ||
      bytes[p + 3] !== 0x02
    ) {
      return null;
    }
    const nameLen = readU16LE(bytes, p + 28);
    const extraLen = readU16LE(bytes, p + 30);
    const commentLen = readU16LE(bytes, p + 32);
    if (nameLen == null || extraLen == null || commentLen == null) return null;
    const nameStart = p + 46;
    if (nameStart + nameLen > cdEnd) return null;
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + nameLen));
    if (!name || name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      return null;
    }
    names.push(name.replace(/\\/g, "/"));
    p = nameStart + nameLen + extraLen + commentLen;
    if (p > cdEnd) return null;
  }
  return names;
}

export function zipStoredEntryBytes(
  bytes: Uint8Array,
  wanted: string,
  maxLen: number
): Uint8Array | null {
  let p = 0;
  for (let walked = 0; walked < 64 && p + 30 <= bytes.length; walked++) {
    if (
      bytes[p] !== 0x50 ||
      bytes[p + 1] !== 0x4b ||
      bytes[p + 2] !== 0x03 ||
      bytes[p + 3] !== 0x04
    ) {
      return null;
    }
    const method = readU16LE(bytes, p + 8);
    const flags = readU16LE(bytes, p + 6);
    const compSize = readU32LE(bytes, p + 18);
    const nameLen = readU16LE(bytes, p + 26);
    const extraLen = readU16LE(bytes, p + 28);
    if (
      method == null ||
      flags == null ||
      compSize == null ||
      nameLen == null ||
      extraLen == null
    ) {
      return null;
    }
    if (flags & 0x0008) return null;
    const nameStart = p + 30;
    if (nameStart + nameLen > bytes.length) return null;
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + nameLen)).replace(
      /\\/g,
      "/"
    );
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > bytes.length) return null;
    if (name === wanted) {
      if (method !== 0) return null;
      if (compSize > maxLen || dataStart + compSize > bytes.length) return null;
      return bytes.subarray(dataStart, dataStart + compSize);
    }
    if (dataStart + compSize > bytes.length) return null;
    p = dataStart + compSize;
  }
  return null;
}

function hasZipName(names: string[], exact: string): boolean {
  return names.some((name) => name === exact);
}

function hasZipPrefix(names: string[], prefix: string): boolean {
  return names.some((name) => name === prefix || name.startsWith(prefix));
}

function detectZipKind(bytes: Uint8Array): NoticeFileExt | null {
  const names = zipCentralDirectoryNames(bytes);
  if (!names || names.length === 0) return null;
  const lower = names.map((name) => name.toLowerCase());
  if (lower.some((name) => name.includes("vbaproject.bin"))) return null;
  if (hasZipName(lower, "xl/workbook.xml") && hasZipName(lower, "[content_types].xml")) {
    if (hasZipPrefix(lower, "word/") || hasZipPrefix(lower, "ppt/")) return null;
    return "xlsx";
  }
  const mimeBytes = zipStoredEntryBytes(bytes, "mimetype", 64);
  const mime = mimeBytes
    ? new TextDecoder("utf-8", { fatal: false }).decode(mimeBytes).trim()
    : "";
  const hwpxLayout =
    hasZipName(lower, "contents/content.hpf") || hasZipName(lower, "contents/header.xml");
  if (mime === NOTICE_FILE_HWPX_MIME || (hasZipName(lower, "mimetype") && hwpxLayout)) {
    if (hasZipName(lower, "xl/workbook.xml")) return null;
    return "hwpx";
  }
  return null;
}

function detectOleKind(bytes: Uint8Array): NoticeFileExt | null {
  if (!isOleMagic(bytes)) return null;
  const hwpSig = findAscii(bytes, "HWP Document File");
  const fileHeader = findAsciiAsUtf16le(bytes, "FileHeader");
  const workbook = findAsciiAsUtf16le(bytes, "Workbook") || findAsciiAsUtf16le(bytes, "Book");
  const word = findAsciiAsUtf16le(bytes, "WordDocument");
  const ppt = findAsciiAsUtf16le(bytes, "PowerPoint Document");
  if (hwpSig && fileHeader && !workbook && !word && !ppt) return "hwp";
  if (workbook && !hwpSig && !fileHeader && !word && !ppt) return "xls";
  return null;
}

export function detectNoticeFileKind(bytes: Uint8Array): NoticeFileKind | null {
  if (!bytes || bytes.byteLength === 0) return null;
  const prefix =
    bytes.byteLength > NOTICE_FILE_MAGIC_PREFIX_BYTES
      ? bytes.subarray(0, NOTICE_FILE_MAGIC_PREFIX_BYTES)
      : bytes;
  if (isHeic(prefix) || isImageMagic(prefix) || looksLikeHostilePrefix(prefix)) return null;
  if (isPdfMagic(prefix)) {
    if (isZipMagic(prefix) || isOleMagic(prefix)) return null;
    return { ext: "pdf", mime: NOTICE_FILE_PDF_MIME };
  }
  if (isZipMagic(bytes)) {
    const ext = detectZipKind(bytes);
    if (!ext) return null;
    return { ext, mime: NOTICE_FILE_MIME_BY_EXT[ext] };
  }
  if (isOleMagic(bytes)) {
    const ext = detectOleKind(bytes);
    if (!ext) return null;
    return { ext, mime: NOTICE_FILE_MIME_BY_EXT[ext] };
  }
  return null;
}

export function assertNoticeFileBytes(
  bytes: Uint8Array,
  claimedExt?: NoticeFileExt | null
): NoticeFileKind {
  if (!bytes || bytes.byteLength === 0) {
    throw new NoticeFileValidationError("empty_file", "첨부파일이 필요합니다.");
  }
  if (bytes.byteLength > NOTICE_FILE_MAX_BYTES) {
    throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
  }
  const kind = detectNoticeFileKind(bytes);
  if (!kind) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  if (claimedExt && claimedExt !== kind.ext) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  return kind;
}

export function assertNoticePdfPrefix(input: {
  prefix: Uint8Array;
  totalSize: number;
}): typeof NOTICE_FILE_PDF_MIME {
  const totalSize = input.totalSize;
  if (!Number.isFinite(totalSize) || totalSize <= 0 || input.prefix.byteLength === 0) {
    throw new NoticeFileValidationError("empty_file", "첨부파일이 필요합니다.");
  }
  if (totalSize > NOTICE_FILE_MAX_BYTES) {
    throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
  }
  const kind = detectNoticeFileKind(input.prefix);
  if (!kind || kind.ext !== "pdf") {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  return NOTICE_FILE_PDF_MIME;
}

export function assertNoticePdfBytes(bytes: Uint8Array): typeof NOTICE_FILE_PDF_MIME {
  const kind = assertNoticeFileBytes(bytes, "pdf");
  return kind.mime as typeof NOTICE_FILE_PDF_MIME;
}
