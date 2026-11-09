/**
 * Notice-only image sizing. Course-report / chat encode settings must stay 1200/0.8.
 * 실행: npm run test:notice-photo-prepare-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  NOTICE_PHOTO_JPEG_QUALITY,
  NOTICE_PHOTO_LONG_EDGE,
  NOTICE_PHOTO_MAX,
  NOTICE_PHOTO_MAX_BYTES,
  NOTICE_PHOTO_MAX_SHORT_EDGE,
} from "../src/lib/noticePhotoConstants";
import {
  isNoticeKeepPngMime,
  isNoticeTallCapture,
  noticePhotoCanPassthrough,
  noticePhotoTargetSize,
} from "../src/lib/noticePhotoPrepare";
import {
  COURSE_REPORT_PHOTO_JPEG_QUALITY,
  COURSE_REPORT_PHOTO_LONG_EDGE,
  COURSE_REPORT_PHOTO_MAX,
} from "../src/lib/courseReportPhotoConstants";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

section("constants split from course-report");
{
  assert(NOTICE_PHOTO_MAX === 10, "notice max 10");
  assert(COURSE_REPORT_PHOTO_MAX === 3, "course-report max stays 3");
  assert(NOTICE_PHOTO_LONG_EDGE === 4096, "notice long-edge 4096");
  assert(NOTICE_PHOTO_MAX_SHORT_EDGE === 2048, "notice short-edge 2048");
  assert(NOTICE_PHOTO_JPEG_QUALITY === 0.92, "notice jpeg 0.92");
  assert(COURSE_REPORT_PHOTO_LONG_EDGE === 1200, "course-report long-edge 1200");
  assert(COURSE_REPORT_PHOTO_JPEG_QUALITY === 0.8, "course-report jpeg 0.8");
  assert(NOTICE_PHOTO_MAX_BYTES === 8 * 1024 * 1024, "notice photo 8MB");
}

section("long capture keeps width");
{
  assert(isNoticeTallCapture(1080, 8000) === true, "1080x8000 is tall");
  const tall = noticePhotoTargetSize(1080, 8000);
  assert(tall.width === 1080 && tall.height === 8000, "1080x8000 not downscaled by long-edge");
  const phone = noticePhotoTargetSize(1170, 2532);
  assert(phone.width === 1170 && phone.height === 2532, "phone screenshot passthrough size");
  const hugeTall = noticePhotoTargetSize(4000, 12000);
  assert(hugeTall.width === 2048 && hugeTall.height === 6144, "tall scales by short edge 2048");
  const camera = noticePhotoTargetSize(4032, 3024);
  assert(camera.width === 4032 && camera.height === 3024, "normal camera under 4096 passthrough");
  const big = noticePhotoTargetSize(6000, 4000);
  assert(big.width === 4096 && big.height === 2731, "wide camera long-edge 4096");
}

section("png passthrough / jpeg conversion avoided");
{
  assert(isNoticeKeepPngMime("image/png") === true, "png kept");
  assert(isNoticeKeepPngMime("image/jpeg") === false, "jpeg not treated as png");
  assert(
    noticePhotoCanPassthrough({
      width: 1080,
      height: 8000,
      size: 2 * 1024 * 1024,
      mime: "image/png",
    }) === true,
    "tall png under 8MB passthrough"
  );
  assert(
    noticePhotoCanPassthrough({
      width: 1080,
      height: 8000,
      size: 9 * 1024 * 1024,
      mime: "image/png",
    }) === false,
    "oversize png not passthrough"
  );
  const client = read("src/lib/noticePhotoClient.ts");
  assert(client.includes("isNoticeKeepPngMime"), "encoder keeps png");
  assert(client.includes("noticePhotoCanPassthrough"), "skips recompress when possible");
  assert(!read("src/lib/courseReportPhotoClient.ts").includes("NOTICE_PHOTO_LONG_EDGE"), "report client ignores notice constants");
  assert(read("src/lib/chatPhotoClient.ts").includes("prepareCourseReportPhoto as prepareChatPhoto"), "chat prepare unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
