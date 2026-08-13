/**
 * 직원 Caddy 연결 UI 헬퍼 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-caddy-link-staff-ui-unit.ts
 */
import {
  assertStaffSafeRequestView,
  resolveStaffLinkUiMode,
  staffLinkErrorMessage,
} from "../src/lib/caddyLinkRequestUi";

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

function main() {
  console.log("== resolveStaffLinkUiMode ==");
  assert(
    resolveStaffLinkUiMode({ linked: true, request: null }) === "redirect_caddy",
    "linked → caddy"
  );
  assert(
    resolveStaffLinkUiMode({
      linked: false,
      request: {
        id: 1,
        status: "APPROVED",
        submittedName: "홍길동",
        maskedPhone: "010-****-5678",
      },
    }) === "redirect_caddy",
    "APPROVED → caddy"
  );
  assert(
    resolveStaffLinkUiMode({
      linked: false,
      request: {
        id: 1,
        status: "PENDING",
        submittedName: "홍길동",
        maskedPhone: "010-****-5678",
      },
    }) === "pending",
    "PENDING"
  );
  assert(
    resolveStaffLinkUiMode({
      linked: false,
      request: {
        id: 1,
        status: "REJECTED",
        submittedName: "홍길동",
        maskedPhone: "010-****-5678",
        decisionNote: "이름 불일치",
      },
    }) === "rejected",
    "REJECTED"
  );
  assert(
    resolveStaffLinkUiMode({
      linked: false,
      request: {
        id: 1,
        status: "CANCELLED",
        submittedName: "홍길동",
        maskedPhone: "010-****-1234",
      },
    }) === "form",
    "CANCELLED → form"
  );
  assert(
    resolveStaffLinkUiMode({ linked: false, request: null }) === "form",
    "no request → form"
  );

  console.log("== staffLinkErrorMessage ==");
  assert(
    staffLinkErrorMessage("no_candidates").includes("등록된 캐디 정보를 찾을 수 없습니다") &&
      staffLinkErrorMessage("no_candidates").includes("경기과"),
    "no_candidates copy"
  );
  assert(
    staffLinkErrorMessage("invalid_phone").includes("휴대폰"),
    "invalid_phone"
  );
  assert(
    staffLinkErrorMessage("pending_exists").includes("대기"),
    "pending_exists"
  );
  assert(
    staffLinkErrorMessage("already_linked").includes("이미"),
    "already_linked"
  );
  assert(
    staffLinkErrorMessage("not_linkable_user").includes("카카오"),
    "not_linkable_user"
  );
  assert(
    staffLinkErrorMessage("unknown_x", "서버 메시지").includes("서버"),
    "fallback message"
  );

  console.log("== assertStaffSafeRequestView ==");
  assert(
    assertStaffSafeRequestView({
      id: 1,
      status: "PENDING",
      submittedName: "김씨",
      maskedPhone: "010-****-1111",
    }) === true,
    "staff-safe ok"
  );
  assert(
    assertStaffSafeRequestView({
      id: 1,
      candidateCaddyIds: [1, 2],
      maskedPhone: "010-****-1111",
    }) === false,
    "reject candidateCaddyIds"
  );
  assert(
    assertStaffSafeRequestView({
      id: 1,
      candidates: [{ id: 1 }],
      maskedPhone: "010-****-1111",
    }) === false,
    "reject candidates"
  );
  assert(
    assertStaffSafeRequestView({
      id: 1,
      phoneNormalized: "01011112222",
    }) === false,
    "reject phoneNormalized"
  );
  assert(
    assertStaffSafeRequestView({
      id: 1,
      phone: "01011112222",
    }) === false,
    "reject raw phone field"
  );

  // 소스 가드: 직원 UI가 후보/원문 필드를 렌더하지 않는지
  console.log("== staff UI source guard ==");
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const root = path.join(__dirname, "..");
  const files = [
    "src/app/caddy/link/CaddyLinkClient.tsx",
    "src/app/caddy/link/page.tsx",
    "src/lib/caddyLinkRequestUi.ts",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert(!/candidateCaddyIds/.test(src) || rel.includes("caddyLinkRequestUi"), `${rel}: no candidate ids in UI render path`);
    // ui helper may mention field names for guards — client must not
    if (rel.includes("CaddyLinkClient") || rel.endsWith("page.tsx")) {
      assert(!/candidateCaddyIds|candidates\b|phoneNormalized/.test(src), `${rel}: no candidate/raw phone identifiers`);
      assert(!/\/api\/caddy-link-requests\?/.test(src), `${rel}: no admin list API`);
      assert(
        !/\/api\/caddy-link-requests\/[^"'`\s]+\/(approve|reject)/.test(src),
        `${rel}: no approve/reject API`
      );
    }
  }

  const linkClient = fs.readFileSync(
    path.join(root, "src/app/caddy/link/CaddyLinkClient.tsx"),
    "utf8"
  );
  assert(
    linkClient.includes("홈페이지에 먼저 캐디 등록이 되어 있어야"),
    "link page shows pre-registration hint"
  );

  const caddyPage = fs.readFileSync(
    path.join(root, "src/app/caddy/page.tsx"),
    "utf8"
  );
  assert(
    caddyPage.includes("/caddy/link") &&
      caddyPage.includes("linked === false") &&
      caddyPage.includes("APPROVED"),
    "caddy page redirects unlinked to /caddy/link (skips APPROVED)"
  );
  assert(
    !caddyPage.includes("candidateCaddyIds"),
    "caddy page no candidates"
  );

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
