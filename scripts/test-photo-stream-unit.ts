/**
 * Photo GET streams Blob body after auth/ETag. NextResponse must not wait for full bytes.
 * 실행: npm run test:photo-stream-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  formatPhotoServerTiming,
  photoObjectToResponseBody,
  privatePhotoBodyHeaders,
} from "../src/lib/photoObjectBody";
import { COURSE_REPORT_PHOTO_LONG_EDGE } from "../src/lib/courseReportPhotoConstants";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayedStream(firstMs: number, restMs: number, chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await delay(firstMs);
      controller.enqueue(chunks[0]);
      await delay(restMs);
      for (const chunk of chunks.slice(1)) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function main() {
  console.log("== helpers ==");
  {
    const timing = formatPhotoServerTiming({ auth: 1.23, db: 4.5, blob_open: 12 });
    assert(timing.includes("auth;dur=1.2"), "server-timing auth");
    assert(timing.includes("db;dur=4.5"), "server-timing db");
    assert(timing.includes("blob_open;dur=12.0"), "server-timing blob_open");
    const headers = privatePhotoBodyHeaders('"n1-10-abcd"', "image/jpeg", 10);
    assert(headers["Cache-Control"] === "private, no-cache", "keeps private no-cache");
    assert(headers.ETag === '"n1-10-abcd"', "keeps etag");
    assert(headers["Content-Length"] === "10", "content-length from db size");
    assert(headers["Content-Type"] === "image/jpeg", "content-type");
  }

  console.log("== NextResponse stream TTFB ==");
  {
    const first = new Uint8Array([1, 2, 3, 4]);
    const rest = new Uint8Array(32).fill(9);
    const t0 = performance.now();
    const res = new NextResponse(
      photoObjectToResponseBody(delayedStream(60, 180, [first, rest])),
      { status: 200, headers: { "Content-Type": "image/jpeg" } }
    );
    const headerMs = performance.now() - t0;
    const reader = res.body?.getReader();
    assert(Boolean(reader), "response has readable body");
    const firstRead = await reader!.read();
    const firstByteMs = performance.now() - t0;
    const leftover: Uint8Array[] = [];
    if (firstRead.value) leftover.push(firstRead.value);
    while (true) {
      const next = await reader!.read();
      if (next.done) break;
      if (next.value) leftover.push(next.value);
    }
    const bodyMs = performance.now() - t0;
    const total = leftover.reduce((n, c) => n + c.byteLength, 0);
    assert(headerMs < 30, `headers before first chunk (${headerMs.toFixed(1)}ms)`);
    assert(firstByteMs >= 50 && firstByteMs < 160, `first byte after stream start (${firstByteMs.toFixed(1)}ms)`);
    assert(bodyMs >= 220, `full body waits for stream (${bodyMs.toFixed(1)}ms)`);
    assert(total === 36, "stream bytes complete");
  }

  console.log("== buffered path waits for full object ==");
  {
    const t0 = performance.now();
    await delay(80);
    const bytes = new Uint8Array(36).fill(1);
    const res = new NextResponse(Buffer.from(bytes), { status: 200 });
    const headerMs = performance.now() - t0;
    await res.arrayBuffer();
    assert(headerMs >= 70, `buffer path headers after full download (${headerMs.toFixed(1)}ms)`);
  }

  console.log("== source: stream after auth/etag ==");
  {
    const notice = read("src/app/api/notice/[id]/photos/[photoId]/route.ts");
    const report = read("src/app/api/course-reports/[id]/photos/[photoId]/route.ts");
    const storage = read("src/lib/courseReportPhotoStorage.ts");
    const noticeGet = notice.slice(notice.indexOf("export async function GET"));
    const reportGet = report.slice(report.indexOf("export async function GET"));
    assert(noticeGet.indexOf("requireNoticeReader") < noticeGet.indexOf("openNoticePhotoBody"), "notice auth before stream");
    assert(reportGet.indexOf("requireCourseReportReader") < reportGet.indexOf("openCourseReportPhotoBody"), "report auth before stream");
    assert(noticeGet.indexOf("ifNoneMatchContains") < noticeGet.indexOf("openNoticePhotoBody"), "notice etag before stream");
    assert(reportGet.indexOf("ifNoneMatchContains") < reportGet.indexOf("openCourseReportPhotoBody"), "report etag before stream");
    assert(!notice.includes("Buffer.from(bytes)"), "notice 200 is not pre-buffered");
    assert(!report.includes("Buffer.from(bytes)"), "report 200 is not pre-buffered");
    assert(storage.includes("useCache: false"), "blob get still uncached");
    assert(storage.includes("access: \"private\""), "blob stays private");
    assert(COURSE_REPORT_PHOTO_LONG_EDGE === 1200, "new upload long-edge 1200");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
