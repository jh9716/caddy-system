/**
 * OffRequest member/admin UI wiring — no production write, no live push.
 *   npm run test:off-request-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import { isRetiredCaddySessionBlocked } from "../src/lib/auth";
import {
  canTransitionOffRequest,
  normalizeOffDateInput,
} from "../src/lib/offRequestDomain";
import {
  canCancelOwnOffRequestStatus,
  canDecideOffRequestStatus,
  matchesOffRequestCaddyQuery,
  OFF_REQUEST_ADMIN_PATH,
  OFF_REQUEST_MEMBER_PATH,
  offRequestDecisionPushReady,
  offRequestStatusLabel,
  sortOffRequestsPendingFirst,
} from "../src/lib/offRequestUi";

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

section("status labels + transitions (existing enum)");
{
  assert(offRequestStatusLabel("REQUESTED") === "대기", "REQUESTED=대기");
  assert(offRequestStatusLabel("APPROVED") === "승인", "APPROVED=승인");
  assert(offRequestStatusLabel("REJECTED") === "거절", "REJECTED=거절");
  assert(canCancelOwnOffRequestStatus("REQUESTED"), "pending cancel");
  assert(!canCancelOwnOffRequestStatus("APPROVED"), "approved no cancel");
  assert(!canCancelOwnOffRequestStatus("REJECTED"), "rejected no cancel");
  assert(canDecideOffRequestStatus("REQUESTED"), "pending decide");
  assert(!canDecideOffRequestStatus("APPROVED"), "approved no decide");
  assert(canTransitionOffRequest("REQUESTED", "CANCEL"), "domain cancel");
  assert(!canTransitionOffRequest("APPROVED", "CANCEL"), "domain no cancel approved");
}

section("date + list helpers");
{
  let bad = false;
  try {
    normalizeOffDateInput("09-01-2026");
  } catch {
    bad = true;
  }
  assert(bad, "non ISO date rejected");
  const sorted = sortOffRequestsPendingFirst([
    { id: 2, status: "APPROVED", requestedAt: "2026-01-01" },
    { id: 1, status: "REQUESTED", requestedAt: "2026-01-02" },
  ]);
  assert(sorted[0].id === 1, "대기 first");
  assert(
    matchesOffRequestCaddyQuery({ caddy: { name: "김하나1", team: "1조" } }, "하나"),
    "name filter"
  );
  assert(
    !matchesOffRequestCaddyQuery({ caddy: { name: "김하나1", team: "1조" } }, "3조"),
    "name filter miss"
  );
}

section("retired / permission stay server-side");
{
  assert(
    isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: 1,
      employmentStatus: "RETIRED",
    }),
    "RETIRED caddy session blocked"
  );
  assert(
    !isRetiredCaddySessionBlocked({
      role: "caddy",
      caddyId: 1,
      employmentStatus: "ACTIVE",
    }),
    "ACTIVE session allowed"
  );
  assert(
    !isRetiredCaddySessionBlocked({
      role: "admin",
      caddyId: 1,
      employmentStatus: "RETIRED",
    }),
    "admin not blocked by retired caddyId"
  );
}

section("pages + APIs reused");
{
  const member = read("src/app/off-requests/OffRequestMemberClient.tsx");
  const admin = read("src/app/manage/off-requests/OffRequestAdminClient.tsx");
  const layout = read("src/app/off-requests/layout.tsx");
  const mw = read("src/middleware.ts");
  const nav = read("src/lib/boardNav.ts");
  const manage = read("src/components/manage/ManageShell.tsx");
  const service = read("src/lib/offRequestService.ts");
  assert(member.includes("/api/off-requests/mine"), "member lists mine");
  assert(member.includes('method: "POST"'), "member submits POST");
  assert(member.includes("/api/off-requests/${id}/cancel"), "member cancel API");
  assert(admin.includes("/api/off-requests?"), "admin lists GET");
  assert(admin.includes("/api/off-requests/${id}/${action}"), "admin decide API");
  assert(admin.includes('"reject"'), "admin reject action");
  assert(admin.includes("confirmOverQuota"), "quota confirm reused");
  assert(layout.includes('auth.role === "admin"'), "admin redirected off member page");
  assert(layout.includes(OFF_REQUEST_ADMIN_PATH), "admin path");
  assert(mw.includes('pathname.startsWith("/off-requests")'), "middleware gates member route");
  assert(mw.includes('"/off-requests"'), "middleware matcher");
  assert(nav.includes('href: "/off-requests"'), "member menu");
  assert(nav.includes('label: "휴무 신청"'), "member label");
  assert(manage.includes('href: "/manage/off-requests"'), "admin menu");
  assert(service.includes("duplicate_active"), "server duplicate");
  assert(service.includes("invalid_transition"), "server transition");
  assert(!member.includes("/api/push/"), "member no push send");
  assert(!admin.includes("/api/push/"), "admin no push send");
}

section("no schema / no engine rewrite");
{
  const schema = read("prisma/schema.prisma");
  assert(schema.includes("model OffRequest"), "existing OffRequest model");
  assert(!schema.includes("model OffRequestType"), "no new type model");
  const ui = read("src/lib/offRequestUi.ts");
  assert(!ui.includes("autoAssignEngine"), "ui helpers no engine");
  assert(offRequestDecisionPushReady({ caddyId: 3, status: "APPROVED" }), "push hook ready");
  assert(
    !offRequestDecisionPushReady({ caddyId: null, status: "APPROVED" }),
    "push hook needs caddyId"
  );
  const mig = fs
    .readdirSync(path.resolve("prisma/migrations"))
    .filter((name) => /^\d{14}_off_request_ui/.test(name));
  assert(mig.length === 0, "no off-request-ui migration");
}

section("paths");
{
  assert(OFF_REQUEST_MEMBER_PATH === "/off-requests", "member path");
  assert(OFF_REQUEST_ADMIN_PATH === "/manage/off-requests", "admin path");
  assert(fs.existsSync("src/app/off-requests/page.tsx"), "member page");
  assert(fs.existsSync("src/app/manage/off-requests/page.tsx"), "admin page");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
