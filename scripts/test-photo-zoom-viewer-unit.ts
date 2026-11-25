/**
 * 공지·가배치표·자유게시판 공용 사진 확대 뷰어 단위 테스트 (DB 불필요).
 *   npm run test:photo-zoom-viewer-unit
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PHOTO_ZOOM_ABSOLUTE_MAX_SCALE,
  PHOTO_ZOOM_DOUBLE_TAP_SCALE,
  PHOTO_ZOOM_HISTORY_KEY,
  PHOTO_ZOOM_MIN_MAX_SCALE,
  clampPhotoZoom,
  clampPhotoZoomPan,
  clampPhotoZoomScale,
  doubleTapPhotoZoom,
  isPhotoZoomHistoryState,
  isPhotoZoomed,
  panPhotoZoom,
  photoZoomDistance,
  photoZoomMaxScale,
  photoZoomMidpoint,
  photoZoomPointInStage,
  photoZoomTransformCss,
  pinchPhotoZoom,
  resetPhotoZoom,
  shouldBlockPhotoZoomBackdropClose,
  zoomPhotoAt,
  type PhotoZoomBox,
} from "../src/lib/photoZoomViewer";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// 세로 390×780 화면에 가로로 긴 배치표(4096×2048)가 화면 폭에 맞춰 374×187 로 놓인 상황.
const wide: PhotoZoomBox = { viewWidth: 390, viewHeight: 780, baseWidth: 374, baseHeight: 187 };
// 세로로 긴 캡처(1080×4000)가 높이에 맞춰 놓인 상황.
const tall: PhotoZoomBox = { viewWidth: 390, viewHeight: 780, baseWidth: 206, baseHeight: 764 };

section("max scale: about 10x, based on original resolution");
{
  const big = photoZoomMaxScale({ naturalWidth: 4096, naturalHeight: 2048, baseWidth: 374, baseHeight: 187 });
  assert(big === PHOTO_ZOOM_ABSOLUTE_MAX_SCALE && big === 10, "4096px 배치표는 최대 10배");
  const mid = photoZoomMaxScale({ naturalWidth: 1080, naturalHeight: 720, baseWidth: 374, baseHeight: 249 });
  assert(near(mid, Math.max(1080 / 374, 720 / 249) * 2), "1080px 사진은 원본 픽셀 2배까지 (약 5.8배)");
  const small = photoZoomMaxScale({ naturalWidth: 300, naturalHeight: 200, baseWidth: 300, baseHeight: 200 });
  assert(small === PHOTO_ZOOM_MIN_MAX_SCALE, "작은 사진도 최소 2배");
  assert(photoZoomMaxScale({ naturalWidth: 0, naturalHeight: 0, baseWidth: 0, baseHeight: 0 }) === 2, "크기 모르면 2배");
  assert(photoZoomMaxScale({ naturalWidth: NaN, naturalHeight: 1, baseWidth: 1, baseHeight: 1 }) === 2, "NaN 안전");
  assert(clampPhotoZoomScale(50, 999) === 10, "어떤 경우에도 10배 넘지 않음");
  assert(clampPhotoZoomScale(0.2, 10) === 1, "1배보다 작아지지 않음 (화면 맞춤이 최소)");
  assert(clampPhotoZoomScale(Number.NaN, 10) === 1, "NaN 배율은 1배");
}

section("pan clamp: image never leaves the screen");
{
  assert(JSON.stringify(clampPhotoZoomPan(500, 500, 1, wide)) === JSON.stringify({ x: 0, y: 0 }), "1배에서는 이동 없음");
  const p = clampPhotoZoomPan(10_000, 10_000, 4, wide);
  assert(near(p.x, (374 * 4 - 390) / 2), "가로: 사진 끝이 화면 끝까지만");
  assert(near(p.y, 0), "세로: 확대해도 화면보다 작으면 가운데 고정");
  const q = clampPhotoZoomPan(-10_000, -10_000, 10, wide);
  assert(near(q.x, -(3740 - 390) / 2) && near(q.y, -(1870 - 780) / 2), "반대 방향도 제한");
  const t = clampPhotoZoomPan(10_000, 0, 1.5, tall);
  assert(near(t.x, 0), "세로 캡처 1.5배: 가로가 화면보다 작아 가운데 고정");
  const back = clampPhotoZoom({ scale: 1, x: 99, y: 99 }, wide, 10);
  assert(back.scale === 1 && back.x === 0 && back.y === 0, "1배로 돌아오면 가운데로 복귀");
}

section("pinch anchored at fingers");
{
  const start = { transform: resetPhotoZoom(), distance: 100, midpoint: { x: 100, y: 0 } };
  const z = pinchPhotoZoom(start, 300, { x: 100, y: 0 }, wide, 10);
  assert(near(z.scale, 3), "손가락 간격 3배 → 3배 확대");
  // 시작할 때 손가락 아래 있던 사진 지점(x=100)이 그대로 손가락 아래에 있음
  assert(near((100 - z.x) / z.scale, 100 / 1), "손가락 아래 지점 고정 (가로)");
  const capped = pinchPhotoZoom(start, 100_000, { x: 0, y: 0 }, wide, 10);
  assert(capped.scale === 10, "아무리 벌려도 최대 10배");
  const zoomOut = pinchPhotoZoom({ transform: { scale: 3, x: 50, y: 0 }, distance: 300, midpoint: { x: 0, y: 0 } }, 10, { x: 0, y: 0 }, wide, 10);
  assert(zoomOut.scale === 1 && zoomOut.x === 0, "오므리면 화면 맞춤으로 복귀");
  const moved = pinchPhotoZoom(start, 200, { x: 140, y: 0 }, wide, 10);
  assert(moved.x > pinchPhotoZoom(start, 200, { x: 100, y: 0 }, wide, 10).x, "두 손가락을 움직이면 같이 이동");
  const bad = pinchPhotoZoom({ ...start, distance: 0 }, 200, { x: 0, y: 0 }, wide, 10);
  assert(bad.scale === 1, "시작 간격 0 이면 안전하게 유지");
  assert(near(photoZoomDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5), "손가락 거리");
  const m = photoZoomMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 });
  assert(m.x === 5 && m.y === 10, "손가락 가운데");
}

section("zoom at focal / pan / double tap");
{
  const z = zoomPhotoAt(resetPhotoZoom(), 2, { x: 50, y: 0 }, wide, 10);
  assert(near(z.scale, 2) && near(z.x, -50), "기준점 확대");
  const panned = panPhotoZoom({ scale: 3, x: 0, y: 0 }, 40, -10, wide, 10);
  assert(near(panned.x, 40) && near(panned.y, 0), "확대 상태에서 손가락 이동 (세로는 범위 밖이라 0)");
  const noPan = panPhotoZoom(resetPhotoZoom(), 40, 40, wide, 10);
  assert(noPan.x === 0 && noPan.y === 0, "1배에서는 이동 안 함");
  const dt = doubleTapPhotoZoom(resetPhotoZoom(), { x: 0, y: 0 }, wide, 10);
  assert(near(dt.scale, PHOTO_ZOOM_DOUBLE_TAP_SCALE), "두 번 탭 → 2.5배");
  const dtBack = doubleTapPhotoZoom(dt, { x: 0, y: 0 }, wide, 10);
  assert(dtBack.scale === 1 && dtBack.x === 0, "다시 두 번 탭 → 원래대로");
  const dtSmall = doubleTapPhotoZoom(resetPhotoZoom(), { x: 0, y: 0 }, wide, 2);
  assert(near(dtSmall.scale, 2), "최대가 2배면 두 번 탭도 2배까지");
  assert(isPhotoZoomed({ scale: 1.5, x: 0, y: 0 }) && !isPhotoZoomed(resetPhotoZoom()), "확대 여부");
  assert(photoZoomTransformCss({ scale: 2, x: 8, y: -4 }) === "translate(8px, -4px) scale(2)", "CSS transform");
  const pt = photoZoomPointInStage({ clientX: 200, clientY: 400 }, { left: 0, top: 0, width: 400, height: 800 });
  assert(pt.x === 0 && pt.y === 0, "화면 가운데 = (0,0)");
}

section("no accidental close while zoomed");
{
  assert(shouldBlockPhotoZoomBackdropClose({ zoomed: true, interacting: false, recentGesture: false }), "확대 중 바깥 탭으로 안 닫힘");
  assert(shouldBlockPhotoZoomBackdropClose({ zoomed: false, interacting: true, recentGesture: false }), "손가락 동작 중 안 닫힘");
  assert(shouldBlockPhotoZoomBackdropClose({ zoomed: false, interacting: false, recentGesture: true }), "방금 동작 직후 안 닫힘");
  assert(!shouldBlockPhotoZoomBackdropClose({ zoomed: false, interacting: false, recentGesture: false }), "기본 상태 바깥 탭은 닫힘");
}

section("history marker for back = close viewer only");
{
  assert(isPhotoZoomHistoryState({ [PHOTO_ZOOM_HISTORY_KEY]: "t1", __NA: true }, "t1"), "내 항목 인식");
  assert(!isPhotoZoomHistoryState({ [PHOTO_ZOOM_HISTORY_KEY]: "t2" }, "t1"), "다른 뷰어 항목 아님");
  assert(!isPhotoZoomHistoryState(null, "t1") && !isPhotoZoomHistoryState("x", "t1"), "빈 state 안전");
}

section("viewer component wiring");
{
  const v = read("src/components/photo/PhotoZoomViewer.tsx");
  assert(v.startsWith('"use client"'), "client component");
  assert(v.includes("pinchPhotoZoom") && v.includes("doubleTapPhotoZoom") && v.includes("panPhotoZoom"), "pinch + pan + double tap");
  assert(v.includes("vh-photo-zoom-close") && v.includes("닫기"), "닫기 버튼");
  assert(v.includes('passive: false') && v.includes("preventDefault"), "브라우저 확대·스크롤 대신 직접 처리");
  assert(v.includes("history.pushState") && v.includes("popstate") && v.includes("history.back()"), "뒤로 가기 = 뷰어만 닫기");
  assert(!/pushState\([^)]*,\s*""\s*,/.test(v), "주소(URL)는 바꾸지 않음");
  assert(v.includes('style.overflow = "hidden"') && v.includes("prevBody"), "열린 동안만 뒤 화면 스크롤 잠금, 닫으면 복원");
  assert(!v.includes("scrollTo("), "스크롤 위치를 건드리지 않음");
  assert(!v.includes('addEventListener("wheel"') && !v.includes("onWheel"), "PC 마우스 휠 확대 없음 (이번 범위 제외)");
  assert(!/target="_blank"|window\.open/.test(v), "뷰어는 새 창을 열지 않음");
  assert(v.includes("photoZoomMaxScale") && v.includes("naturalWidth"), "원본 해상도 기준 최대 배율");
  assert(!/from\s+"(react-zoom|react-image|swiper|panzoom|@use-gesture|hammerjs)/.test(v), "외부 라이브러리 없음");
}

section("applied to exactly 3 screens");
{
  const notice = read("src/components/notice/NoticePhotoGallery.tsx");
  const sheets = read("src/app/community/FreeBoardPhotoGallery.tsx");
  const talk = read("src/app/talk/[id]/TalkPhotoGallery.tsx");
  for (const [name, src] of [
    ["공지", notice],
    ["가배치표", sheets],
    ["자유게시판", talk],
  ] as const) {
    assert(src.includes("<PhotoZoomViewer"), `${name}: 확대 뷰어 사용`);
    assert(src.includes('type="button"') && src.includes("setOpenId(photo.id)"), `${name}: 사진 탭 → 뷰어 열기`);
    assert(src.includes("onClose={() => setOpenId(null)}"), `${name}: 닫기`);
  }
  for (const [name, src] of [
    ["가배치표", sheets],
    ["자유게시판", talk],
  ] as const) {
    const blankCount = (src.match(/target="_blank"/g) || []).length;
    assert(blankCount === 1 && src.includes("원본 보기"), `${name}: 새 창은 '원본 보기' 링크 하나뿐`);
    assert(!/<a[^>]*className="(free-board-sheet-link|talk-photo)"/.test(src), `${name}: 사진 자체는 링크가 아님`);
  }
  assert(sheets.includes("freeBoardPhotoSrc(postId, open.id)"), "가배치표: 같은 원본 주소");
  assert(talk.includes("communityPhotoSrc(postId, open.id)"), "자유게시판: 같은 원본 주소");
  assert(notice.includes("noticePhotoSrc(noticeId, open.id)"), "공지: 같은 원본 주소");
}

section("out of scope stays unchanged");
{
  const chatLb = read("src/components/chat/ChatPhotoLightbox.tsx");
  assert(!chatLb.includes("PhotoZoomViewer") && chatLb.includes("chatPhotoLightboxZoom"), "채팅 뷰어 그대로");
  const report = read("src/app/course-reports/CourseReportPhotoGallery.tsx");
  assert(!report.includes("PhotoZoomViewer") && report.includes("course-report-photo-lightbox"), "코스제보 그대로");
  const floating = read("src/components/chat/FloatingChat.tsx");
  assert(!floating.includes("PhotoZoomViewer"), "떠 있는 채팅창 그대로");
  const files = read("src/components/notice/NoticeFileList.tsx");
  assert(files.includes("downloadNoticeFile") && files.includes("openNoticeFile") && !files.includes("PhotoZoomViewer"), "첨부파일 열기·다운로드 그대로");
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  assert(!deps.some((d) => /zoom|lightbox|gesture|hammer|panzoom|swiper/i.test(d)), "새 외부 패키지 없음");
  const cap = read("capacitor.config.ts");
  assert(!cap.includes("zoomEnabled"), "Android 앱 설정(zoomEnabled) 변경 없음");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-chat-lightbox {") && css.includes(".course-report-photo-lightbox {"), "채팅·코스제보 CSS 그대로");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
