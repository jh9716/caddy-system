/**
 * 관리자 캐디 명단 중심 계정 연결 뷰 헬퍼 + /manage/users 소스 가드
 *   npm run test:admin-caddy-link-roster-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ADMIN_LINK_STATUS_LABELS,
  buildAdminCaddyLinkRoster,
  canApprovePendingForCaddy,
  filterAdminCaddyLinkRoster,
  groupAdminCaddyLinkRoster,
  isCaddyOccupied,
  pendingRequestsForCaddy,
  resolveAdminLinkStatus,
  summarizeAdminCaddyLinkRoster,
  toSafeRosterCaddy,
  uniqueRosterTeams,
  unlinkedKakaoAccounts,
} from "../src/lib/adminCaddyLinkRoster";
import { initialAdminSelectedCaddyId } from "../src/lib/caddyLinkRequestUi";

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

const caddies = [
  toSafeRosterCaddy({ id: 1, name: "김연결", team: "1조", teamOrder: 1, employmentStatus: "ACTIVE" }),
  toSafeRosterCaddy({ id: 2, name: "이대기", team: "1조", teamOrder: 2, employmentStatus: "ACTIVE" }),
  toSafeRosterCaddy({ id: 3, name: "박미연", team: "2조", teamOrder: 1, employmentStatus: "ACTIVE" }),
  toSafeRosterCaddy({ id: 4, name: "최퇴사", team: "1조", teamOrder: 9, employmentStatus: "RETIRED" }),
];

const users = [
  { id: 10, username: "kakao_linked", caddyId: 1, linked: true },
  { id: 11, username: "kakao_pending", caddyId: null, linked: false },
  { id: 12, username: "kakao_orphan", caddyId: null, linked: false },
];

const pending = [
  {
    id: 100,
    submittedName: "이대기",
    maskedPhone: "010-****-1234",
    user: { id: 11, username: "kakao_pending" },
    candidates: [{ id: 2, name: "이대기" }, { id: 99, name: "이동명" }],
  },
];

console.log("== status + labels ==");
assert(ADMIN_LINK_STATUS_LABELS.linked === "연결됨", "연결됨 label");
assert(ADMIN_LINK_STATUS_LABELS.pending === "승인대기", "승인대기 label");
assert(ADMIN_LINK_STATUS_LABELS.unlinked === "미연결", "미연결 label");
assert(
  resolveAdminLinkStatus({ linkedUser: users[0], pendingForCaddy: pending }) === "linked",
  "linked wins over pending"
);
assert(
  resolveAdminLinkStatus({ linkedUser: null, pendingForCaddy: pending }) === "pending",
  "pending when unlinked + request"
);
assert(
  resolveAdminLinkStatus({ linkedUser: null, pendingForCaddy: [] }) === "unlinked",
  "unlinked default"
);

console.log("== roster join ==");
const roster = buildAdminCaddyLinkRoster(caddies, users, pending);
assert(roster.length === 3, "ACTIVE only");
assert(roster.every((row) => row.caddy.employmentStatus === "ACTIVE"), "no RETIRED");
assert(roster[0].caddy.name === "김연결" && roster[0].status === "linked", "1조 1번 linked");
assert(roster[0].linkedUser?.username === "kakao_linked", "linked username");
assert(roster[1].status === "pending" && roster[1].pendingForCaddy[0].id === 100, "1조 2번 pending");
assert(roster[2].status === "unlinked" && roster[2].linkedUser === null, "2조 미연결");

console.log("== candidate / approve gate ==");
assert(pendingRequestsForCaddy(2, pending).length === 1, "pending lists candidate caddy");
assert(pendingRequestsForCaddy(3, pending).length === 0, "unrelated caddy not pending");
assert(canApprovePendingForCaddy(pending[0], 2), "candidate can approve");
assert(!canApprovePendingForCaddy(pending[0], 3), "non-candidate cannot approve");
assert(initialAdminSelectedCaddyId(1) === null, "1 candidate still no auto-select");
assert(initialAdminSelectedCaddyId(pending[0].candidates.length) === null, "N candidates no auto-select");

console.log("== filters + summary ==");
const summary = summarizeAdminCaddyLinkRoster(roster);
assert(summary.total === 3 && summary.linked === 1 && summary.pending === 1 && summary.unlinked === 1, "counts");
assert(filterAdminCaddyLinkRoster(roster, { team: "2조" }).map((r) => r.caddy.id).join() === "3", "team filter");
assert(filterAdminCaddyLinkRoster(roster, { status: "pending" }).length === 1, "status filter");
assert(filterAdminCaddyLinkRoster(roster, { nameQuery: "박미" }).length === 1, "name filter");
assert(filterAdminCaddyLinkRoster(roster, { nameQuery: "kakao_linked" }).length === 1, "username filter");
assert(uniqueRosterTeams(caddies).join(",") === "1조,2조", "teams");
const grouped = groupAdminCaddyLinkRoster(roster);
assert(grouped.map((g) => g.team).join(",") === "1조,2조", "group by team");
assert(grouped[0].rows.length === 2 && grouped[1].rows.length === 1, "group sizes");

console.log("== orphan kakao + occupied ==");
const orphans = unlinkedKakaoAccounts(users);
assert(orphans.map((u) => u.username).join(",") === "kakao_pending,kakao_orphan", "unlinked kakao kept");
assert(isCaddyOccupied(1, [1, 8]), "occupied");
assert(!isCaddyOccupied(3, [1, 8]), "vacant");

console.log("== manage/users source ==");
const page = fs.readFileSync(path.resolve("src/app/manage/users/page.tsx"), "utf8");
assert(page.includes("/api/caddies?employment=ACTIVE"), "loads ACTIVE roster");
assert(page.includes("/api/users"), "loads users");
assert(page.includes("/api/caddy-link-requests?status=PENDING"), "loads PENDING");
assert(page.includes("buildAdminCaddyLinkRoster"), "joins via helper");
assert(page.includes("캐디 명단"), "roster section");
assert(page.includes("캐디와 연결되지 않은 Kakao"), "orphan section kept");
assert(page.includes("승인대기"), "pending status");
assert(page.includes("미연결"), "unlinked status");
assert(page.includes("link-caddy") && page.includes("unlink-caddy"), "manual link/unlink");
assert(page.includes("/approve") && page.includes("selectedCaddyId"), "approve selectedCaddyId");
assert(page.includes("/reject"), "reject kept");
assert(page.includes("initialAdminSelectedCaddyId"), "no auto-select helper");
assert(page.includes("canApprovePendingForCaddy"), "candidate-only approve UI");
assert(page.includes("isCaddyOccupied"), "occupied caddy blocked in UI");
assert(page.includes("자동 승인 없음") || page.includes("자동 승인"), "no auto-approve copy");
assert(page.includes("maskedPhone") && !/phoneNormalized/.test(page), "maskedPhone only");
assert(!/\bnickname\b|\bemail\b/.test(page), "no nickname/email");
assert(
  !page.includes("@/lib/caddyLinkRequest\"") && !page.includes("@/lib/caddyLinkRequest'"),
  "page does not import domain"
);
assert(!page.includes("autoApprove"), "no autoApprove helper");
assert(page.includes("자동 연결 없음"), "no auto-link by name/phone");
assert(page.includes("formatCaddyLabel"), "uses formatCaddyLabel");
assert(page.includes("us-dense-row") && page.includes("us-team-h"), "compact roster rows + team headers");
assert(!page.includes("us-manual-mobile"), "no mobile card list");
assert(page.includes("us-summary-line"), "one-line summary");
assert(page.includes("pendingModal") || page.includes("PendingDetailModal"), "pending detail not inline");

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
