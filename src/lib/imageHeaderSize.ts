/**
 * Read width/height from JPEG/PNG/WEBP headers.
 * Does not persist. Used for future backfill design and tests.
 * Not a substitute for stored metadata on first paint.
 */
export type ImageHeaderSize = {
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
};

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readJpegSize(bytes: Uint8Array): ImageHeaderSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 4 >= bytes.length) return null;
    const length = u16be(bytes, i + 2);
    if (length < 2) return null;
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (i + 9 >= bytes.length) return null;
      const height = u16be(bytes, i + 5);
      const width = u16be(bytes, i + 7);
      if (width < 1 || height < 1) return null;
      return { width, height, format: "jpeg" };
    }
    i += 2 + length;
  }
  return null;
}

function readPngSize(bytes: Uint8Array): ImageHeaderSize | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) return null;
  return { width, height, format: "png" };
}

function readWebpSize(bytes: Uint8Array): ImageHeaderSize | null {
  if (
    bytes.length < 30 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === "VP8X" && bytes.length >= 30) {
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    return { width, height, format: "webp" };
  }
  if (fourcc === "VP8 " && bytes.length >= 30) {
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    if (width < 1 || height < 1) return null;
    return { width, height, format: "webp" };
  }
  if (fourcc === "VP8L" && bytes.length >= 25) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height, format: "webp" };
  }
  return null;
}

export function readImageSizeFromHeader(bytes: Uint8Array): ImageHeaderSize | null {
  if (!bytes || bytes.length < 4) return null;
  return readJpegSize(bytes) || readPngSize(bytes) || readWebpSize(bytes);
}
