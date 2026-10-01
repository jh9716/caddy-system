/**
 * OffRequest domain 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-off-request-domain-unit.ts
 */

import {
  OFF_APPROVE_QUOTA_PER_TEAM,
  applyApproveDecision,
  applyRejectDecision,
  applyRevokePreservingApprovalAudit,
  canApproveAgainstQuota,
  canTransitionOffRequest,
  computeOffQuotaSnapshot,
  formatOffDateYmd,
  isActiveOffRequestStatus,
  isOffRequestStatus,
  isOccupiedOverLimit,
  isRequestedOverLimit,
  isYmdInYearMonth,
  requireCalendarYmd,
  canTransitionOffRequestWindow,
  nextOffRequestStatus,
  normalizeOffDateInput,
  offAssignmentDayRange,
  resolveDayQuotaLimit,
  yearMonthFromYmd,
  ymdDaysInYearMonth,
} from "../src/lib/offRequestDomain";
import { isPastKstYmd } from "../src/lib/kstDate";

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

section("status helpers");
{
  assert(isOffRequestStatus("REQUESTED"), "REQUESTED ok");
  assert(isOffRequestStatus("APPROVED"), "APPROVED ok");
  assert(isOffRequestStatus("UNSELECTED"), "UNSELECTED ok");
  assert(!isOffRequestStatus("WAITLISTED"), "WAITLISTED not a status");
  assert(isActiveOffRequestStatus("REQUESTED"), "REQUESTED active");
  assert(isActiveOffRequestStatus("APPROVED"), "APPROVED active");
  assert(!isActiveOffRequestStatus("REJECTED"), "REJECTED not active");
  assert(!isActiveOffRequestStatus("CANCELLED"), "CANCELLED not active");
  assert(!isActiveOffRequestStatus("UNSELECTED"), "UNSELECTED not active");
}

section("date normalize");
{
  const d = normalizeOffDateInput("2026-08-15");
  assert(formatOffDateYmd(d) === "2026-08-15", "roundtrip ymd");
  assert(d.getHours() === 0, "local midnight hours");
  let threw = false;
  try {
    normalizeOffDateInput("08-15-2026");
  } catch {
    threw = true;
  }
  assert(threw, "rejects non ISO ymd");
  const range = offAssignmentDayRange("2026-08-15");
  assert(
    formatOffDateYmd(range.startDate) === "2026-08-15",
    "range start same day"
  );
  assert(range.endDate.getTime() > range.startDate.getTime(), "end after start");
  assert(range.endDate.getHours() === 23, "end at 23h");
}

section("transitions");
{
  assert(canTransitionOffRequest("REQUESTED", "APPROVE"), "REQUESTED→APPROVE");
  assert(canTransitionOffRequest("REQUESTED", "REJECT"), "REQUESTED→REJECT");
  assert(canTransitionOffRequest("REQUESTED", "CANCEL"), "REQUESTED→CANCEL");
  assert(canTransitionOffRequest("APPROVED", "REVOKE"), "APPROVED→REVOKE");
  assert(!canTransitionOffRequest("REQUESTED", "REVOKE"), "no revoke from REQUESTED");
  assert(!canTransitionOffRequest("APPROVED", "APPROVE"), "no re-approve");
  assert(!canTransitionOffRequest("REJECTED", "APPROVE"), "no approve from REJECTED");
  assert(!canTransitionOffRequest("CANCELLED", "CANCEL"), "no cancel from CANCELLED");
  assert(nextOffRequestStatus("REQUESTED", "APPROVE") === "APPROVED", "next APPROVE");
  assert(nextOffRequestStatus("APPROVED", "REVOKE") === "CANCELLED", "next REVOKE");
  let threw = false;
  try {
    nextOffRequestStatus("CANCELLED", "APPROVE");
  } catch {
    threw = true;
  }
  assert(threw, "invalid next throws");
}

section("quota");
{
  assert(OFF_APPROVE_QUOTA_PER_TEAM === 5, "default quota 5");
  const under = computeOffQuotaSnapshot({
    approvedCount: 4,
    requestedCount: 3,
  });
  assert(under.approvedCount === 4, "approved 4");
  assert(under.requestedCount === 3, "requested 3");
  assert(under.quota === 5, "quota 5");
  assert(!under.overQuota, "not over");
  assert(!under.approveWouldExceedQuota, "approve ok without confirm");

  const atCap = computeOffQuotaSnapshot({ approvedCount: 5, requestedCount: 2 });
  assert(atCap.overQuota, "at cap is overQuota");
  assert(atCap.approveWouldExceedQuota, "6th needs confirm");

  const ok = canApproveAgainstQuota({ approvedCount: 4 });
  assert(ok.ok && !ok.requiresConfirm, "4/5 approve free");

  const blocked = canApproveAgainstQuota({ approvedCount: 5 });
  assert(!blocked.ok && blocked.requiresConfirm, "5/5 blocked without confirm");

  const forced = canApproveAgainstQuota({
    approvedCount: 5,
    confirmOverQuota: true,
  });
  assert(forced.ok && forced.requiresConfirm, "5/5 allowed with confirm");
}

section("window month + quota helpers");
{
  assert(yearMonthFromYmd("2026-10-01") === "2026-10", "yearMonth from ymd");
  assert(isYmdInYearMonth("2026-10-31", "2026-10"), "in month");
  assert(!isYmdInYearMonth("2026-11-01", "2026-10"), "next month out");
  const oct = ymdDaysInYearMonth("2026-10");
  assert(oct[0] === "2026-10-01" && oct[30] === "2026-10-31" && oct.length === 31, "Oct days");
  const feb = ymdDaysInYearMonth("2024-02");
  assert(feb.length === 29, "leap Feb");
  assert(canTransitionOffRequestWindow("DRAFT", "OPEN"), "DRAFT→OPEN");
  assert(canTransitionOffRequestWindow("OPEN", "ADJUSTING"), "OPEN→ADJUSTING");
  assert(canTransitionOffRequestWindow("ADJUSTING", "FINALIZED"), "ADJUSTING→FINALIZED");
  assert(!canTransitionOffRequestWindow("OPEN", "DRAFT"), "no reverse OPEN→DRAFT");
  assert(!canTransitionOffRequestWindow("ADJUSTING", "OPEN"), "no reverse ADJUSTING→OPEN");
  assert(!canTransitionOffRequestWindow("FINALIZED", "ADJUSTING"), "no reverse FINALIZED");
  assert(!canTransitionOffRequestWindow("DRAFT", "ADJUSTING"), "no skip DRAFT→ADJUSTING");
  assert(resolveDayQuotaLimit({}) === 5, "fallback 5");
  assert(resolveDayQuotaLimit({ defaultQuota: 7 }) === 7, "window default");
  assert(resolveDayQuotaLimit({ defaultQuota: 7, overrideLimit: 3 }) === 3, "override");
  assert(!isRequestedOverLimit(5, 5), "at cap not over");
  assert(isRequestedOverLimit(6, 5), "6/5 over");
  assert(
    !isOccupiedOverLimit({ approvedCount: 2, requestedCount: 3, limit: 5 }),
    "2+3=5 not over"
  );
  assert(
    isOccupiedOverLimit({ approvedCount: 2, requestedCount: 4, limit: 5 }),
    "2+4=6 over"
  );
  let invalidYmd = false;
  try {
    requireCalendarYmd("2026-02-30");
  } catch {
    invalidYmd = true;
  }
  assert(invalidYmd, "Feb 30 rejected");
  assert(requireCalendarYmd("2026-10-01").getDate() === 1, "valid Oct 1");
}

section("KST month boundary");
{
  const justAfterKstMidnight = new Date("2026-09-30T15:30:00Z"); // 2026-10-01 00:30 KST
  assert(isPastKstYmd("2026-09-30", justAfterKstMidnight), "Sep 30 is past at Oct 1 00:30 KST");
  assert(!isPastKstYmd("2026-10-01", justAfterKstMidnight), "Oct 1 is today at Oct 1 00:30 KST");
  const beforeKstMidnight = new Date("2026-09-30T14:30:00Z"); // 2026-09-30 23:30 KST
  assert(!isPastKstYmd("2026-09-30", beforeKstMidnight), "Sep 30 is today at 23:30 KST");
  assert(!isPastKstYmd("2026-10-01", beforeKstMidnight), "Oct 1 still future at Sep 30 23:30 KST");
}

section("approve / reject / revoke audit fields");
{
  const approved = applyApproveDecision({
    decidedByUserId: 10,
    decisionNote: "조율 승인",
    assignmentId: 99,
    at: new Date("2026-08-15T12:00:00"),
  });
  assert(approved.status === "APPROVED", "approve status");
  assert(approved.decidedByUserId === 10, "approve by");
  assert(approved.assignmentId === 99, "linked assignment");
  assert(approved.decisionNote === "조율 승인", "approve note");

  const rejected = applyRejectDecision({
    decidedByUserId: 10,
    decisionNote: "인원 부족",
  });
  assert(rejected.status === "REJECTED", "reject status");
  assert(rejected.assignmentId === null, "reject no assignment");

  const revoked = applyRevokePreservingApprovalAudit({
    status: "APPROVED",
    decidedAt: approved.decidedAt,
    decidedByUserId: approved.decidedByUserId,
    decisionNote: approved.decisionNote,
    assignmentId: approved.assignmentId,
  });
  assert(revoked.status === "CANCELLED", "revoke → CANCELLED");
  assert(revoked.assignmentId === null, "revoke clears assignment link");
  assert(revoked.decidedAt === approved.decidedAt, "keeps decidedAt");
  assert(revoked.decidedByUserId === 10, "keeps decidedByUserId");
  assert(revoked.decisionNote === "조율 승인", "keeps approval decisionNote");

  let threw = false;
  try {
    applyRevokePreservingApprovalAudit({
      status: "REQUESTED",
      decidedAt: null,
      decidedByUserId: null,
      decisionNote: null,
      assignmentId: null,
    });
  } catch {
    threw = true;
  }
  assert(threw, "revoke from non-APPROVED throws");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
