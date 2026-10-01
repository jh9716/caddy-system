/**
 * OffRequest UI helpers. No new auth, no Assignment engine.
 * Status labels map existing OffRequestStatus — there is no pending enum.
 */
import {
  canTransitionOffRequest,
  isOffRequestStatus,
  type OffRequestStatus,
} from "@/lib/offRequestDomain";
import { canManageOffRequests, type OffRequestActor } from "@/lib/offRequestAuth";
import { kstYmd } from "@/lib/kstDate";

export const OFF_REQUEST_MEMBER_PATH = "/off-requests";
export const OFF_REQUEST_ADMIN_PATH = "/manage/off-requests";
export const OFF_REQUEST_LINK_HINT = "캐디 계정 연결 후 휴무를 신청할 수 있습니다.";

export const OFF_REQUEST_STATUS_LABELS: Record<OffRequestStatus, string> = {
  REQUESTED: "대기",
  APPROVED: "승인",
  REJECTED: "거절",
  CANCELLED: "취소",
};

export const OFF_REQUEST_STATUS_FILTERS: Array<OffRequestStatus | ""> = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "",
];

export function offRequestStatusLabel(status: string): string {
  if (isOffRequestStatus(status)) return OFF_REQUEST_STATUS_LABELS[status];
  return status;
}

export function canCancelOwnOffRequestStatus(status: string): boolean {
  return isOffRequestStatus(status) && canTransitionOffRequest(status, "CANCEL");
}

export function canDecideOffRequestStatus(status: string): boolean {
  return (
    isOffRequestStatus(status) &&
    (canTransitionOffRequest(status, "APPROVE") ||
      canTransitionOffRequest(status, "REJECT"))
  );
}

export function offRequestTodayYmd(now: Date = new Date()): string {
  return kstYmd(now);
}

export function sortOffRequestsPendingFirst<
  T extends { status: string; requestedAt?: string; id?: number }
>(rows: T[]): T[] {
  const rank = (status: string) => (status === "REQUESTED" ? 0 : 1);
  return [...rows].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    const at = String(a.requestedAt ?? "");
    const bt = String(b.requestedAt ?? "");
    if (at !== bt) return at.localeCompare(bt);
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

export function matchesOffRequestCaddyQuery(
  row: { caddy?: { name?: string | null; team?: string | null } | null },
  query: string
): boolean {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const name = String(row.caddy?.name ?? "").toLowerCase();
  const team = String(row.caddy?.team ?? "").toLowerCase();
  return name.includes(q) || team.includes(q);
}

export function shouldShowMemberOffRequestForm(actor: Pick<OffRequestActor, "caddyId">): boolean {
  return actor.caddyId != null;
}

export function shouldShowLeaderOffRequestInbox(
  actor: Pick<OffRequestActor, "role" | "managedTeams">
): boolean {
  return canManageOffRequests({
    role: actor.role,
    username: "",
    userId: null,
    caddyId: null,
    managedTeams: actor.managedTeams,
  });
}

/** Hook point for later caddy push after APPROVE/REJECT. No send here. */
export function offRequestDecisionPushReady(input: {
  caddyId: number | null | undefined;
  status: string;
}): boolean {
  return (
    input.caddyId != null &&
    (input.status === "APPROVED" || input.status === "REJECTED")
  );
}
