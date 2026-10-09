/**
 * JPEG/PNG/WEBP header dimension parser. No schema, no I/O.
 * 실행: npm run test:image-header-size-unit
 */
import {
  orientedImageHeaderSize,
  readImageSizeFromHeader,
  readJpegExifOrientation,
} from "../src/lib/imageHeaderSize";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function jpegSof(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
  ]);
}

function pngIhdr(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  out[16] = (width >>> 24) & 0xff;
  out[17] = (width >>> 16) & 0xff;
  out[18] = (width >>> 8) & 0xff;
  out[19] = width & 0xff;
  out[20] = (height >>> 24) & 0xff;
  out[21] = (height >>> 16) & 0xff;
  out[22] = (height >>> 8) & 0xff;
  out[23] = height & 0xff;
  return out;
}

console.log("== image header size ==");
{
  const jpeg = readImageSizeFromHeader(jpegSof(1080, 1920));
  assert(jpeg?.format === "jpeg", "jpeg format");
  assert(jpeg?.width === 1080 && jpeg?.height === 1920, "jpeg portrait 1080x1920");
  const png = readImageSizeFromHeader(pngIhdr(1600, 900));
  assert(png?.format === "png", "png format");
  assert(png?.width === 1600 && png?.height === 900, "png landscape");
  assert(readImageSizeFromHeader(new Uint8Array(8)) === null, "short buffer null");
  assert(readImageSizeFromHeader(Uint8Array.from([0x00, 0x01, 0x02, 0x03])) === null, "unknown null");
  const portrait = readImageSizeFromHeader(jpegSof(900, 1600));
  assert(portrait !== null && portrait.height > portrait.width, "portrait ratio preserved");

  const exif6 = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x1e,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x06, 0x00, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x0b, 0xb8, 0x0f, 0xa0, 0x03,
  ]);
  assert(readJpegExifOrientation(exif6) === 6, "APP1 Orientation 6");
  const sof = readImageSizeFromHeader(exif6);
  assert(sof?.width === 4000 && sof?.height === 3000, "SOF before swap is 4000x3000");
  const swapped = orientedImageHeaderSize(sof!, 6);
  assert(swapped.width === 3000 && swapped.height === 4000, "orientation 6 swaps to 3000x4000");
  assert(orientedImageHeaderSize(sof!, 1).width === 4000, "orientation 1 keeps SOF");
  assert(readJpegExifOrientation(jpegSof(1080, 1920)) === 1, "missing EXIF defaults to 1");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
