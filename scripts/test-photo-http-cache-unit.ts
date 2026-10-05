/**
 * Private photo cache: ETag from DB metadata, auth-first 304, no long max-age.
 * 실행: npm run test:photo-http-cache-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  PRIVATE_PHOTO_CACHE_CONTROL,
  buildPrivatePhotoETag,
  ifNoneMatchContains,
} from "../src/lib/privatePhotoCache";

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

function authBeforeEtag(src: string, authNeedle: string) {
  const authAt = src.indexOf(authNeedle);
  const etagAt = src.indexOf("ifNoneMatchContains");
  return authAt >= 0 && etagAt > authAt;
}

section("etag from metadata, no raw key");
{
  const a = buildPrivatePhotoETag("n", { id: 4, size: 200076, storageKey: "notices/8/secret.jpg" });
  const b = buildPrivatePhotoETag("n", { id: 4, size: 200076, storageKey: "notices/8/secret.jpg" });
  const c = buildPrivatePhotoETag("n", { id: 4, size: 200077, storageKey: "notices/8/secret.jpg" });
  const d = buildPrivatePhotoETag("r", { id: 4, size: 200076, storageKey: "notices/8/secret.jpg" });
  assert(a === b, "stable for same meta");
  assert(a !== c, "size change rotates etag");
  assert(a !== d, "kind is part of etag");
  assert(a.startsWith('"n4-200076-'), "notice prefix + id + size");
  assert(!a.includes("notices/"), "storageKey not in etag");
  assert(!a.includes("secret"), "raw key not in etag");
  assert(PRIVATE_PHOTO_CACHE_CONTROL === "private, no-cache", "store + revalidate");
}

section("If-None-Match");
{
  const etag = buildPrivatePhotoETag("n", { id: 1, size: 10, storageKey: "k" });
  assert(ifNoneMatchContains(etag, etag) === true, "exact match");
  assert(ifNoneMatchContains(`W/${etag}`, etag) === true, "weak prefix accepted");
  assert(ifNoneMatchContains(`${etag}, "other"`, etag) === true, "list match");
  assert(ifNoneMatchContains('"nope"', etag) === false, "mismatch");
  assert(ifNoneMatchContains(null, etag) === false, "missing header");
  assert(ifNoneMatchContains("*", etag) === false, "star is not a private match");
}

section("auth-first in both GET routes");
{
  const notice = read("src/app/api/notice/[id]/photos/[photoId]/route.ts");
  const report = read("src/app/api/course-reports/[id]/photos/[photoId]/route.ts");
  assert(authBeforeEtag(notice, "requireNoticeReader"), "notice auth before etag");
  assert(authBeforeEtag(report, "requireCourseReportReader"), "report auth before etag");
  assert(notice.includes("loadNoticePhotoMeta"), "notice DB meta before blob");
  assert(report.includes("loadCourseReportPhotoMeta"), "report DB meta before blob");
  assert(notice.includes("openNoticePhotoBody"), "notice blob only on 200");
  assert(report.includes("openCourseReportPhotoBody"), "report blob only on 200");
  assert(notice.includes("photoObjectToResponseBody"), "notice streams body");
  assert(report.includes("photoObjectToResponseBody"), "report streams body");
  assert(notice.includes('status: 304'), "notice 304");
  assert(report.includes('status: 304'), "report 304");
  assert(notice.includes("privatePhotoCacheHeaders"), "notice shared cache headers");
  assert(report.includes("privatePhotoCacheHeaders"), "report shared cache headers");
  assert(!notice.includes("max-age=60"), "notice dropped short max-age");
  assert(!report.includes("max-age=60"), "report dropped short max-age");
  assert(!notice.includes("max-age=604800"), "notice no week max-age");
  assert(!report.includes("immutable"), "report no immutable");
  assert(!notice.includes("immutable"), "notice no immutable");
}

section("blob get stays uncached on 200 miss");
{
  const storage = read("src/lib/courseReportPhotoStorage.ts");
  assert(storage.includes("useCache: false"), "200 path still useCache false");
  assert(storage.includes("async open"), "blob open is official stream");
  assert(/return result\.stream/.test(storage), "open returns SDK stream");
  assert(!/async open[\s\S]*arrayBuffer/.test(storage), "open does not buffer");
}

section("no Next/Image / no schema width");
{
  const notice = read("src/components/notice/NoticePhotoGallery.tsx");
  const report = read("src/app/course-reports/CourseReportPhotoGallery.tsx");
  const schema = read("prisma/schema.prisma");
  const client = read("src/lib/courseReportPhotoClient.ts");
  assert(!notice.includes("next/image"), "notice no next/image");
  assert(!report.includes("next/image"), "report no next/image");
  const photoModel = schema.split("model NoticePhoto")[1]?.split("model ")[0] ?? "";
  assert(!/\bwidth\b/.test(photoModel.replace(/\/\/[^\n]*/g, "")), "no NoticePhoto width");
  assert(client.includes("COURSE_REPORT_PHOTO_LONG_EDGE"), "upload uses shared long-edge");
  assert(client.includes("COURSE_REPORT_PHOTO_JPEG_QUALITY"), "upload quality unchanged");
  assert(read("src/lib/courseReportPhotoConstants.ts").includes("COURSE_REPORT_PHOTO_LONG_EDGE = 1200"), "new uploads 1200");
  assert(read("src/lib/courseReportPhotoConstants.ts").includes("COURSE_REPORT_PHOTO_JPEG_QUALITY = 0.8"), "quality stays 0.8");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
