/**
 * 관리 도구 펼침/접힘 + 특수 설정 재배치 진입 회귀
 * 실행: npx tsx scripts/test-admin-tools-unit.ts
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

function section(title: string) {
  console.log("\n==", title, "==");
}

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const panel = readSrc("src/app/manage/assignments/LiveChangePanel.tsx");
const page = readSrc("src/app/manage/assignments/page.tsx");
const dutyPanel = readSrc("src/app/manage/assignments/SpecialDutyPanel.tsx");
const supportPanel = readSrc(
  "src/app/manage/assignments/SpecialSupportPanel.tsx"
);
const dutyLib = readSrc("src/lib/dailySpecialDuty.ts");

const details = panel.split('className="admin-tools-details"')[1] || "";
const summary = details.split("<summary")[1]?.split("</summary>")[0] || "";
const body =
  details.split("<div className=\"admin-tools-body\">")[1]?.split("</details>")[0] ||
  "";
const css = page.split("const opsCss = `")[1]?.split("`;")[0] || "";
const adminCss = css.split(".admin-tools {")[1]?.split(".live-preview {")[0] || "";
const desktopCss =
  adminCss.split("@media (min-width: 960px)")[1]?.split(".admin-tools-body")[0] ||
  adminCss.split("@media (min-width: 960px)")[1] ||
  "";

section("mobile 관리 도구 open/close");
{
  assert(/className="admin-tools-details"/.test(panel), "native details");
  assert(/onClick=\{\(e\) => \{/.test(summary), "summary 클릭이 details.open을 직접 토글");
  assert(/details\.open = !details\.open/.test(panel), "native open 토글 백업");
  assert(/관리 도구/.test(summary), "summary 라벨");
  assert(!/adminToolsOpen &&/.test(panel), "본문을 React 조건부 렌더로 숨기지 않음");
  assert(!/aria-expanded=\{adminToolsOpen\}/.test(panel), "React open state 제거");
  assert(/min-height:\s*44px/.test(adminCss), "모바일 토글 44px 히트영역");
  assert(
    !/\.admin-tools-toggle\s*\{[^}]*display:\s*flex/.test(adminCss),
    "summary에 display:flex 없음 (iOS details 토글 버그 회피)"
  );
  assert(
    /\.admin-tools-toggle-row\s*\{[^}]*display:\s*flex/.test(adminCss),
    "화살표 정렬은 inner row에서만 flex"
  );
  assert(
    !/\.admin-tools-body\s*\{[^}]*display:\s*none/.test(adminCss),
    "본문이 CSS로 항상 hidden 아님"
  );
  assert(
    /z-index:\s*6/.test(adminCss) &&
      !/\.admin-tools[\s\S]{0,400}pointer-events:\s*none/.test(
        adminCss.split(".admin-tools-toggle-row")[0] || adminCss
      ),
    "토글 컨테이너가 overlay에 막히지 않게 z-index, pointer-events 유지"
  );
  assert(
    /safe-area-inset-bottom/.test(adminCss),
    "하단 탭/home indicator와 겹치지 않게 safe-area 여백"
  );
}

section("desktop 관리 도구 open/close");
{
  assert(
    /@media \(min-width: 960px\) \{\s*\.admin-tools \{[\s\S]*?min-height:\s*44px/.test(
      css
    ),
    "desktop도 동일하게 44px summary"
  );
  const globalCss = readSrc("src/app/globals.css");
  assert(
    /\.vh-mobile-bar,\s*\n\s*\.vh-bottom-tabs,[\s\S]{0,60}display:\s*none\s*!important/.test(
      globalCss
    ),
    "desktop에서 하단 탭은 숨김 — 클릭이 탭에 먹히지 않음"
  );
}

section("배치 다시 맞추기 실행");
{
  assert(/배치 다시 맞추기/.test(body), "관리 도구 본문에 재배치");
  assert(/onClick=\{onReflow\}/.test(body), "재배치는 onReflow");
  assert(
    /onRecalcOrder=\{\(\) => void runAutoAssign\(\)\}/.test(page),
    "페이지가 기존 자동배치 실행에 연결"
  );
  assert(
    /function onReflow\(/.test(panel) &&
      /if \(onRecalcOrder\) \{\s*onRecalcOrder\(\);/.test(panel),
    "onReflow가 runAutoAssign을 호출"
  );
}

section("작업본 초기화");
{
  assert(/작업본 초기화/.test(body), "관리 도구 본문에 초기화");
  assert(/onResetDraft\(\)/.test(body), "초기화 핸들러 연결");
  assert(
    /onResetDraft=\{\(\) => void resetStoredDraft\(\)\}/.test(page),
    "페이지 resetStoredDraft 연결"
  );
  assert(
    /이미 적용된 예약·배치는 남습니다/.test(body),
    "초기화 의미가 기존과 같음"
  );
}

section("특수 설정 변경 안내/재배치 진입");
{
  assert(
    /SPECIAL_SETTINGS_STALE_MESSAGE/.test(dutyLib) &&
      /특수 설정이 변경되었습니다\. 현재 작업본에 반영하려면 배치를 다시 맞춰 주세요\./.test(
        dutyLib
      ),
    "안내 문구"
  );
  assert(/ops-special-stale/.test(page), "배치표 상단 안내 영역");
  assert(
    /specialSettingsStale \? \(/.test(page) &&
      /SPECIAL_SETTINGS_STALE_MESSAGE/.test(page) &&
      /onClick=\{\(\) => void runAutoAssign\(\)\}/.test(
        page.split("ops-special-stale")[1] || ""
      ),
    "안내에 배치 다시 맞추기 버튼"
  );
  const dutyChanged = page.split("SpecialDutyPanel")[2] || page;
  assert(
    /onChanged=\{\(\) => \{[\s\S]*setSpecialSettingsStale\(true\)/.test(page),
    "특수근무/지원 저장 시 안내만 켬"
  );
  assert(/onChanged\?\.\(\)/.test(dutyPanel), "특수근무 저장이 부모에 알림");
  assert(/onChanged\?\.\(\)/.test(supportPanel), "특수지원 저장이 부모에 알림");
  assert(
    /if \(hasDraft\) \{[\s\S]*onChanged\?\.\(\)/.test(supportPanel),
    "특수지원도 Draft가 있을 때만 상단 안내"
  );
  const onChangedBlocks = [...page.matchAll(/onChanged=\{\(\) => \{([\s\S]*?)\}\}/g)].map(
    (m) => m[1]
  );
  assert(
    onChangedBlocks.length >= 2 &&
      onChangedBlocks.every((block) => !/runAutoAssign/.test(block)),
    "설정 변경 시 Draft를 자동 재계산하지 않음"
  );
  assert(
    /setSpecialSettingsStale\(false\)/.test(page.split("queueDraftSave(next, true)")[1] || page),
    "재배치 성공 후 안내 해제"
  );
  assert(
    /availability\?\.available\?\.all\?\.length/.test(page) &&
      /draft\?\.caddyPool/.test(page.split("houseStartCandidates")[1] || ""),
    "Draft가 있으면 가용 로드 전에도 1부 첫 캐디를 고를 수 있음"
  );
}

console.log(`\nOK ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
