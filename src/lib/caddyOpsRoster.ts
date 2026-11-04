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
  /**
   * 관리자 '선택일 요약' 카드와 같은 값. 관리자 화면과 같은 규칙:
   * 재직은 항상, 가용·휴무는 sheetDerivedReady일 때만 (아니면 null = 확인 중).
   * 병가·장기병가는 제공하지 않음 (실데이터 기준 검증 전).
   */
  stats: {
    activeCount: number | null;
    finalAvailable: number | null;
    offCount: number | null;
  };
  groups: CaddyOpsRosterGroup[];
};

type ViewSubset = Pick<
  AdminOpsDashboardView,
  "date" | "opsDuties" | "sheetDerivedReady" | "freshness" | "sourceAsOf"
> & {
  roster?: Pick<AdminOpsDashboardView["roster"], "activeCount">;
  availability?: Pick<AdminOpsDashboardView["availability"], "finalAvailable" | "offCount">;
};

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
  const ready = Boolean(view.sheetDerivedReady);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ok: true,
    date: view.date,
    ready,
    stats: {
      activeCount: num(view.roster?.activeCount),
      finalAvailable: ready ? num(view.availability?.finalAvailable) : null,
      offCount: ready ? num(view.availability?.offCount) : null,
    },
    freshness: view.freshness,
    sourceAsOf: view.sourceAsOf ?? null,
    groups,
  };
}

export type CaddyOpsRosterRowState = "assigned" | "unassigned" | "pending" | "unknown";

/**
 * 화면 전체 상태.
 * - loading: 첫 응답 전 (조회 진행 중)
 * - failed: 표시할 응답 없음 (조회 실패)
 * - ok: ready && freshness=fresh (정상 조회 완료)
 * - refreshing: 응답은 있으나 최신 확인 요청 진행 중
 * - refresh_failed: 최신 확인이 끝났는데 fresh가 아님(HTTP 200 + error/stale/refreshing 포함) 또는 요청 실패
 *   → 이전 데이터는 '갱신 실패 · 기준 시각'으로만 표시, 최신처럼 보이지 않게.
 */
export type CaddyOpsDisplayState = "loading" | "failed" | "ok" | "refreshing" | "refresh_failed";

export function caddyOpsDisplayState(
  data: Pick<CaddyOpsRosterPayload, "ready" | "freshness"> | null,
  flags: { inFlight: boolean; requestFailed: boolean }
): CaddyOpsDisplayState {
  if (!data) return flags.requestFailed && !flags.inFlight ? "failed" : "loading";
  if (data.ready && data.freshness === "fresh" && !flags.requestFailed) return "ok";
  if (flags.inFlight) return "refreshing";
  return "refresh_failed";
}

export function caddyOpsRowState(
  group: Pick<CaddyOpsRosterGroup, "count">,
  data: Pick<CaddyOpsRosterPayload, "ready">,
  display: CaddyOpsDisplayState
): CaddyOpsRosterRowState {
  if (group.count > 0) return "assigned";
  if (display === "ok") return "unassigned";
  if (display === "refreshing" || display === "loading") return "pending";
  // refresh_failed: 이전 성공 데이터(ready)면 그 기준의 미배정, 아니면 확인 불가
  return data.ready ? "unassigned" : "unknown";
}

/** 통계 값 문구. null(미준비)은 상태에 따라 확인 중 / 갱신 실패. */
export function caddyOpsStatText(
  v: number | null | undefined,
  display: CaddyOpsDisplayState
): string {
  if (display === "failed") return "조회 실패";
  if (typeof v === "number") return `${v}명`;
  return display === "refresh_failed" ? "갱신 실패" : "확인 중";
}

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
    !!o.stats &&
    typeof o.stats === "object" &&
    "activeCount" in (o.stats as Record<string, unknown>) &&
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
