/**
 * 관리자 캐디 통합검색 / 연락처 마스킹 / tel 링크 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-caddy-search-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  caddyTelHref,
  filterCaddiesBySearch,
  matchesCaddySearch,
  matchesIdQuery,
  matchesNameQuery,
  matchesPhoneQuery,
  matchesTeamQuery,
  todayPlacementSummary,
  toCaddySearchView,
  type CaddySearchRecord,
} from "../src/lib/caddySearch";
import { maskKrMobile, normalizeKrMobile } from "../src/lib/caddyPhone";
import { rosterImportContactSummary } from "../src/lib/rosterImportContactSummary";

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
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

const kim: CaddySearchRecord = {
  id: 12,
  name: "김현정1",
  team: "7조",
  caddyType: "HOUSE",
  employmentStatus: "ACTIVE",
  phoneNormalized: "01012345678",
};
const spacedName: CaddySearchRecord = {
  id: 13,
  name: "박 서 진",
  team: "1조",
  caddyType: "HOUSE",
  employmentStatus: "ACTIVE",
  phoneNormalized: "01099990000",
};
const noPhone: CaddySearchRecord = {
  id: 14,
  name: "원다빈",
  team: "3조",
  caddyType: "THIRD",
  employmentStatus: "ACTIVE",
  phoneNormalized: null,
};
const retired: CaddySearchRecord = {
  id: 15,
  name: "이퇴사",
  team: "2조",
  caddyType: "HOUSE",
  employmentStatus: "RETIRED",
  phoneNormalized: "01088887777",
};
const tenTeam: CaddySearchRecord = {
  id: 123,
  name: "십조캐디",
  team: "10조",
  caddyType: "THIRD",
  employmentStatus: "LEAVE",
  phoneNormalized: "01011112222",
};
const roster = [kim, spacedName, noPhone, retired, tenTeam];

section("이름 검색");
{
  assert(matchesNameQuery(kim.name, "김현정"), "부분 이름");
  assert(matchesCaddySearch(kim, "김현정"), "이름 query hit");
  assert(filterCaddiesBySearch(roster, "김현정").map((c) => c.id).join() === "12", "이름 결과");
}

section("공백 이름 검색");
{
  assert(matchesCaddySearch(spacedName, "박서진"), "공백 제거 후 이름");
  assert(matchesCaddySearch(spacedName, "박 서 진"), "query 공백 무시");
  assert(matchesCaddySearch(kim, "김 현정"), "query 내부 공백");
}

section("조 검색");
{
  assert(matchesTeamQuery("7조", "7조"), "7조 exact");
  assert(matchesTeamQuery("7조", "7"), "숫자만 7조");
  assert(matchesTeamQuery("7조", " 7 조 "), "조 공백");
  assert(!matchesTeamQuery("10조", "1"), "1이 10조를 치지 않음");
  assert(matchesCaddySearch(tenTeam, "10조"), "10조");
  assert(filterCaddiesBySearch(roster, "7조")[0]?.id === 12, "7조 결과");
}

section("id 검색");
{
  assert(matchesIdQuery(123, "123"), "id string");
  assert(matchesCaddySearch(tenTeam, "123"), "id query");
  assert(!matchesIdQuery(12, "123"), "다른 id");
  assert(!matchesIdQuery(12, "7조"), "조 query로 id 오탐 없음");
}

section("phone full / last4 / 하이픈");
{
  assert(matchesPhoneQuery("01012345678", "01012345678"), "full digits");
  assert(matchesPhoneQuery("01012345678", "010-1234-5678"), "full hyphen");
  assert(matchesPhoneQuery("01012345678", "010-1234"), "hyphen prefix");
  assert(matchesPhoneQuery("01012345678", "5678"), "last4");
  assert(matchesPhoneQuery("01012345678", "1234"), "숫자 일부");
  assert(normalizeKrMobile("010-1234-5678") === "01012345678", "edit canonical dashed");
  assert(normalizeKrMobile("01012345678") === "01012345678", "edit canonical digits");
  assert(!matchesPhoneQuery(null, "5678"), "phone null no last4");
  assert(!matchesPhoneQuery("01012345678", "김현정"), "이름 query는 전화 비교 안 함");
  assert(!matchesPhoneQuery("01012345678", "7조"), "조 query는 전화 비교 안 함");
}

section("phone null / RETIRED / masking / tel");
{
  assert(matchesCaddySearch(noPhone, "원다빈"), "번호 없어도 이름 검색");
  assert(!matchesCaddySearch(noPhone, "5678"), "번호 없으면 last4 실패");
  const missing = toCaddySearchView(noPhone);
  assert(missing.phoneMissing === true, "phone missing flag");
  assert(missing.telHref === null, "phone null tel 없음");
  assert(missing.maskedPhone === null, "phone null mask 없음");

  const retiredView = toCaddySearchView(retired);
  assert(retiredView.statusLabel === "퇴사", "RETIRED 표시");
  assert(filterCaddiesBySearch(roster, "이퇴사")[0]?.employmentStatus === "RETIRED", "RETIRED 검색");

  const view = toCaddySearchView(kim);
  assert(view.maskedPhone === "010-****-5678", "masking");
  assert(maskKrMobile(kim.phoneNormalized) === "010-****-5678", "mask helper");
  assert(view.telHref === "tel:01012345678", "tel href");
  assert(caddyTelHref("01012345678") === "tel:01012345678", "tel helper");
  assert(caddyTelHref(null) === null, "no tel for null");
  assert(caddyTelHref("010-1234-5678") === null, "비정규화 번호는 tel 안 만듦");
  assert(view.maskedPhone !== kim.phoneNormalized, "UI mask != raw");
  assert(!JSON.stringify({ ...view, telHref: null }).includes("01012345678"), "view 본문에 raw phone 없음");
}

section("오늘 배치 요약 (기존 published payload 재사용)");
{
  const summary = todayPlacementSummary(
    [
      { caddyId: 12, shift: "ONE", teeTime: "06:32", course: "오션" },
      { caddyId: 12, shift: "TWO", teeTime: "12:11", course: "레이크" },
      { caddyId: 14, shift: "ONE", teeTime: "07:00", course: "오션" },
    ],
    12
  );
  assert(summary?.includes("1부 06:32 오션") === true, "1부 표시");
  assert(summary?.includes("2부 12:11 레이크") === true, "2부 묶음");
  assert(todayPlacementSummary([], 12) === null, "배치 없음");
}

section("import contact preview 파생");
{
  const summary = rosterImportContactSummary({
    summary: { inputPeople: 4, update: 2, create: 1, unchanged: 0 },
    lines: [
      { action: "update", nextMaskedPhone: "010-****-1111" },
      { action: "update", nextMaskedPhone: "010-****-2222" },
      { action: "create", nextMaskedPhone: null },
      { action: "needsReview", reason: "동명이인 2명", nextMaskedPhone: "010-****-3333" },
      { action: "missingInImport", nextMaskedPhone: null },
    ],
    needsReview: [{ reason: "동명이인 2명(id: 1, 2) — 자동 매칭 불가" }],
    phoneIssues: [
      { kind: "invalid" },
      { kind: "duplicate_in_file" },
      { kind: "duplicate_in_db" },
    ],
  });
  assert(summary.total === 4, "총 N명");
  assert(summary.withPhone === 3, "전화번호 있음");
  assert(summary.matched === 2, "기존 매칭");
  assert(summary.unmatched === 1, "미매칭");
  assert(summary.homonyms === 1, "동명이인");
  assert(summary.phoneInvalid === 1, "형식 오류");
  assert(summary.phoneDuplicate === 2, "중복 전화번호");
}

section("검색 UI / 권한 / 개인정보 source guard");
{
  const page = readSrc("src/app/manage/caddy-search/page.tsx");
  const matcher = readSrc("src/lib/caddySearch.ts");
  const shell = readSrc("src/components/manage/ManageShell.tsx");
  const layout = readSrc("src/app/manage/layout.tsx");
  const mw = readSrc("src/middleware.ts");
  const listApi = readSrc("src/app/api/caddies/route.ts");
  const patchApi = readSrc("src/app/api/caddies/[id]/route.ts");
  const importV2 = readSrc("lib/caddyRosterImportV2.ts");
  const caddiesPage = readSrc("src/app/manage/caddies/page.tsx");
  const schema = readSrc("prisma/schema.prisma");
  const publishedView = readSrc("src/components/board/PublishedBoardView.tsx");
  const published = readSrc("src/lib/dailyBoardPublished.ts");
  const boardPage = readSrc("src/app/board/page.tsx");
  const pkg = readSrc("package.json");

  assert(/\/api\/caddies\?employment=all/.test(page), "GET /api/caddies 재사용");
  assert(/toCaddySearchView/.test(page) && /caddyTelHref/.test(matcher), "view/tel helper");
  assert(/연락처 등록 필요/.test(page), "phone 없는 UX");
  assert(/view\.telHref/.test(page), "tel은 view href만");
  assert(!/console\.(log|info|debug|warn)\([^)]*phone/i.test(page), "검색 페이지 phone console 없음");
  assert(!/console\.(log|info|debug|warn)\([^)]*phone/i.test(matcher), "matcher phone console 없음");
  assert(/href: "\/manage\/caddy-search"/.test(shell), "nav 캐디 검색");
  assert(/auth\.role !== "admin"/.test(layout), "layout admin only");
  assert(/pathname\.startsWith\("\/manage"\)/.test(mw) && /role !== "admin"/.test(mw), "middleware admin");
  assert(/requireAdmin/.test(listApi), "caddies GET requireAdmin");
  assert(/parseOptionalPhoneInput/.test(patchApi) && /maskKrMobile/.test(patchApi), "기존 phone edit 재사용");
  assert(
    /\["phone", "휴대폰", "전화번호", "mobile"\]/.test(importV2),
    "import 전화 컬럼 유지"
  );
  assert(/rosterImportContactSummary/.test(caddiesPage), "import preview 연락처 요약");
  assert(/전화번호 있음/.test(caddiesPage) && /동명이인/.test(caddiesPage), "import preview 문구");
  assert(!/vehicleNumber/.test(schema), "vehicleNumber schema 없음");
  assert(!/model NotificationSend/.test(schema) && !/model AlimTalkSend/.test(schema), "알림톡 모델 없음");
  assert(!/phoneNormalized/.test(publishedView), "published view 전화 없음");
  assert(!/phoneNormalized/.test(published), "published payload 전화 없음");
  assert(!/phoneNormalized/.test(boardPage), "/board 전화 없음");
  assert(!/"solapi"|"aligo"|"nhn-toast"|alimtalk/i.test(pkg), "알림톡 SDK 없음");
  assert(/href=\{\`\/manage\/caddies\?id=\$\{view\.id\}\`\}/.test(page), "상세는 캐디 관리");
  assert(/aria-disabled="true"/.test(page), "전화 없음 버튼 disabled");
}

section("empty query returns no dump");
{
  assert(filterCaddiesBySearch(roster, "").length === 0, "빈 검색 전체 덤프 안 함");
  assert(filterCaddiesBySearch(roster, "   ").length === 0, "공백 query 덤프 안 함");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
