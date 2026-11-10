/**
 * Notice clipboard image / Excel table paste.
 * No database. No network.
 * 실행: npm run test:notice-clipboard-paste-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  NOTICE_PASTE_EXCEL_FALLBACK,
  NOTICE_PASTE_HINT,
  NOTICE_PASTE_TABLE_TOO_LARGE,
  classifyNoticeClipboard,
  isExcelClipboardHtml,
  noticeClipboardFromData,
} from "../src/lib/noticeClipboardPaste";
import {
  EXCEL_TABLE_MIN_LONG_EDGE,
  excelTableScale,
  isExcelNumericText,
  parseExcelClipboardHtml,
  resolveExcelTextAlign,
} from "../src/lib/noticeExcelTableImage";
import { NOTICE_PHOTO_MAX } from "../src/lib/noticePhotoConstants";

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

const EXCEL_HTML = `Version:1.0
StartHTML:0000000100
EndHTML:0000009999
<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 16">
<style>
<!--table
	{mso-displayed-decimal-separator:"\\.";
	mso-displayed-thousand-separator:"\\,";}
td
	{padding:0px;
	color:black;
	font-size:11.0pt;
	font-weight:400;
	font-style:normal;
	font-family:"맑은 고딕",monospace;
	mso-number-format:General;
	text-align:general;
	vertical-align:middle;
	border:none;
	white-space:nowrap;}
.xl65
	{color:white;
	font-weight:700;
	text-align:center;
	border:.5pt solid windowtext;
	background:#1F4E79;}
.xl66
	{border:.5pt solid #7F7F7F;
	background:#FFF2CC;}
.xl67
	{font-weight:700;
	text-align:center;
	vertical-align:middle;
	border:.5pt solid windowtext;
	background:#C6EFCE;
	white-space:normal;}
.xl68
	{color:red;
	font-style:italic;
	text-align:left;
	background:yellow;
	border-top:1pt dashed #FF0000;
	border-right:none;
	border-bottom:none;
	border-left:none;}
-->
</style>
</head>
<body>
<!--StartFragment-->
<table border=0 cellpadding=0 cellspacing=0 width=332 style='border-collapse:collapse;width:249pt'>
 <col width=120 style='mso-width-source:userset;width:90pt'>
 <col width=96 span=1 style='width:72pt'>
 <col width=116 style='width:87pt'>
 <tr height=22 style='height:16.5pt'>
  <td height=22 class=xl65 width=120 style='height:16.5pt;width:90pt'>구분</td>
  <td class=xl65 width=96 style='border-left:none;width:72pt'>수량</td>
  <td class=xl65 width=116 style='border-left:none;width:87pt'>비고</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td height=20 class=xl66 style='height:15.0pt;border-top:none'>한글</td>
  <td class=xl66 align=right style='border-top:none;border-left:none' x:num="1234">1,234</td>
  <td class=xl66 style='border-top:none;border-left:none'>A-10</td>
 </tr>
 <tr height=36 style='height:27.0pt'>
  <td colspan=2 rowspan=1 height=36 class=xl67 style='height:27.0pt;border-top:none'>병합된 셀<br>둘째 줄</td>
  <td class=xl66 style='border-top:none;border-left:none'>3</td>
 </tr>
 <tr height=20 style='height:15.0pt'>
  <td class=xl68>주의</td>
  <td class=xl66 style='border-top:none;border-left:none'><script>alert(1)</script>안전</td>
  <td class=xl66 style='background:url(https://evil.example/a.png);border-top:none;border-left:none'><img src="https://evil.example/b.png">12%</td>
 </tr>
</table>
<!--EndFragment-->
</body>
</html>`;

const WEB_TABLE = `<html><head><title>안내</title></head><body>
<table><tr><td>Microsoft Excel 제품 안내</td><td>1</td></tr></table>
</body></html>`;

const SHEETS = `<html><head><meta name="generator" content="google-sheets-html-origin"></head>
<body><table><tr><td class="xl65">가짜</td></tr></table></body></html>`;

section("clipboard order: image, excel html, plain text");
{
  const png = new File([Uint8Array.from([137, 80, 78, 71])], "shot.png", {
    type: "image/png",
  });
  const imageAndHtml = classifyNoticeClipboard({
    html: EXCEL_HTML,
    plain: "구분\t수량",
    imageFiles: [png],
  });
  assert(imageAndHtml.kind === "image", "image wins when Excel HTML is also present");
  assert(
    imageAndHtml.kind === "image" && imageAndHtml.files.length === 1,
    "image and HTML are not both attached"
  );

  const emptyPng = new File([], "empty.png", { type: "image/png" });
  const htmlOnly = classifyNoticeClipboard({
    html: EXCEL_HTML,
    plain: "구분\t수량",
    imageFiles: [emptyPng],
  });
  assert(htmlOnly.kind === "excel-table", "empty image does not block Excel HTML");

  const text = classifyNoticeClipboard({ plain: "일반 공지 문장", html: "", imageFiles: [] });
  assert(text.kind === "text", "plain text stays text");
  const web = classifyNoticeClipboard({ html: WEB_TABLE, plain: "Microsoft Excel 제품 안내" });
  assert(web.kind === "text", "generic web table is not rasterized");
  const sheets = classifyNoticeClipboard({ html: SHEETS, plain: "가짜" });
  assert(sheets.kind === "text", "Google Sheets table is not treated as Excel");
  assert(isExcelClipboardHtml(EXCEL_HTML), "Excel HTML recognized");
  assert(!isExcelClipboardHtml(WEB_TABLE), "web table marker rejected");

  const headless = `<table><tr><td class=xl65 x:num="2">2</td><td>한글</td></tr></table>`;
  assert(isExcelClipboardHtml(headless), "headless Excel fragment still recognized");
  const unsupported = classifyNoticeClipboard({
    html: `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><p>no table</p></body></html>`,
  });
  assert(unsupported.kind === "unsupported", "Excel markup without a table is not a success");
  assert(
    unsupported.kind === "unsupported" && unsupported.message === NOTICE_PASTE_EXCEL_FALLBACK,
    "unsupported paste points at copy-as-picture or a screenshot"
  );

  const dup = new File([Uint8Array.from([1, 2, 3, 4])], "shot.png", {
    type: "image/png",
    lastModified: 10,
  });
  const fromItems = noticeClipboardFromData({
    getData: (type: string) => (type === "text/html" ? EXCEL_HTML : "hello"),
    items: [
      { kind: "string", type: "text/html", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => dup },
    ],
    files: [dup],
  });
  const classified = classifyNoticeClipboard(fromItems);
  assert(classified.kind === "image" && classified.files.length === 1, "items and files dedupe one image");
  assert(classified.kind === "image" && classified.files[0].type === "image/png", "png mime kept");
}

section("excel table keeps text, color, border, merge");
{
  const model = parseExcelClipboardHtml(EXCEL_HTML);
  assert(model.rows === 4 && model.cols === 3, "4x3 grid");
  assert(model.colWidths[0] === 120 && model.colWidths[1] === 96 && model.colWidths[2] === 116, "column widths");
  assert(model.rowHeights[0] === 22 && model.rowHeights[1] === 20, "row heights");
  const header = model.cells[0];
  assert(header.text === "구분", "korean header");
  assert(header.style.background === "#1f4e79", "header background");
  assert(header.style.color === "#ffffff", "header text color");
  assert(header.style.fontWeight === "700", "header bold");
  assert(header.style.textAlign === "center", "header centered");
  assert(header.style.borderLeft?.color === "#000000", "header border");
  assert(header.style.borderTop && header.style.borderTop.widthPx > 0, "hairline border kept");
  const qtyHeader = model.cells.find((cell) => cell.text === "수량");
  assert(qtyHeader?.style.borderLeft === null, "shared edge does not double the left border");
  const amount = model.cells.find((cell) => cell.text === "1,234");
  assert(amount?.style.background === "#fff2cc", "body background");
  assert(resolveExcelTextAlign(amount!.style.textAlign, amount!.text) === "right", "number aligns right");
  const note = model.cells.find((cell) => cell.text === "A-10");
  assert(resolveExcelTextAlign(note!.style.textAlign, note!.text) === "left", "mixed code stays left");
  const merged = model.cells.find((cell) => cell.text.includes("병합된 셀"));
  assert(merged?.colSpan === 2, "merged colspan");
  assert(merged?.text === "병합된 셀\n둘째 줄", "line break inside merged cell");
  assert(merged?.style.background === "#c6efce", "merged background");
  assert(merged?.style.wrap === true, "wrapped merged cell");
  const warned = model.cells.find((cell) => cell.text === "주의");
  assert(warned?.style.color === "#ff0000", "red text");
  assert(warned?.style.fontStyle === "italic", "italic text");
  assert(warned?.style.background === "#ffff00", "yellow background");
  assert(warned?.style.borderTop?.dashed === true, "dashed top border");
  const safe = model.cells.find((cell) => cell.text === "안전");
  assert(safe?.text === "안전", "script payload is not kept as cell text");
  const percent = model.cells.find((cell) => cell.text.includes("12%"));
  assert(percent?.text === "12%", "image tag dropped and percent kept");
  assert(percent?.style.background === "#fff2cc", "unsafe background url ignored");
  assert(isExcelNumericText("12%") && isExcelNumericText("1,234") && !isExcelNumericText("한글"), "numeric heuristic");
  const scale = excelTableScale(
    model.colWidths.reduce((sum, width) => sum + width, 0),
    model.rowHeights.reduce((sum, height) => sum + height, 0)
  );
  const longEdge = Math.max(...[model.colWidths, model.rowHeights].map((sizes) => sizes.reduce((a, b) => a + b, 0)));
  assert(scale >= 2 && longEdge * scale >= EXCEL_TABLE_MIN_LONG_EDGE - 80, "small table is scaled up for phone reading");
  assert(longEdge * scale <= 4096, "scaled table stays within the photo long edge");
}

section("oversized excel range is rejected");
{
  const rows = Array.from({ length: 81 }, () => "<tr><td class=xl65>행</td></tr>").join("");
  const huge = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table>${rows}</table></body></html>`;
  let message = "";
  try {
    parseExcelClipboardHtml(huge);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(message === NOTICE_PASTE_TABLE_TOO_LARGE, "too many rows explain the limit");
}

section("renderer does not fetch or inject HTML");
{
  const source = read("src/lib/noticeExcelTableImage.ts");
  assert(!source.includes("fetch("), "no fetch");
  assert(!source.includes("innerHTML"), "no innerHTML");
  assert(!source.includes("insertAdjacentHTML"), "no insertAdjacentHTML");
  assert(!source.includes("html-to-image"), "does not serialize untrusted HTML through html-to-image");
  assert(!source.includes("eval("), "no eval");
  assert(!source.includes("new Function"), "no Function constructor");
  const clip = read("src/lib/noticeClipboardPaste.ts");
  assert(clip.includes("kind: \"image\""), "image decision exists");
  assert(!clip.includes("fetch("), "classifier does not download");
}

section("composer wires paste without changing photo limits");
{
  const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
  const css = read("src/app/globals.css");
  assert(
    NOTICE_PASTE_HINT === "사진·스크린샷·엑셀 표를 Ctrl+V로 붙여넣을 수 있습니다.",
    "paste hint copy"
  );
  assert(form.includes("{NOTICE_PASTE_HINT}"), "form renders the paste hint");
  assert(form.includes("addPhotoFiles"), "paste reuses the photo picker");
  assert(form.includes("instantNoticePhotoPicks"), "instant preview path kept");
  assert(form.includes("prepareNoticePendingPhoto"), "existing prepare path kept");
  assert(form.includes('type="file"'), "file picker remains");
  assert(!form.includes("capture="), "camera capture attribute not added");
  assert(form.includes("NOTICE_PHOTO_MAX"), "max still comes from notice photos");
  assert(form.includes("noticePhotoLimitMessage"), "10-photo limit is explained");
  assert(form.includes("document.addEventListener('paste'"), "document paste listener");
  assert(form.includes("sendPush"), "push checkbox remains");
  assert(form.includes("planNoticeClientAutoPush"), "auto push plan remains");
  assert(css.includes(".notice-photo-paste-hint"), "hint style");
  assert(NOTICE_PHOTO_MAX === 10, "max is still 10");
  const schema = read("prisma/schema.prisma");
  assert(schema.includes("model NoticePhoto"), "NoticePhoto model untouched in schema file");
  assert(!read("src/lib/noticePhoto.ts").includes("excel-table"), "photo storage helper unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
