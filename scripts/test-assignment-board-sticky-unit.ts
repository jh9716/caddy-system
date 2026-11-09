/**
 * 자동배치표 모바일 sticky 헤더 가드 (엔진/DB 없음)
 * 실행: npm run test:assignment-board-sticky-unit
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const page = src("src/app/manage/assignments/page.tsx");
const engine = src("src/lib/autoAssignEngine.ts");
const engineFingerprint = engine.length;

section("컬럼 헤더만 배치표 범위 sticky");
{
  const stackCss = page.split(".ops-sticky-stack {")[1]?.split("}")[0] || "";
  assert(!/position:\s*sticky/.test(stackCss), "부 탭 스택은 sticky 아님");
  assert(/position:\s*relative/.test(stackCss), "부 탭 스택은 문서 흐름");
  assert(page.includes('data-ops-board-scope="1"'), "배치표 scope 래퍼");
  assert(page.includes('data-ops-board-head="1"'), "컬럼 헤더 마커");
  const headBarCss = page.split(".ops-board-head-bar {")[1]?.split("}")[0] || "";
  assert(/position:\s*sticky/.test(headBarCss), "컬럼 헤더만 sticky");
  assert(/--ops-board-sticky-top/.test(headBarCss), "앱 바 높이 변수");
  assert(page.includes("useOpsBoardMobileBarOffset"), "모바일 바 높이 측정");
  assert(
    page.indexOf('data-ops-board-scope="1"') < page.indexOf('data-ops-board-head="1"') &&
      page.indexOf('data-ops-board-head="1"') < page.indexOf("ref={boardWrapRef}"),
    "헤더가 scope 안·행 래퍼보다 앞에 있어 첫 행을 덮지 않음"
  );
}

section("내부 이중 스크롤 금지 / 기존 기능 유지");
{
  const wrapCss = page.split(".ops-board-wrap {")[1]?.split("}")[0] || "";
  assert(!/overflow-y:\s*auto/.test(wrapCss), "배치표 wrap 세로 스크롤 없음");
  assert(/overflow-y:\s*visible/.test(wrapCss), "세로 overflow visible");
  assert(page.includes("엑셀편집"), "엑셀편집 유지");
  assert(page.includes("LazyBoardImageExportMenu"), "이미지 저장 유지");
  assert(page.includes("LazyBoardExcelExportButton"), "엑셀 저장 유지");
  assert(page.includes("data-cell-edit-toggle"), "엑셀편집 토글 유지");
  assert(page.includes("ops-spares-all"), "스페어 현황 유지");
  assert(page.includes("data-ops-publish"), "운영 반영 구간");
  assert(src("src/lib/autoAssignEngine.ts").length === engineFingerprint, "엔진 파일 불변");
}

section("1·2·3부 전환 스크롤은 탭으로");
{
  assert(
    /stickyStackRef\.current\?\.scrollIntoView/.test(page),
    "부 전환 시 탭 스택으로 스크롤"
  );
  assert(!/boardWrapRef\.current\?\.scrollIntoView/.test(page), "부 전환이 wrap 내부 스크롤이 아님");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
