/**
 * 관리자 캐디 통합검색 / 연락처 마스킹 / tel 링크 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-caddy-search-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  CADDY_SEARCH_API_KEYS,
  CADDY_SEARCH_DEBOUNCE_MS,
  CADDY_SEARCH_LIMIT,
  CADDY_SEARCH_RANK,
  caddySearchApiResponse,
  caddyTelHref,
  filterCaddiesBySearch,
  matchesCaddySearch,
  matchesIdQuery,
  matchesNameQuery,
  matchesPhoneQuery,
  matchesTeamQuery,
  rankCaddySearchHit,
  searchCaddiesLimited,
  todayPlacementSummary,
  toCaddySearchApiHit,
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
  teamOrder: 1,
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
  assert(!matchesTeamQuery("7조", "조"), "단독 '조'는 팀 includes 오탐 없음");
  assert(!matchesTeamQuery("1조", "조"), "단독 '조'는 1조를 치지 않음");
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
  const searchApi = readSrc("src/app/api/caddies/search/route.ts");
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
  const snapshot = readSrc("src/lib/dailyOpsSnapshot.ts");
  const boardPage = readSrc("src/app/board/page.tsx");
  const pkg = readSrc("package.json");

  assert(!/\/api\/caddies\?employment=all/.test(page), "검색 페이지 전체 roster GET 제거");
  assert(!/filterCaddiesBySearch/.test(page), "클라이언트 전체 filter 제거");
  assert(/\/api\/caddies\/search\?q=/.test(page), "GET /api/caddies/search 사용");
  assert(/CADDY_SEARCH_DEBOUNCE_MS/.test(page), "debounce 적용");
  assert(CADDY_SEARCH_DEBOUNCE_MS === 300, "debounce 300ms");
  assert(/검색 중/.test(page), "검색 중 loading");
  assert(/연락처 등록 필요/.test(page), "phone 없는 UX");
  assert(/tel:\$\{hit\.telPhone\}/.test(page), "tel href는 검색 hit telPhone만");
  assert(!/\{hit\.telPhone\}/.test(page.replace(/tel:\$\{hit\.telPhone\}/g, "")), "raw telPhone 화면 텍스트 없음");
  assert(/hit\.maskedPhone/.test(page), "화면은 maskedPhone");
  assert(!/console\.(log|info|debug|warn)\([^)]*phone/i.test(page), "검색 페이지 phone console 없음");
  assert(!/console\.(log|info|debug|warn)\([^)]*phone/i.test(matcher), "matcher phone console 없음");
  assert(/href: "\/manage\/caddy-search"/.test(shell), "nav 캐디 검색");
  assert(/auth\.role !== "admin"/.test(layout), "layout admin only");
  assert(/pathname\.startsWith\("\/manage"\)/.test(mw) && /role !== "admin"/.test(mw), "middleware admin");
  assert(/requireAdmin/.test(listApi), "caddies GET requireAdmin 유지");
  assert(/requireAdmin/.test(searchApi), "search GET requireAdmin");
  assert(
    searchApi.indexOf("requireAdmin") < searchApi.indexOf("prisma.caddy.findMany"),
    "search admin gate before DB"
  );
  assert(/select: SEARCH_SELECT/.test(searchApi), "prisma select 최소화");
  assert(/phoneNormalized: true/.test(searchApi), "phone은 서버 select만");
  assert(!/NextResponse\.json\(\s*(caddies|rows)\s*\)/.test(searchApi), "raw prisma rows 응답 금지");
  assert(/results: \[\]/.test(searchApi), "빈 q는 빈 results");
  assert(/export async function GET/.test(searchApi), "GET only");
  assert(!/export async function POST/.test(searchApi), "search POST 없음");
  assert(/parseOptionalPhoneInput/.test(patchApi) && /maskKrMobile/.test(patchApi), "기존 phone edit 재사용");
  assert(
    /\["phone", "휴대폰", "전화번호", "mobile"\]/.test(importV2),
    "import 전화 컬럼 유지"
  );
  assert(/rosterImportContactSummary/.test(caddiesPage), "import preview 연락처 요약");
  assert(/전화번호 있음/.test(caddiesPage) && /동명이인/.test(caddiesPage), "import preview 문구");
  assert(/\/api\/caddies\?employment=/.test(caddiesPage), "/manage/caddies 기존 GET 유지");
  assert(!/\/api\/caddies\/search/.test(caddiesPage), "/manage/caddies는 검색 API 미사용");
  assert(!/vehicleNumber/.test(schema), "vehicleNumber schema 없음");
  assert(!/model NotificationSend/.test(schema) && !/model AlimTalkSend/.test(schema), "알림톡 모델 없음");
  assert(!/phoneNormalized/.test(publishedView), "published view 전화 없음");
  assert(!/phoneNormalized/.test(published), "published payload 전화 없음");
  assert(/SNAPSHOT_FORBIDDEN_KEYS/.test(snapshot) && /phoneNormalized/.test(snapshot), "ops snapshot phone 금지 유지");
  assert(!/phoneNormalized/.test(boardPage), "/board 전화 없음");
  assert(!/"solapi"|"aligo"|"nhn-toast"/i.test(pkg), "알림톡 SDK 없음");
  assert(/href=\{\`\/manage\/caddies\?id=\$\{hit\.id\}\`\}/.test(page), "상세는 캐디 관리");
  assert(/aria-disabled="true"/.test(page), "전화 없음 버튼 disabled");
}

section("empty query returns no dump");
{
  assert(filterCaddiesBySearch(roster, "").length === 0, "빈 검색 전체 덤프 안 함");
  assert(filterCaddiesBySearch(roster, "   ").length === 0, "공백 query 덤프 안 함");
}

section("V2 API 응답 최소화 / telPhone / 빈 query");
{
  const exactName: CaddySearchRecord = {
    id: 90,
    name: "김현정",
    team: "8조",
    teamOrder: 2,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
    phoneNormalized: "01077776666",
  };
  const withMemoLike: CaddySearchRecord = {
    ...kim,
    // extra prisma-like fields must not leak
  };
  const hit = toCaddySearchApiHit(withMemoLike);
  const keys = Object.keys(hit).sort();
  assert(
    keys.join(",") === [...CADDY_SEARCH_API_KEYS].slice().sort().join(","),
    "API hit keys only"
  );
  assert(!("phoneNormalized" in hit), "phoneNormalized key 없음");
  assert(!("memo" in hit) && !("extraFlags" in hit), "memo/extraFlags 없음");
  assert(hit.maskedPhone === "010-****-5678", "maskedPhone");
  assert(hit.hasPhone === true, "hasPhone");
  assert(hit.telPhone === "01012345678", "telPhone canonical");
  const json = JSON.stringify(hit);
  assert(!json.includes("phoneNormalized"), "JSON에 phoneNormalized 키 없음");
  assert(!json.includes("memo"), "JSON에 memo 없음");
  assert(json.includes("010-****-5678"), "mask in JSON");

  const missing = toCaddySearchApiHit(noPhone);
  assert(missing.hasPhone === false, "no phone hasPhone false");
  assert(missing.telPhone === null, "no phone telPhone null");
  assert(missing.maskedPhone === null, "no phone masked null");

  const empty = caddySearchApiResponse(roster, "");
  assert(Array.isArray(empty.results) && empty.results.length === 0, "empty q → []");
  assert(caddySearchApiResponse(roster, "   ").results.length === 0, "whitespace q → []");
  assert(caddySearchApiResponse(roster, "없는이름xyz").results.length === 0, "no result");

  const nameHits = searchCaddiesLimited(roster, "김현정");
  assert(nameHits.map((h) => h.id).join() === "12", "이름 부분검색");
  const spaced = searchCaddiesLimited(roster, "박 서 진");
  assert(spaced[0]?.id === 13, "공백 이름");
  const team7 = searchCaddiesLimited(roster, "7");
  assert(team7[0]?.id === 12, "조 7");
  const team7jo = searchCaddiesLimited(roster, "7조");
  assert(team7jo[0]?.id === 12, "조 7조");
  const byId = searchCaddiesLimited(roster, "123");
  assert(byId[0]?.id === 123, "id 검색");
  const fullPhone = searchCaddiesLimited(roster, "01012345678");
  assert(fullPhone[0]?.id === 12, "full phone");
  const hyphenPhone = searchCaddiesLimited(roster, "010-1234-5678");
  assert(hyphenPhone[0]?.id === 12, "하이픈 phone");
  const last4 = searchCaddiesLimited(roster, "5678");
  assert(last4[0]?.id === 12, "last4");
  const noPhoneName = searchCaddiesLimited(roster, "원다빈");
  assert(noPhoneName[0]?.id === 14 && noPhoneName[0]?.hasPhone === false, "phone 없는 캐디");
  const retiredHit = searchCaddiesLimited(roster, "이퇴사");
  assert(retiredHit[0]?.employmentStatus === "RETIRED", "RETIRED 검색");

  const rankedRoster = [...roster, exactName];
  const ranked = searchCaddiesLimited(rankedRoster, "김현정");
  assert(ranked[0]?.id === 90, "exact name 우선");
  assert(rankCaddySearchHit(exactName, "김현정") === CADDY_SEARCH_RANK.EXACT_NAME, "rank exact name");
  assert(rankCaddySearchHit(tenTeam, "123") === CADDY_SEARCH_RANK.EXACT_ID, "rank exact id");
  assert(rankCaddySearchHit(kim, "5678") === CADDY_SEARCH_RANK.EXACT_PHONE, "rank last4");
  assert(rankCaddySearchHit(kim, "김현정") === CADDY_SEARCH_RANK.NAME_CONTAINS, "rank name contains");
  assert(rankCaddySearchHit(kim, "7조") === CADDY_SEARCH_RANK.TEAM, "rank team");
}

section("20건 limit");
{
  const many: CaddySearchRecord[] = [];
  for (let i = 1; i <= 25; i += 1) {
    many.push({
      id: 1000 + i,
      name: `한팀캐디${i}`,
      team: "7조",
      teamOrder: i,
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
      phoneNormalized: i % 2 === 0 ? `0105555${String(1000 + i).slice(-4)}` : null,
    });
  }
  const limited = searchCaddiesLimited(many, "7조");
  assert(CADDY_SEARCH_LIMIT === 20, "limit constant 20");
  assert(limited.length === 20, "최대 20건");
  assert(limited.every((hit) => hit.team === "7조"), "limit 결과도 매칭만");
  assert(!limited.some((hit) => "phoneNormalized" in hit), "limit 결과 raw phone 키 없음");
  assert(
    limited.filter((hit) => hit.hasPhone).every((hit) => /^010\d{8}$/.test(String(hit.telPhone))),
    "telPhone은 검색 hit에만 canonical"
  );
  const dumped = filterCaddiesBySearch(many, "7조");
  assert(dumped.length === 25, "matcher 자체는 25 매칭");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
