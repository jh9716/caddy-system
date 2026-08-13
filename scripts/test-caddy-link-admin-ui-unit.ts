/**
 * 관리자 Caddy 연결 승인 큐 UI 헬퍼/소스 가드 (DB 없음)
 * 실행: npx tsx scripts/test-caddy-link-admin-ui-unit.ts
 */
import {
  adminLinkErrorMessage,
  assertAdminQueueSafeView,
  initialAdminSelectedCaddyId,
} from "../src/lib/caddyLinkRequestUi";
import fs from "fs";
import path from "path";

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
  console.log("== initialAdminSelectedCaddyId (no auto-select) ==");
  assert(initialAdminSelectedCaddyId(0) === null, "0 candidates → null");
  assert(initialAdminSelectedCaddyId(1) === null, "1 candidate → still null");
  assert(initialAdminSelectedCaddyId(5) === null, "N candidates → null");

  console.log("== adminLinkErrorMessage ==");
  assert(
    adminLinkErrorMessage("phone_conflict").includes("휴대폰"),
    "phone_conflict"
  );
  assert(
    adminLinkErrorMessage("caddy_already_linked").includes("연결"),
    "caddy_already_linked"
  );
  assert(
    adminLinkErrorMessage("not_pending").includes("대기"),
    "not_pending"
  );

  console.log("== assertAdminQueueSafeView ==");
  assert(
    assertAdminQueueSafeView({
      id: 1,
      submittedName: "홍길동",
      maskedPhone: "010-****-1234",
      user: { id: 1, username: "kakao_1" },
      candidates: [
        {
          id: 10,
          name: "홍길동",
          team: "A",
          teamOrder: 1,
          employmentStatus: "ACTIVE",
        },
      ],
    }) === true,
    "safe admin view"
  );
  assert(
    assertAdminQueueSafeView({
      maskedPhone: "010-****-1",
      phoneNormalized: "01011112222",
      candidates: [],
      user: { username: "x" },
    }) === false,
    "reject phoneNormalized"
  );
  assert(
    assertAdminQueueSafeView({
      maskedPhone: "010-****-1",
      nickname: "닉",
      candidates: [],
      user: { username: "x" },
    }) === false,
    "reject nickname"
  );

  console.log("== manage/users source guard ==");
  const root = path.join(__dirname, "..");
  const page = fs.readFileSync(
    path.join(root, "src/app/manage/users/page.tsx"),
    "utf8"
  );
  assert(
    page.includes("/api/caddy-link-requests?status=PENDING"),
    "loads PENDING queue"
  );
  assert(
    page.includes("/approve") && page.includes("selectedCaddyId"),
    "approve with selectedCaddyId"
  );
  assert(page.includes("/reject"), "reject API");
  assert(page.includes("window.confirm"), "confirm before action");
  assert(
    page.includes("initialAdminSelectedCaddyId"),
    "no auto-select helper used"
  );
  assert(
    page.includes("maskedPhone") && !/phoneNormalized/.test(page),
    "maskedPhone only, no phoneNormalized"
  );
  assert(!/\bnickname\b|\bemail\b/.test(page), "no nickname/email");
  assert(
    page.includes("link-caddy") && page.includes("unlink-caddy"),
    "manual link/unlink kept"
  );
  assert(
    page.includes("자동 승인 없음") || page.includes("자동 승인"),
    "auto-approve discouraged in copy"
  );

  // API/domain files must be untouched in this PR working tree check is separate;
  // ensure page does not import domain service
  assert(
    !page.includes("@/lib/caddyLinkRequest\"") &&
      !page.includes("@/lib/caddyLinkRequest'"),
    "page does not import domain caddyLinkRequest"
  );

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
