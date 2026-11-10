import {
  NOTICE_FILE_MAGIC_PREFIX_BYTES,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME_BY_EXT,
  NOTICE_FILE_HWPX_MIME,
  NOTICE_FILE_OLE_MAX_DIR_ENTRIES,
  NOTICE_FILE_OLE_MAX_FAT_ENTRIES,
  NOTICE_FILE_OLE_MAX_MINI_STREAM,
  NOTICE_FILE_PDF_MIME,
  NOTICE_FILE_ZIP_MAX_CD_BYTES,
  NOTICE_FILE_ZIP_MAX_ENTRIES,
  NOTICE_FILE_ZIP_MAX_UNCOMPRESSED_ENTRY,
  NOTICE_FILE_ZIP_MAX_UNCOMPRESSED_TOTAL,
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

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_DATA_DESC = 0x0008;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const OLE_FREESECT = 0xffffffff;
const OLE_ENDOFCHAIN = 0xfffffffe;
const OLE_FATSECT = 0xfffffffd;
const OLE_DIFSECT = 0xfffffffc;
const OLE_NOSTREAM = 0xffffffff;
const OLE_TYPE_STREAM = 2;
const OLE_TYPE_ROOT = 5;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataStart: number;
  dataEnd: number;
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
  return startsWith(bytes, OLE_MAGIC);
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

function decodeZipName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0/g, "");
}

function normalizeZipName(name: string): string {
  return name.replace(/\\/g, "/");
}

function extraHasZip64(extra: Uint8Array): boolean {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = readU16LE(extra, p);
    const size = readU16LE(extra, p + 2);
    if (id == null || size == null) return true;
    if (id === 0x0001) return true;
    p += 4 + size;
    if (p > extra.length) return true;
  }
  return false;
}

function rangesOverlap(ranges: Array<[number, number]>): boolean {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]![0] < sorted[i - 1]![1]) return true;
  }
  return false;
}

function parseVerifiedZip(bytes: Uint8Array): ZipEntry[] | null {
  if (!isZipMagic(bytes)) return null;
  const maxScan = Math.min(bytes.length, 0xffff + 22);
  let eocd = -1;
  const start = bytes.length - 22;
  const end = bytes.length - maxScan;
  for (let i = start; i >= end && i >= 0; i--) {
    if (readU32LE(bytes, i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const disk = readU16LE(bytes, eocd + 4);
  const cdDisk = readU16LE(bytes, eocd + 6);
  const diskEntries = readU16LE(bytes, eocd + 8);
  const totalEntries = readU16LE(bytes, eocd + 10);
  const cdSize = readU32LE(bytes, eocd + 12);
  const cdOffset = readU32LE(bytes, eocd + 16);
  if (
    disk == null ||
    cdDisk == null ||
    diskEntries == null ||
    totalEntries == null ||
    cdSize == null ||
    cdOffset == null
  ) {
    return null;
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) return null;
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null;
  if (totalEntries === 0 || totalEntries > NOTICE_FILE_ZIP_MAX_ENTRIES) return null;
  if (cdSize > NOTICE_FILE_ZIP_MAX_CD_BYTES) return null;
  if (cdOffset + cdSize > eocd) return null;
  const names = new Set<string>();
  const entries: ZipEntry[] = [];
  const occupied: Array<[number, number]> = [[cdOffset, eocd + 22]];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let uncompressedTotal = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdEnd) return null;
    if (readU32LE(bytes, p) !== ZIP_CENTRAL) return null;
    const flags = readU16LE(bytes, p + 8);
    const method = readU16LE(bytes, p + 10);
    const crc = readU32LE(bytes, p + 16);
    const compressedSize = readU32LE(bytes, p + 20);
    const uncompressedSize = readU32LE(bytes, p + 24);
    const nameLen = readU16LE(bytes, p + 28);
    const extraLen = readU16LE(bytes, p + 30);
    const commentLen = readU16LE(bytes, p + 32);
    const localOffset = readU32LE(bytes, p + 42);
    if (
      flags == null ||
      method == null ||
      crc == null ||
      compressedSize == null ||
      uncompressedSize == null ||
      nameLen == null ||
      extraLen == null ||
      commentLen == null ||
      localOffset == null
    ) {
      return null;
    }
    if (flags & ZIP_FLAG_ENCRYPTED || flags & ZIP_FLAG_DATA_DESC) return null;
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) return null;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return null;
    if (uncompressedSize > NOTICE_FILE_ZIP_MAX_UNCOMPRESSED_ENTRY) return null;
    if (method === ZIP_METHOD_STORE && compressedSize !== uncompressedSize) return null;
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > NOTICE_FILE_ZIP_MAX_UNCOMPRESSED_TOTAL) return null;
    const nameStart = p + 46;
    if (nameStart + nameLen + extraLen + commentLen > cdEnd) return null;
    const name = normalizeZipName(decodeZipName(bytes.subarray(nameStart, nameStart + nameLen)));
    if (!name || name.includes("..") || name.startsWith("/") || name.includes("\\")) return null;
    const lower = name.toLowerCase();
    if (names.has(lower)) return null;
    names.add(lower);
    const extra = bytes.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
    if (extraHasZip64(extra)) return null;
    if (localOffset + 30 > cdOffset) return null;
    if (readU32LE(bytes, localOffset) !== ZIP_LOCAL) return null;
    const localFlags = readU16LE(bytes, localOffset + 6);
    const localMethod = readU16LE(bytes, localOffset + 8);
    const localComp = readU32LE(bytes, localOffset + 18);
    const localUncomp = readU32LE(bytes, localOffset + 22);
    const localNameLen = readU16LE(bytes, localOffset + 26);
    const localExtraLen = readU16LE(bytes, localOffset + 28);
    if (
      localFlags == null ||
      localMethod == null ||
      localComp == null ||
      localUncomp == null ||
      localNameLen == null ||
      localExtraLen == null
    ) {
      return null;
    }
    if (localFlags & ZIP_FLAG_ENCRYPTED || localFlags & ZIP_FLAG_DATA_DESC) return null;
    if (localMethod !== method) return null;
    if (localComp !== compressedSize || localUncomp !== uncompressedSize) return null;
    const localNameStart = localOffset + 30;
    if (localNameStart + localNameLen + localExtraLen > bytes.length) return null;
    const localName = normalizeZipName(
      decodeZipName(bytes.subarray(localNameStart, localNameStart + localNameLen))
    );
    if (localName !== name) return null;
    const localExtra = bytes.subarray(
      localNameStart + localNameLen,
      localNameStart + localNameLen + localExtraLen
    );
    if (extraHasZip64(localExtra)) return null;
    const dataStart = localNameStart + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) return null;
    occupied.push([localOffset, dataEnd]);
    entries.push({
      name: lower,
      method,
      compressedSize,
      uncompressedSize,
      dataStart,
      dataEnd,
    });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  if (p !== cdEnd) return null;
  if (rangesOverlap(occupied)) return null;
  return entries;
}

function zipStoredFile(
  bytes: Uint8Array,
  entries: ZipEntry[],
  wanted: string,
  maxLen: number
): Uint8Array | null {
  const entry = entries.find((item) => item.name === wanted.toLowerCase());
  if (!entry || entry.method !== ZIP_METHOD_STORE) return null;
  if (entry.compressedSize > maxLen) return null;
  return bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
}

function hasZipName(entries: ZipEntry[], exact: string): boolean {
  return entries.some((entry) => entry.name === exact);
}

function hasZipPrefix(entries: ZipEntry[], prefix: string): boolean {
  return entries.some((entry) => entry.name === prefix || entry.name.startsWith(prefix));
}

function requiredZipSize(entries: ZipEntry[], name: string): boolean {
  const entry = entries.find((item) => item.name === name);
  return Boolean(entry && entry.uncompressedSize > 0);
}

function detectZipKind(bytes: Uint8Array): NoticeFileExt | null {
  const entries = parseVerifiedZip(bytes);
  if (!entries || entries.length === 0) return null;
  if (hasZipPrefix(entries, "xl/vbaproject.bin") || hasZipName(entries, "xl/vbaproject.bin")) {
    return null;
  }
  if (entries.some((entry) => entry.name.includes("vbaproject.bin"))) return null;
  if (hasZipName(entries, "xl/workbook.xml") && hasZipName(entries, "[content_types].xml")) {
    if (hasZipPrefix(entries, "word/") || hasZipPrefix(entries, "ppt/")) return null;
    if (
      !requiredZipSize(entries, "xl/workbook.xml") ||
      !requiredZipSize(entries, "[content_types].xml")
    ) {
      return null;
    }
    return "xlsx";
  }
  const mimeBytes = zipStoredFile(bytes, entries, "mimetype", 64);
  if (!mimeBytes) return null;
  const mime = new TextDecoder("utf-8", { fatal: false }).decode(mimeBytes).trim();
  const hwpxLayout =
    requiredZipSize(entries, "contents/content.hpf") ||
    requiredZipSize(entries, "contents/header.xml");
  if (mime === NOTICE_FILE_HWPX_MIME && hwpxLayout) {
    if (hasZipName(entries, "xl/workbook.xml")) return null;
    return "hwpx";
  }
  return null;
}

function oleSectorSize(shift: number): number | null {
  if (shift === 9) return 512;
  if (shift === 12) return 4096;
  return null;
}

function oleFollowChain(
  fat: number[],
  start: number,
  maxSectors: number,
  exactEnd = true
): number[] | null {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur = start;
  while (cur !== OLE_ENDOFCHAIN && out.length < maxSectors) {
    if (cur === OLE_FREESECT || cur === OLE_FATSECT || cur === OLE_DIFSECT) return null;
    if (cur >= fat.length || seen.has(cur)) return null;
    seen.add(cur);
    out.push(cur);
    cur = fat[cur]!;
  }
  if (exactEnd && cur !== OLE_ENDOFCHAIN) return null;
  return out;
}

function oleReadSectors(
  bytes: Uint8Array,
  headerSize: number,
  sectorSize: number,
  chain: number[]
): Uint8Array | null {
  const out = new Uint8Array(chain.length * sectorSize);
  for (let i = 0; i < chain.length; i++) {
    const offset = headerSize + chain[i]! * sectorSize;
    if (offset + sectorSize > bytes.length) return null;
    out.set(bytes.subarray(offset, offset + sectorSize), i * sectorSize);
  }
  return out;
}

function oleBuildFat(bytes: Uint8Array, headerSize: number, sectorSize: number): number[] | null {
  const fatCount = readU32LE(bytes, 0x2c);
  const difatStart = readU32LE(bytes, 0x44);
  const difatCount = readU32LE(bytes, 0x48);
  if (fatCount == null || difatStart == null || difatCount == null) return null;
  if (fatCount === 0 || fatCount > 1024 || difatCount > 64) return null;
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sector = readU32LE(bytes, 0x4c + i * 4);
    if (sector == null) return null;
    if (sector !== OLE_FREESECT) fatSectors.push(sector);
  }
  let next = difatStart;
  for (let d = 0; d < difatCount; d++) {
    if (next === OLE_ENDOFCHAIN || next === OLE_FREESECT) return null;
    const offset = headerSize + next * sectorSize;
    if (offset + sectorSize > bytes.length) return null;
    const entries = sectorSize / 4;
    for (let i = 0; i < entries - 1; i++) {
      const sector = readU32LE(bytes, offset + i * 4);
      if (sector == null) return null;
      if (sector !== OLE_FREESECT) fatSectors.push(sector);
    }
    const following = readU32LE(bytes, offset + (entries - 1) * 4);
    if (following == null) return null;
    next = following;
  }
  if (fatSectors.length < fatCount) return null;
  const fat: number[] = [];
  for (let i = 0; i < fatCount; i++) {
    const offset = headerSize + fatSectors[i]! * sectorSize;
    if (offset + sectorSize > bytes.length) return null;
    for (let j = 0; j < sectorSize; j += 4) {
      const value = readU32LE(bytes, offset + j);
      if (value == null) return null;
      fat.push(value);
      if (fat.length > NOTICE_FILE_OLE_MAX_FAT_ENTRIES) return null;
    }
  }
  return fat;
}

type OleDir = {
  name: string;
  type: number;
  start: number;
  size: number;
};

function oleParseDirectory(
  bytes: Uint8Array,
  headerSize: number,
  sectorSize: number,
  fat: number[],
  dirStart: number
): OleDir[] | null {
  const chain = oleFollowChain(fat, dirStart, 32);
  if (!chain) return null;
  const raw = oleReadSectors(bytes, headerSize, sectorSize, chain);
  if (!raw) return null;
  const entries: OleDir[] = [];
  for (let offset = 0; offset + 128 <= raw.length; offset += 128) {
    if (entries.length >= NOTICE_FILE_OLE_MAX_DIR_ENTRIES) return null;
    const type = raw[offset + 0x42];
    if (type === 0) continue;
    const nameBytes = readU16LE(raw, offset + 0x40);
    if (nameBytes == null || nameBytes < 2 || nameBytes > 64) return null;
    const chars = (nameBytes - 2) / 2;
    let name = "";
    for (let i = 0; i < chars; i++) {
      const code = readU16LE(raw, offset + i * 2);
      if (code == null) return null;
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    const start = readU32LE(raw, offset + 0x74);
    const sizeLow = readU32LE(raw, offset + 0x78);
    if (start == null || sizeLow == null) return null;
    entries.push({
      name,
      type,
      start,
      size: sizeLow,
    });
  }
  return entries;
}

function oleReadStream(
  bytes: Uint8Array,
  headerSize: number,
  sectorSize: number,
  fat: number[],
  miniFat: number[] | null,
  miniStream: Uint8Array | null,
  cutoff: number,
  entry: OleDir,
  maxBytes: number
): Uint8Array | null {
  if (entry.size === 0 || maxBytes <= 0) return new Uint8Array(0);
  const takeSize = Math.min(entry.size, maxBytes);
  const useMini = entry.size < cutoff && miniFat && miniStream;
  if (useMini) {
    const miniSize = 64;
    const needed = Math.ceil(takeSize / miniSize);
    const chain = oleFollowChain(miniFat, entry.start, needed, false);
    if (!chain || chain.length < needed) return null;
    const out = new Uint8Array(takeSize);
    let written = 0;
    for (const miniSector of chain) {
      const start = miniSector * miniSize;
      if (start + miniSize > miniStream.length) return null;
      const take = Math.min(miniSize, takeSize - written);
      out.set(miniStream.subarray(start, start + take), written);
      written += take;
      if (written >= takeSize) break;
    }
    return out;
  }
  const needed = Math.ceil(takeSize / sectorSize);
  const chain = oleFollowChain(fat, entry.start, needed, false);
  if (!chain || chain.length < needed) return null;
  const raw = oleReadSectors(bytes, headerSize, sectorSize, chain);
  if (!raw) return null;
  return raw.subarray(0, takeSize);
}

function parseOleCompound(bytes: Uint8Array): {
  streams: OleDir[];
  readStream: (name: string, maxBytes: number) => Uint8Array | null;
} | null {
  if (!isOleMagic(bytes) || bytes.length < 512) return null;
  const byteOrder = readU16LE(bytes, 0x1c);
  const sectorShift = readU16LE(bytes, 0x1e);
  const miniShift = readU16LE(bytes, 0x20);
  const dirStart = readU32LE(bytes, 0x30);
  const cutoff = readU32LE(bytes, 0x38);
  const miniFatStart = readU32LE(bytes, 0x3c);
  if (
    byteOrder !== 0xfffe ||
    sectorShift == null ||
    miniShift == null ||
    dirStart == null ||
    cutoff == null ||
    miniFatStart == null
  ) {
    return null;
  }
  const sectorSize = oleSectorSize(sectorShift);
  if (!sectorSize || miniShift !== 6) return null;
  const headerSize = 512;
  const fat = oleBuildFat(bytes, headerSize, sectorSize);
  if (!fat) return null;
  const dirs = oleParseDirectory(bytes, headerSize, sectorSize, fat, dirStart);
  if (!dirs) return null;
  const root = dirs.find((entry) => entry.type === OLE_TYPE_ROOT);
  if (!root) return null;
  let miniFat: number[] | null = null;
  let miniStream: Uint8Array | null = null;
  if (root.size > 0) {
    if (root.size > NOTICE_FILE_OLE_MAX_MINI_STREAM) return null;
    miniStream = oleReadStream(
      bytes,
      headerSize,
      sectorSize,
      fat,
      null,
      null,
      0,
      root,
      NOTICE_FILE_OLE_MAX_MINI_STREAM
    );
    if (!miniStream) return null;
    if (miniFatStart !== OLE_ENDOFCHAIN) {
      const miniFatChain = oleFollowChain(fat, miniFatStart, 32);
      if (!miniFatChain) return null;
      const miniFatRaw = oleReadSectors(bytes, headerSize, sectorSize, miniFatChain);
      if (!miniFatRaw) return null;
      miniFat = [];
      for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) {
        const value = readU32LE(miniFatRaw, i);
        if (value == null) return null;
        miniFat.push(value);
      }
    }
  }
  const streams = dirs.filter((entry) => entry.type === OLE_TYPE_STREAM);
  return {
    streams,
    readStream(name: string, maxBytes: number) {
      const entry = streams.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!entry) return null;
      return oleReadStream(
        bytes,
        headerSize,
        sectorSize,
        fat,
        miniFat,
        miniStream,
        cutoff,
        entry,
        maxBytes
      );
    },
  };
}

function oleHasStream(streams: OleDir[], name: string): boolean {
  const wanted = name.toLowerCase();
  return streams.some((entry) => entry.name.toLowerCase() === wanted);
}

function detectOleKind(bytes: Uint8Array): NoticeFileExt | null {
  const parsed = parseOleCompound(bytes);
  if (!parsed) return null;
  const { streams, readStream } = parsed;
  if (
    oleHasStream(streams, "WordDocument") ||
    oleHasStream(streams, "PowerPoint Document") ||
    oleHasStream(streams, "VBA") ||
    oleHasStream(streams, "_VBA_PROJECT_CUR")
  ) {
    return null;
  }
  const hasFileHeader = oleHasStream(streams, "FileHeader");
  const hasWorkbook = oleHasStream(streams, "Workbook") || oleHasStream(streams, "Book");
  if (hasFileHeader && !hasWorkbook) {
    const header = readStream("FileHeader", 1024);
    if (!header || !findAscii(header.subarray(0, Math.min(header.length, 64)), "HWP Document File")) {
      return null;
    }
    return "hwp";
  }
  if (hasWorkbook && !hasFileHeader) return "xls";
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
