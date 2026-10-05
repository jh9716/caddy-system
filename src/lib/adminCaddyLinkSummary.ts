/**
 * 대시보드용 ACTIVE 캐디 계정 연결 요약.
 * 승인/연결 규칙을 바꾸지 않고 User.caddyId + PENDING 후보만 조합한다.
 */

export const DASHBOARD_ACCOUNT_LINK_STATUSES = [
  "LINKED",
  "PENDING",
  "UNLINKED",
] as const;

export type DashboardAccountLinkStatus =
  (typeof DASHBOARD_ACCOUNT_LINK_STATUSES)[number];

export type DashboardAccountLinkEntry = {
  status: DashboardAccountLinkStatus;
  username?: string;
};

export type DashboardAccountLinkSummary = {
  byCaddyId: Record<string, DashboardAccountLinkEntry>;
};

export const DASHBOARD_ACCOUNT_LINK_SUMMARY_PATH =
  "/api/manage/account-link-summary";

export const DASHBOARD_ACCOUNT_LINK_LABELS: Record<
  DashboardAccountLinkStatus,
  string
> = {
  LINKED: "연결됨",
  PENDING: "승인대기",
  UNLINKED: "미연결",
};

export type LinkedCaddyAccountRow = {
  caddyId: number | null;
  username: string;
};

export type PendingCaddyAccountRow = {
  candidateCaddyIds: readonly number[];
  username: string;
};

export function buildDashboardAccountLinkSummary(input: {
  activeCaddyIds: readonly number[];
  linked: readonly LinkedCaddyAccountRow[];
  pending: readonly PendingCaddyAccountRow[];
}): DashboardAccountLinkSummary {
  const linkedBy = new Map<number, string>();
  for (const row of input.linked) {
    if (row.caddyId == null) continue;
    if (!linkedBy.has(row.caddyId)) linkedBy.set(row.caddyId, row.username);
  }

  const pendingBy = new Map<number, string>();
  for (const req of input.pending) {
    for (const id of req.candidateCaddyIds) {
      if (!pendingBy.has(id)) pendingBy.set(id, req.username);
    }
  }

  const byCaddyId: Record<string, DashboardAccountLinkEntry> = {};
  for (const id of input.activeCaddyIds) {
    const linkedUser = linkedBy.get(id);
    if (linkedUser) {
      byCaddyId[String(id)] = { status: "LINKED", username: linkedUser };
      continue;
    }
    const pendingUser = pendingBy.get(id);
    if (pendingUser) {
      byCaddyId[String(id)] = { status: "PENDING", username: pendingUser };
      continue;
    }
    byCaddyId[String(id)] = { status: "UNLINKED" };
  }
  return { byCaddyId };
}

export function accountLinkEntryForCaddy(
  summary: DashboardAccountLinkSummary | null | undefined,
  caddyId: number
): DashboardAccountLinkEntry | null {
  if (!summary) return null;
  return summary.byCaddyId[String(caddyId)] ?? null;
}

export function compactAccountLinkMark(
  status: DashboardAccountLinkStatus
): string {
  if (status === "LINKED") return "🔗";
  if (status === "PENDING") return "대기";
  return "미";
}
