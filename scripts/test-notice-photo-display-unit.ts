/**
 * Notice detail photos must show the full original, no crop.
 * Native aspect, full width. No fake 4/3 box. List has no image thumbs.
 * 실행: npm run test:notice-photo-display-unit
 */
import fs from "node:fs";
import path from "node:path";

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

function sliceCss(css: string, startNeedle: string, endNeedle: string) {
  const start = css.indexOf(startNeedle);
  const end = css.indexOf(endNeedle, start + 1);
  return start >= 0 && end > start ? css.slice(start, end) : "";
}

section("detail gallery is uncropped");
{
  const gallery = read("src/components/notice/NoticePhotoGallery.tsx");
  const css = read("src/app/globals.css");
  const noticeCss = sliceCss(css, ".notice-photos {", ".notice-back {");
  assert(gallery.includes("notice-photos-list"), "stacked list");
  assert(gallery.includes("notice-photos-item"), "full-width item");
  assert(gallery.includes("notice-photos-lightbox"), "notice lightbox");
  assert(gallery.includes("RevealedPhoto"), "uses decode-then-reveal img");
  assert(!gallery.includes("course-report-photo-"), "does not reuse report crop classes");
  assert(!gallery.includes('object-fit: "cover"'), "component has no cover");
  assert(noticeCss.includes("width: 100%"), "item/img width 100%");
  assert(/\.notice-photos-item img\s*\{[^}]*height:\s*auto/.test(noticeCss), "img height auto");
  assert(/\.notice-photos-item img\s*\{[^}]*object-fit:\s*contain/.test(noticeCss), "img contain");
  assert(!/\.notice-photos-item\s*\{[^}]*aspect-ratio:/.test(noticeCss), "no fake reserved ratio");
  assert(!noticeCss.includes("object-fit: cover"), "no cover crop");
  assert(!noticeCss.includes("max-height:") || noticeCss.includes(".notice-photos-lightbox"), "detail list has no max-height crop");
}

section("lightbox contain, no new viewer");
{
  const gallery = read("src/components/notice/NoticePhotoGallery.tsx");
  const css = read("src/app/globals.css");
  const noticeCss = sliceCss(css, ".notice-photos {", ".notice-back {");
  assert(gallery.includes("setOpenId"), "keeps existing click-to-open lightbox");
  assert(!gallery.includes("react-image-lightbox"), "no new viewer lib");
  assert(/\.notice-photos-lightbox img\s*\{[^}]*object-fit:\s*contain/.test(noticeCss), "lightbox contain");
  assert(/\.notice-photos-lightbox img\s*\{[^}]*max-height:\s*90vh/.test(noticeCss), "lightbox fits screen");
  assert(/\.notice-photos-lightbox img\s*\{[^}]*width:\s*auto/.test(noticeCss), "lightbox width auto");
  assert(/\.notice-photos-lightbox img\s*\{[^}]*height:\s*auto/.test(noticeCss), "lightbox height auto");
}

section("list and report thumbs unchanged");
{
  const list = read("src/app/notice/page.tsx");
  const css = read("src/app/globals.css");
  assert(!list.includes("<img"), "notice list has no photo thumbs");
  assert(list.includes("notice-badge-photo"), "notice list still uses photo count badge");
  const report = sliceCss(css, ".course-report-photo-thumb,", ".course-report-photo-composer");
  assert(report.includes("aspect-ratio: 1"), "report thumb still square");
  assert(report.includes("object-fit: cover"), "report thumb still cover");
}

section("reveal hides baseline scan");
{
  const reveal = read("src/components/photo/RevealedPhoto.tsx");
  const css = read("src/app/globals.css");
  const noticeCss = sliceCss(css, ".notice-photos {", ".notice-back {");
  assert(reveal.includes("img.decode"), "waits for decode()");
  assert(reveal.includes("onLoad"), "onLoad fallback");
  assert(reveal.includes("is-revealed"), "revealed class");
  assert(/\.notice-photos-item img\s*\{[^}]*opacity:\s*0/.test(noticeCss), "hidden until reveal");
  assert(noticeCss.includes("img.is-revealed"), "revealed opacity");
  assert(!noticeCss.toLowerCase().includes("shimmer"), "no shimmer");
  assert(!noticeCss.toLowerCase().includes("blur("), "no blur animation");
}

section("first image priority");
{
  const notice = read("src/components/notice/NoticePhotoGallery.tsx");
  const report = read("src/app/course-reports/CourseReportPhotoGallery.tsx");
  assert(notice.includes('fetchPriority={index === 0 ? "high" : "auto"}'), "notice first high");
  assert(notice.includes('loading={index === 0 ? "eager" : "lazy"}'), "notice rest lazy");
  assert(report.includes('fetchPriority={index === 0 ? "high" : "auto"}'), "report first high");
  assert(report.includes('loading={index === 0 ? "eager" : "lazy"}'), "report rest lazy");
  assert(!notice.includes('fetchPriority="high"'), "notice does not mark every img high");
  assert(!report.includes('fetchPriority="high"'), "report does not mark every img high");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
