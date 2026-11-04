/**
 * 캐디/조장 대시보드용 운영 당번·마샬·조장 명단 (READ-ONLY).
 *
 * 관리자 대시보드(/api/manage/dashboard)와 같은 loadAdminOpsDashboardView 결과의
 * opsDuties를 그대로 투영한다. 별도 계산 없음 → 관리자 화면과 결과가 달라질 수 없다.
 * 반환: 역할 라벨, 표시 이름, 인원수만. caddyId·전화번호·계정 정보 없음.
 */
import {
  DAILY_OPS_DUTY_ROLES,
  type DailyOpsDutyRole,
} from "@/lib/dailyOpsDuty";
import {
  OPS_DUTY_DASHBOARD_LABELS,
  type AdminOpsDutyGroup,
} from "@/lib/adminOpsDashboard";
import type { AdminOpsDashboardView } from "@/lib/dailyOpsSnapshot";

export type CaddyOpsRosterGroup = {
  role: DailyOpsDutyRole;
  label: string;
  names: string[];
  count: number;
};

export type CaddyOpsRosterPayload = {
  ok: true;
  date: string;
  /** sheetDerivedReady=false: 관리자 화면의 '확인 중'과 같은 상태 */
  ready: boolean;
  freshness: AdminOpsDashboardView["freshness"];
  sourceAsOf: string | null;
  groups: CaddyOpsRosterGroup[];
};

type ViewSubset = Pick<
  AdminOpsDashboardView,
  "date" | "opsDuties" | "sheetDerivedReady" | "freshness" | "sourceAsOf"
>;

/** 관리자 view → 공개 명단. 5개 역할을 항상 고정 순서로 반환. */
export function toCaddyOpsRoster(view: ViewSubset): CaddyOpsRosterPayload {
  const byRole = new Map<string, AdminOpsDutyGroup>(
    (view.opsDuties ?? []).map((g) => [g.role, g])
  );
  const groups = DAILY_OPS_DUTY_ROLES.map((role) => {
    const names = (byRole.get(role)?.names ?? [])
      .map((n) => String(n ?? "").trim())
      .filter(Boolean);
    return { role, label: OPS_DUTY_DASHBOARD_LABELS[role], names, count: names.length };
  });
  return {
    ok: true,
    date: view.date,
    ready: Boolean(view.sheetDerivedReady),
    freshness: view.freshness,
    sourceAsOf: view.sourceAsOf ?? null,
    groups,
  };
}

export type CaddyOpsRosterRowState = "assigned" | "unassigned" | "pending";

export function caddyOpsRosterRowState(
  group: Pick<CaddyOpsRosterGroup, "count">,
  ready: boolean
): CaddyOpsRosterRowState {
  if (group.count > 0) return "assigned";
  return ready ? "unassigned" : "pending";
}

export function isCaddyOpsRosterPayload(v: unknown): v is CaddyOpsRosterPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.ok === true &&
    typeof o.date === "string" &&
    Array.isArray(o.groups) &&
    o.groups.every(
      (g) =>
        g &&
        typeof g === "object" &&
        typeof (g as CaddyOpsRosterGroup).label === "string" &&
        Array.isArray((g as CaddyOpsRosterGroup).names)
    )
  );
}
