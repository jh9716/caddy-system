/**
 * VERTHILL privacy policy page + in-app links.
 * Source guards only. No network, no DB, no push.
 *
 * 실행: npm run test:privacy-policy-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DELETION_PATH,
  ACCOUNT_DELETION_PUBLIC_URL,
  PRIVACY_CONTACT_EMAIL_ENV,
  PRIVACY_CONTACT_PATH,
  PRIVACY_CONTACT_PUBLIC_URL,
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_LINK_LABEL,
  PRIVACY_OPERATOR_NAME,
  PRIVACY_PATH,
  PRIVACY_PUBLIC_URL,
  PRIVACY_REQUESTS_ADMIN_PATH,
  PRIVACY_SERVICE_NAME,
  readPrivacyContactEmail,
} from "../src/lib/privacy";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

section("public URL constants");
{
  assert(PRIVACY_PATH === "/privacy", "path /privacy");
  assert(
    PRIVACY_PUBLIC_URL === "https://www.verthill.kr/privacy",
    "production URL www.verthill.kr/privacy"
  );
  assert(PRIVACY_LINK_LABEL === "개인정보처리방침", "Korean label");
  assert(PRIVACY_SERVICE_NAME === "VERTHILL", "service name VERTHILL");
  assert(PRIVACY_OPERATOR_NAME === "VERTHILL", "operator VERTHILL");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(PRIVACY_EFFECTIVE_DATE), "effective date ISO");
  assert(ACCOUNT_DELETION_PATH === "/account-deletion", "deletion path");
  assert(
    ACCOUNT_DELETION_PUBLIC_URL === "https://www.verthill.kr/account-deletion",
    "deletion production URL"
  );
  assert(PRIVACY_CONTACT_EMAIL_ENV === "PRIVACY_CONTACT_EMAIL", "email env name");
  assert(PRIVACY_CONTACT_PATH === "/privacy-contact", "inquiry path");
  assert(
    PRIVACY_CONTACT_PUBLIC_URL === "https://www.verthill.kr/privacy-contact",
    "inquiry production URL"
  );
  assert(PRIVACY_REQUESTS_ADMIN_PATH === "/manage/privacy-requests", "admin inbox path");
}

section("contact email is env-only");
{
  assert(readPrivacyContactEmail({}) === null, "empty env → null");
  assert(readPrivacyContactEmail({ PRIVACY_CONTACT_EMAIL: "" }) === null, "blank → null");
  assert(
    readPrivacyContactEmail({ PRIVACY_CONTACT_EMAIL: "privacy@example.com" }) === null,
    "example.com rejected"
  );
  assert(
    readPrivacyContactEmail({ PRIVACY_CONTACT_EMAIL: "not-an-email" }) === null,
    "invalid rejected"
  );
  assert(
    readPrivacyContactEmail({ PRIVACY_CONTACT_EMAIL: "a@b.co" }) === "a@b.co",
    "valid env email accepted"
  );
  const privacyLib = read("src/lib/privacy.ts");
  assert(!/@verthill\.kr/.test(privacyLib), "lib does not hardcode operator email");
}

const page = read("src/app/privacy/page.tsx");
const link = read("src/components/PrivacyPolicyLink.tsx");
const login = read("src/app/login/LoginClient.tsx");
const home = read("src/app/page.tsx");
const header = read("src/components/AppHeader.tsx");
const chrome = read("src/components/manage/AppChrome.tsx");
const middleware = read("src/middleware.ts");
const schema = read("prisma/schema.prisma");

section("page is public and Korean");
{
  assert(page.includes("PRIVACY_LINK_LABEL"), "page title uses Korean label constant");
  assert(page.includes("서비스명"), "운영 주체 절");
  assert(page.includes("운영 주체"), "운영 주체 라벨");
  assert(page.includes("PRIVACY_OPERATOR_NAME"), "operator constant");
  assert(page.includes("수집하는 정보"), "수집 절");
  assert(page.includes("수집 및 이용 목적"), "목적 절");
  assert(page.includes("보유 및 이용 기간"), "보유 절");
  assert(page.includes("제3자"), "제3자 절");
  assert(page.includes("로그인"), "로그인 절");
  assert(page.includes("푸시"), "푸시 절");
  assert(page.includes("이용자 권리") || page.includes("사용자 권리"), "권리 절");
  assert(page.includes("삭제 요청"), "삭제 요청 절");
  assert(page.includes("문의"), "문의 절");
  assert(page.includes("시행일"), "시행일 절");
  assert(page.includes("kr.verthill.caddy"), "package name");
  assert(page.includes("https://www.verthill.kr"), "production host");
  assert(page.includes("PRIVACY_PUBLIC_URL"), "canonical uses constant");
  assert(page.includes("ACCOUNT_DELETION_PATH"), "privacy links deletion page");
  assert(page.includes("PRIVACY_CONTACT_PATH"), "privacy links inquiry form");
  assert(page.includes("readPrivacyContactEmail"), "email comes from env reader");
  assert(
    page.includes("계정 식별 정보와 회신 이메일"),
    "deletion request collection disclosed"
  );
  assert(page.includes("요청을 확인하고 처리하기"), "deletion request retention purpose");
  assert(page.includes("공개 문의 폼"), "public inquiry mechanism named");
  assert(
    page.includes("본인 확인을 거쳐 계정 및 관련 개인정보를"),
    "deletion after review, not receive-only"
  );
  assert(
    page.includes("보안·운영상 정당한 보존 사유"),
    "lawful retention disclosed"
  );
}

section("no invented operator contact placeholders");
{
  const forbidden = [
    "privacy@example.com",
    "example.com",
    "000-0000",
    "010-0000",
    "(추후 기재)",
    "TBD",
    "TODO",
    "코드에서 확정된 값이 없습니다",
    "확정되는 즉시",
    "확정 후 이 항목",
    "아직 게시하지 않습니다",
  ];
  for (const token of forbidden) {
    assert(!page.includes(token), `page has no ${token}`);
  }
}

section("facts match schema/code (no invented collection)");
{
  assert(schema.includes("kakaoUserId"), "schema has kakaoUserId");
  assert(schema.includes("phoneNormalized"), "schema has phone");
  assert(schema.includes("DevicePushToken"), "schema has FCM token");
  assert(schema.includes("PushSubscription"), "schema has web push");
  assert(schema.includes("CourseReportPhoto"), "schema has report photos");
  assert(page.includes("카카오 숫자 회원번호") || page.includes("카카오 회원번호"), "Kakao id only");
  assert(page.includes("이메일") && page.includes("수집하지 않습니다"), "no Kakao email claim");
  assert(page.includes("bcrypt"), "password hash named");
  assert(page.includes("vh_session"), "session cookie named");
  assert(page.includes("Firebase") || page.includes("FCM"), "FCM named");
  assert(page.includes("Neon"), "Neon named");
  assert(page.includes("Vercel"), "Vercel named");
  assert(page.includes("알림톡을 실제 발송하지는 않습니다"), "no Alimtalk send claim");
  assert(page.includes("소프트 삭제"), "soft delete stated");
  assert(
    page.includes("자동 파기 주기") || page.includes("자동 파기 주기는 없습니다"),
    "no invented retention years"
  );
}

section("same-origin in-app links");
{
  assert(link.includes("PRIVACY_PATH"), "shared link uses path constant");
  assert(!link.includes("https://"), "shared link is relative, not hardcoded host");
  assert(login.includes("LegalLinks"), "login has legal links");
  assert(home.includes("LegalLinks"), "home has legal links");
  assert(header.includes("PrivacyPolicyLink"), "header has privacy link");
  assert(header.includes("AccountDeletionLink"), "header has deletion link when logged in");
  assert(chrome.includes("PrivacyPolicyLink"), "chrome sidebar/drawer has privacy link");
  assert(chrome.includes("AccountDeletionLink"), "chrome has deletion request link");
  const chromeHits = chrome.split("AccountDeletionLink").length - 1;
  assert(chromeHits >= 2, "chrome has sidebar + drawer deletion link");
}

section("middleware does not gate public legal pages");
{
  assert(!middleware.includes("/privacy"), "middleware matcher omits /privacy");
  assert(!middleware.includes("/account-deletion"), "middleware matcher omits /account-deletion");
  assert(!middleware.includes("/privacy-contact"), "middleware matcher omits /privacy-contact");
  assert(middleware.includes("/login"), "middleware still redirects others to login");
}

if (failed > 0) {
  console.error(`\nprivacy-policy tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nprivacy-policy tests passed: ${passed}`);
