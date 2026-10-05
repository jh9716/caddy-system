/**
 * 대시보드 계정 연결 요약: bulk map + O(1) fetch 가드
 *   npm run test:admin-caddy-link-summary-unit
 */
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { React?: typeof React }).React = React;
import {
  DASHBOARD_ACCOUNT_LINK_LABELS,
  DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH,
  accountLinkEntryForCaddy,
  buildDashboardAccountLinkSummary,
  compactAccountLinkMark,
} from "../src/lib/adminCaddyLinkSummary";
import { TeamBoardPerson } from "../src/components/manage/AdminOpsDashboard";
import type { AdminOpsCaddyRow } from "../src/lib/adminOpsDashboard";

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

const sampleRow: AdminOpsCaddyRow = {
  id: 6,
  name: "임형규",
  team: "1조",
  caddyType: "HOUSE",
  caddyTypeLabel: "HOUSE",
  bucket: "available",
  status: "available",
  statusLabel: "가용",
  statusTone: "available",
  reasons: [],
};

console.log("== summary join ==");
{
  const summary = buildDashboardAccountLinkSummary({
    activeCaddyIds: [1, 2, 3],
    linked: [{ caddyId: 1, username: "kakao_linked" }],
    pending: [{ candidateCaddyIds: [2, 99], username: "kakao_pending" }],
  });
  assert(summary.byCaddyId["1"].status === "LINKED", "linked");
  assert(summary.byCaddyId["1"].username === "kakao_linked", "linked username");
  assert(summary.byCaddyId["2"].status === "PENDING", "pending");
  assert(summary.byCaddyId["3"].status === "UNLINKED", "unlinked");
  assert(summary.byCaddyId["99"] == null, "retired/non-active omitted");
  const linkedWins = buildDashboardAccountLinkSummary({
    activeCaddyIds: [1],
    linked: [{ caddyId: 1, username: "kakao_linked" }],
    pending: [{ candidateCaddyIds: [1], username: "kakao_pending" }],
  });
  assert(linkedWins.byCaddyId["1"].status === "LINKED", "linked wins pending");
  assert(
    accountLinkEntryForCaddy(summary, 2)?.status === "PENDING",
    "lookup pending"
  );
  assert(accountLinkEntryForCaddy(null, 1) === null, "missing summary is null");
}

console.log("== compact marks ==");
assert(compactAccountLinkMark("LINKED") === "🔗", "linked icon");
assert(compactAccountLinkMark("PENDING") === "대기", "pending compact");
assert(compactAccountLinkMark("UNLINKED") === "미", "unlinked compact");
assert(DASHBOARD_ACCOUNT_LINK_LABELS.LINKED === "연결됨", "연결됨 label");
assert(DASHBOARD_ACCOUNT_LINK_LABELS.PENDING === "승인대기", "승인대기 label");
assert(DASHBOARD_ACCOUNT_LINK_LABELS.UNLINKED === "미연결", "미연결 label");

console.log("== dashboard cell keeps availability ==");
{
  const none = renderToStaticMarkup(createElement(TeamBoardPerson, { row: sampleRow }));
  assert(none.includes("임형규") && none.includes("가용"), "이름/가용 유지");
  assert(!none.includes("dash-acct"), "요약 없으면 badge 숨김");
  assert(none.includes("dash-team-person-reason"), "2줄 reason 유지");
  const linked = renderToStaticMarkup(
    createElement(TeamBoardPerson, {
      row: sampleRow,
      account: { status: "LINKED", username: "kakao_5109" },
    })
  );
  assert(linked.includes("가용"), "linked도 가용 유지");
  assert(linked.includes("🔗"), "linked icon");
  assert(!linked.includes(">연결됨<"), "linked는 큰 텍스트 chip 없음");
  const pending = renderToStaticMarkup(
    createElement(TeamBoardPerson, {
      row: sampleRow,
      account: { status: "PENDING", username: "kakao_pending" },
    })
  );
  assert(pending.includes("대기") && pending.includes("is-pending"), "pending mark");
  const unlinked = renderToStaticMarkup(
    createElement(TeamBoardPerson, {
      row: sampleRow,
      account: { status: "UNLINKED" },
    })
  );
  assert(unlinked.includes(">미<") && unlinked.includes("is-unlinked"), "unlinked mark");
}

console.log("== O(1) fetch + no dashboard coupling ==");
{
  const ui = read("src/components/manage/AdminOpsDashboard.tsx");
  const dashApi = read("src/app/api/manage/dashboard/route.ts");
  const summaryApi = read("src/app/api/manage/account-link-summary/route.ts");
  const service = read("src/lib/adminCaddyLinkSummaryService.ts");
  const usersPage = read("src/app/manage/users/page.tsx");
  assert(
    ui.includes("DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH") &&
      ui.includes("fetch(DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH"),
    "dashboard fetches summary path"
  );
  const fetchHits = ui.split("fetch(DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH").length - 1;
  assert(fetchHits === 1, "account-link-summary fetch used once");
  assert(
    DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH === "/api/manage/account-link-summary",
    "canonical summary path"
  );
  assert(!/\/api\/users\/\$\{/.test(ui), "no per-user API");
  assert(!/\/api\/caddy-link-requests\/\$\{/.test(ui), "no per-request API");
  assert(!/caddies\.map\([\s\S]*fetch\(/.test(ui), "no fetch inside caddy map");
  assert(!dashApi.includes("account-link"), "dashboard API stays isolated");
  assert(summaryApi.includes("requireAdmin"), "summary GET requireAdmin");
  assert(summaryApi.includes("loadDashboardAccountLinkSummary"), "summary uses bulk loader");
  assert(service.includes("Promise.all"), "3 queries in parallel");
  assert(service.includes("employmentStatus: \"ACTIVE\""), "ACTIVE only");
  assert(service.includes("status: \"PENDING\""), "PENDING only");
  assert(!service.includes("for (const caddy"), "no per-caddy query loop");
  assert(!summaryApi.includes("redirect("), "no redirect");
  assert(usersPage.includes("/api/caddy-link-requests?status=PENDING"), "users page APIs unchanged");
  assert(!usersPage.includes("autoApprove"), "no auto-approve");
  assert(
    !service.includes("@/lib/caddyLinkRequest\"") &&
      !service.includes("@/lib/caddyLinkRequest'"),
    "summary does not import approve domain"
  );
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
