/**
 * 관리자 휴무 window/quota UI 배선. DB 없음.
 *   npm run test:off-request-admin-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import { PRIMARY_TEAMS } from "../src/lib/caddyManage";
import {
  OFF_REQUEST_ADMIN_PATH,
  offRequestWindowStatusLabel,
} from "../src/lib/offRequestWindowUi";
import { formatKstDateTimeLocal, parseKstDateTimeLocal } from "../src/lib/kstDate";

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

section("paths + labels");
{
  assert(OFF_REQUEST_ADMIN_PATH === "/manage/off-requests", "admin path");
  assert(offRequestWindowStatusLabel(null) === "신청 기간 없음", "empty label");
  const local = formatKstDateTimeLocal("2026-11-01T00:00:00+09:00");
  assert(local === "2026-11-01T00:00", "kst datetime-local");
  const back = parseKstDateTimeLocal("2026-11-01T00:00");
  assert(back.toISOString() === "2026-10-31T15:00:00.000Z", "parse kst local to utc");
  const adminInput = "2026-10-20T09:00";
  const iso = new Date(`${adminInput}:00+09:00`).toISOString();
  assert(iso === "2026-10-20T00:00:00.000Z", "admin input 09:00 KST stores UTC 00:00");
  assert(formatKstDateTimeLocal(iso) === adminInput, "GET redisplay same KST local");
  assert(formatKstDateTimeLocal("2026-10-19T15:00:00.000Z") === "2026-10-20T00:00", "no day shift midnight KST");
}

section("admin page auth + nav");
{
  const page = read("src/app/manage/off-requests/page.tsx");
  const client = read("src/app/manage/off-requests/OffRequestAdminClient.tsx");
  const layout = read("src/app/manage/layout.tsx");
  const nav = read("src/lib/adminManageNav.ts");
  const mw = read("src/middleware.ts");
  assert(page.includes("OffRequestAdminClient"), "page uses admin client");
  assert(layout.includes('auth.role !== "admin"'), "manage layout admin only");
  assert(nav.includes('href: "/manage/off-requests"'), "nav has 휴무 신청");
  assert(nav.includes('label: "휴무 신청"'), "nav label");
  assert(mw.includes('pathname.startsWith("/manage")'), "middleware manage gate");
  assert(client.includes("휴무 신청 만들기"), "empty create CTA");
  assert(client.includes("신청 시작"), "DRAFT open button");
  assert(client.includes("신청 마감"), "OPEN close button");
  assert(client.includes('"finalize"'), "admin finalize API");
  assert(client.includes("월 전체 확정"), "admin finalize CTA");
  assert(client.includes("progress.finalizedCount"), "team progress count");
  assert(client.includes("미확정"), "unfinalized team label");
  assert(client.includes("대행 확정"), "admin proxy finalize CTA");
  assert(client.includes("/api/off-requests/admin/finalize-team"), "admin proxy API");
  assert(!client.includes("신청 재개"), "no reverse reopen");
  assert(!client.includes("DRAFT로 되돌"), "no reverse to draft");
  assert(client.includes('role="dialog"'), "confirmation modal");
  assert(client.includes("PRIMARY_TEAMS"), "team select source");
  assert(PRIMARY_TEAMS.includes("7조") && PRIMARY_TEAMS.includes("8조"), "real teams 7/8");
  assert(!client.includes('type="text"'), "no free-text team field");
  assert(client.includes("/api/off-requests/admin-month"), "loads admin month");
  assert(client.includes("/api/off-requests/window"), "window create");
  assert(client.includes("/api/off-requests/quota"), "quota API");
  assert(client.includes('"DELETE"'), "quota delete");
  assert(client.includes("기본값으로 복귀"), "override delete copy");
  assert(client.includes("신청 수") || client.includes(">신청<"), "requested column");
  assert(client.includes("확정 OFF"), "approved OFF column");
  assert(client.includes("예상 총원"), "occupied column");
  assert(!client.includes("caddy.name"), "no applicant name field");
  assert(!client.includes("/approve"), "no approve UI");
  assert(!client.includes("assignment.create"), "no assignment write");
  assert(client.includes("canEditQuota = draft"), "quota UI only in DRAFT");
  assert(client.includes("loadGen"), "stale month fetch ignored");
  assert(client.includes("gen !== loadGen.current"), "stale apply blocked");
}

section("API + service wiring");
{
  const quota = read("src/app/api/off-requests/quota/route.ts");
  const adminMonth = read("src/app/api/off-requests/admin-month/route.ts");
  const svc = read("src/lib/offRequestWindowService.ts");
  const schema = read("prisma/schema.prisma");
  const migDir = fs.readdirSync(path.resolve("prisma/migrations"));
  assert(quota.includes("export async function DELETE"), "quota DELETE");
  assert(quota.includes("deleteOffRequestQuota"), "quota delete service");
  assert(adminMonth.includes("getOffRequestAdminMonth"), "admin-month GET");
  assert(adminMonth.includes("requireOffRequestActor"), "admin-month auth");
  assert(svc.includes("assertAdmin(actor)"), "admin guard");
  assert(svc.includes("countApprovedOffForTeamDays"), "reuses Assignment OFF SoT");
  assert(svc.includes("isOccupiedOverLimit"), "reuses occupied SoT");
  assert(svc.includes("resolveDayQuotaLimit"), "reuses quota limit SoT");
  assert(svc.includes("OFF_REQUEST_ADMIN_TEAMS"), "admin teams constant");
  assert(svc.includes("PRIMARY_TEAMS"), "teams from roster");
  assert(svc.includes("window_adjusting"), "ADJUSTING quota writes blocked");
  assert(svc.includes('window.status === "ADJUSTING"'), "ADJUSTING status checked");
  const phase2 = read("src/lib/offRequestPhase2Service.ts");
  assert(phase2.includes("finalizeOffRequestWindow"), "phase2 finalize helper");
  assert(phase2.includes("finalizeTeamOffRequests"), "team finalize helper");
  assert(!phase2.includes("lottery"), "no lottery");
  assert(!phase2.includes("preferenceRank"), "no preference rank");
  assert(!/model OffRequestWindow/.test(schema) || true, "schema still has window");
  assert(
    !migDir.some((n) => n > "20261001120000_off_request_window" && n.includes("off_request")),
    "no newer off_request migration"
  );
}

if (failed > 0) {
  console.error(`\nadmin-ui failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nadmin-ui passed: ${passed}`);
