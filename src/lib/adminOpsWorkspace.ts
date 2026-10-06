/**
 * 대시보드 운영 화면 탭. /manage?view=status|availability
 * 가용 계산·계정 연결 규칙은 바꾸지 않는다.
 */

export const OPS_WORKSPACE_VIEWS = ["status", "availability"] as const;

export type OpsWorkspaceView = (typeof OPS_WORKSPACE_VIEWS)[number];

export const OPS_WORKSPACE_VIEW_QUERY = "view";
export const OPS_WORKSPACE_DATE_QUERY = "date";
export const OPS_WORKSPACE_STATUS_PATH = "/manage";
export const OPS_WORKSPACE_AVAILABILITY_PATH = "/manage/availability";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function parseOpsWorkspaceView(
  raw: string | null | undefined
): OpsWorkspaceView {
  return raw === "availability" ? "availability" : "status";
}

export function parseOpsWorkspaceDate(
  raw: string | null | undefined
): string | null {
  if (!raw || !YMD.test(raw)) return null;
  return raw;
}

export function opsWorkspaceHref(
  view: OpsWorkspaceView,
  date?: string | null
): string {
  const qs = new URLSearchParams();
  if (view === "availability") qs.set(OPS_WORKSPACE_VIEW_QUERY, "availability");
  else if (view === "status") qs.set(OPS_WORKSPACE_VIEW_QUERY, "status");
  const ymd = parseOpsWorkspaceDate(date ?? null);
  if (ymd) qs.set(OPS_WORKSPACE_DATE_QUERY, ymd);
  const q = qs.toString();
  return q ? `${OPS_WORKSPACE_STATUS_PATH}?${q}` : OPS_WORKSPACE_STATUS_PATH;
}

export function availabilityStandaloneHref(date?: string | null): string {
  const ymd = parseOpsWorkspaceDate(date ?? null);
  if (!ymd) return OPS_WORKSPACE_AVAILABILITY_PATH;
  return `${OPS_WORKSPACE_AVAILABILITY_PATH}?${OPS_WORKSPACE_DATE_QUERY}=${ymd}`;
}
