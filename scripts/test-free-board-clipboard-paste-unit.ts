/**
 * 가배치표 게시판 Ctrl+V: 공지 붙여넣기 분류/엑셀 변환을 재사용하고
 * 기존 사진 전처리가 엑셀 PNG의 작은 글자를 JPEG로 줄이지 않는지 확인한다.
 * DB·네트워크 없음.
 * 실행: npm run test:free-board-clipboard-paste-unit
 */
import fs from "node:fs";
import path from "node:path";
import { FREE_BOARD_PHOTO_LONG_EDGE, FREE_BOARD_PHOTO_MAX, FREE_BOARD_PHOTO_MAX_BYTES } from "../src/lib/freeBoardConstants";
import {
  FREE_BOARD_ENCODE_STEPS,
  FREE_BOARD_PNG_PASSTHROUGH_LONG_EDGE,
  freeBoardKeepsOriginalPng,
} from "../src/lib/freeBoardPhotoClient";
import { NOTICE_PASTE_HINT } from "../src/lib/noticeClipboardPaste";
import { EXCEL_TABLE_MAX_LONG_EDGE, excelTableScale } from "../src/lib/noticeExcelTableImage";

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

section("excel PNG stays sharp inside the free-board optimizer");
{
  assert(FREE_BOARD_PHOTO_LONG_EDGE === 2560, "JPEG long edge stays 2560");
  assert(FREE_BOARD_PHOTO_MAX === 9, "photo max stays 9");
  assert(FREE_BOARD_PHOTO_MAX_BYTES === 3 * 1024 * 1024, "3MB limit stays");
  assert(
    FREE_BOARD_PNG_PASSTHROUGH_LONG_EDGE === EXCEL_TABLE_MAX_LONG_EDGE,
    "PNG passthrough matches the excel renderer long edge"
  );
  assert(FREE_BOARD_ENCODE_STEPS[0][0] === 2560 && FREE_BOARD_ENCODE_STEPS[0][1] === 0.9, "JPEG ladder still starts at 2560/0.9");
  const wide = excelTableScale(1760, 160);
  const renderedLong = 1760 * wide;
  assert(renderedLong > FREE_BOARD_PHOTO_LONG_EDGE, "a wide placement table renders above 2560");
  assert(renderedLong <= EXCEL_TABLE_MAX_LONG_EDGE, "wide table stays within 4096");
  assert(
    freeBoardKeepsOriginalPng({ mime: "image/png", width: Math.round(renderedLong), height: 400, size: 200_000 }),
    "that PNG is not JPEG-scaled"
  );
  assert(
    freeBoardKeepsOriginalPng({ mime: "image/png;charset=binary", width: 3000, height: 800, size: 50_000 }),
    "png mime parameters still count as PNG"
  );
  assert(
    freeBoardKeepsOriginalPng({ mime: "image/png", width: 4096, height: 1200, size: FREE_BOARD_PHOTO_MAX_BYTES }),
    "4096px PNG at the byte limit is kept"
  );
  assert(
    !freeBoardKeepsOriginalPng({ mime: "image/png", width: 4097, height: 100, size: 10_000 }),
    "PNG above the excel cap still uses the JPEG ladder"
  );
  assert(
    !freeBoardKeepsOriginalPng({
      mime: "image/png",
      width: 1800,
      height: 900,
      size: FREE_BOARD_PHOTO_MAX_BYTES + 1,
    }),
    "PNG over 3MB still uses the JPEG ladder"
  );
  assert(
    !freeBoardKeepsOriginalPng({ mime: "image/jpeg", width: 1200, height: 800, size: 20_000 }),
    "JPEG photos are still re-encoded"
  );
  assert(!freeBoardKeepsOriginalPng({ mime: "image/png", width: 800, height: 600, size: 0 }), "empty PNG is not kept");
  const prep = read("src/lib/freeBoardPhotoClient.ts");
  assert(prep.includes("freeBoardKeepsOriginalPng("), "prepare uses the PNG passthrough decision");
  assert(!prep.includes("html-to-image"), "photo client does not add another renderer");
}

section("free-board composer reuses notice paste");
{
  const form = read("src/app/community/FreeBoardForm.tsx");
  const pasteStart = form.indexOf("function onDocPaste");
  const pasteEnd = form.indexOf('document.addEventListener("paste"', pasteStart);
  const pasteFn = form.slice(pasteStart, pasteEnd);
  const textAt = pasteFn.indexOf('decision.kind === "text"');
  const preventAt = pasteFn.indexOf("preventDefault");
  assert(textAt >= 0 && preventAt > textAt, "plain text Ctrl+V is not intercepted");
  assert(form.includes("{NOTICE_PASTE_HINT}"), "paste hint is shown");
  assert(NOTICE_PASTE_HINT.includes("엑셀"), "hint mentions excel");
  assert(form.includes("classifyNoticeClipboard"), "uses the notice clipboard classifier");
  assert(form.includes("noticeClipboardFromData"), "reads the paste DataTransfer");
  assert(form.includes('import("@/lib/noticeExcelTableImage")'), "excel renderer is loaded only when pasting");
  assert(form.includes("excelClipboardHtmlToNoticePhoto"), "reuses the notice excel PNG");
  assert(!form.includes("function renderExcelTableCanvas"), "does not copy the excel renderer");
  assert(form.includes("prepareFreeBoardPhoto(file)"), "pasted photos still use free-board prepare");
  assert(form.includes("FREE_BOARD_PHOTO_MAX"), "9-photo limit stays on the form");
  assert(form.includes("courseReportPhotoBlobFingerprint"), "duplicate fingerprint check stays");
  assert(form.includes("removedIds"), "edit-mode delete marks stay");
  assert(form.includes('type="file"'), "file picker stays");
  assert(read("src/app/community/new/page.tsx").includes("<FreeBoardForm />"), "create screen uses the form");
  assert(
    read("src/app/community/[id]/edit/page.tsx").includes('mode="edit"'),
    "edit screen uses the same form"
  );
  assert(!fs.existsSync("src/lib/freeBoardExcelTableImage.ts"), "no second excel engine");
  assert(!form.includes("dangerouslySetInnerHTML"), "paste path does not inject HTML");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
