"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DASHBOARD_PENDING_STATUS_LABEL,
  OPS_DUTY_DASHBOARD_LABELS,
  filterDashboardCaddies,
  groupCaddiesByPrimaryTeam,
  type AdminOpsCaddyRow,
  type AdminOpsDutyGroup,
  type AdminOpsTeamGroup,
} from "@/lib/adminOpsDashboard";
import type { AdminOpsDashboardView } from "@/lib/dailyOpsSnapshot";
import { isDashboardSheetFreshPayload } from "@/lib/adminOpsDashboardFreshness";
import { formatCapturedAtKst } from "@/lib/kstDate";
import type { DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import { addDays } from "@/lib/krHolidays";
import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import {
  CLIENT_RESOURCE,
  clearClientResourceCache,
  clientResourceStoreKey,
  ensureClientAuthNamespace,
  peekLastNamespaceResource,
  runDedupedClientResource,
  shouldApplyScopedResponse,
  shouldSkipFreshResourceRefresh,
  writeClientResource,
} from "@/lib/clientResourceCache";
import {
  dashboardUpdatingCopy,
  isCurrentLoadGen,
  isStaleDashboardDate,
  shouldShowDashboardZeroCount,
} from "@/lib/pendingLoad";

type DashboardResponse = AdminOpsDashboardView & { ok?: boolean; error?: string };

export function dashboardSourceLine(
  data: (Pick<
    AdminOpsDashboardView,
    "source" | "snapshotAvailable" | "capturedAt" | "isPastDate" | "sourceQuality"
  > &
    Partial<
      Pick<AdminOpsDashboardView, "freshness" | "sourceAsOf" | "sheetDerivedReady">
    >) | null
): string {
  if (data?.source === "snapshot" && data.capturedAt) {
    return `저장된 운영기록 · ${formatCapturedAtKst(data.capturedAt)} 저장`;
  }
  if (data?.freshness === "error") {
    return data.sourceAsOf
      ? `최신 정보 확인 실패 · ${formatCapturedAtKst(data.sourceAsOf)} 기준 표시`
      : "최신 정보 확인 실패";
  }
  if (data?.freshness === "refreshing" || data?.freshness === "stale") {
    if (data.sourceAsOf) {
      return `선택일 운영현황 · ${formatCapturedAtKst(data.sourceAsOf)} 기준 · 최신 확인 중…`;
    }
    return "선택일 운영현황 · 최신 확인 중…";
  }
  if (data?.isPastDate) {
    return "저장된 과거기록 없음 · 현재 자료 기준 재구성";
  }
  if (data?.sourceQuality === "fallback") {
    return "선택일 운영현황 · 현재 자료 기준 (Sheet 일부 미반영)";
  }
  return "선택일 운영현황 · 현재 운영자료 기준";
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatNames(names: string[], pending = false): string {
  if (names.length === 0) return pending ? DASHBOARD_PENDING_STATUS_LABEL : "없음";
  return names.join(" · ");
}

function dutyGroupOrEmpty(
  groups: readonly AdminOpsDutyGroup[],
  role: DailyOpsDutyRole
): AdminOpsDutyGroup {
  return (
    groups.find((group) => group.role === role) ?? {
      role,
      label: OPS_DUTY_DASHBOARD_LABELS[role],
      names: [],
    }
  );
}

export function OpsDutyCell({
  group,
  pending = false,
}: {
  group: AdminOpsDutyGroup;
  pending?: boolean;
}) {
  return (
    <div className="dash-ops-cell" data-role={group.role} data-pending={pending || undefined}>
      <span className="dash-ops-role">{group.label}</span>
      <span className="dash-ops-names">{formatNames(group.names, pending)}</span>
      <span className="dash-ops-count">
        {pending && group.names.length === 0 ? DASHBOARD_PENDING_STATUS_LABEL : `${group.names.length}명`}
      </span>
    </div>
  );
}

export function AdminOpsDutyBoard({
  groups,
  pending = false,
}: {
  groups: readonly AdminOpsDutyGroup[];
  pending?: boolean;
}) {
  return (
    <div className="dash-ops-board">
      <div className="dash-ops-row">
        <OpsDutyCell group={dutyGroupOrEmpty(groups, "DUTY_AM")} pending={pending} />
        <OpsDutyCell group={dutyGroupOrEmpty(groups, "DUTY_PM")} pending={pending} />
      </div>
      <div className="dash-ops-row">
        <OpsDutyCell group={dutyGroupOrEmpty(groups, "MARSHAL_AM")} pending={pending} />
        <OpsDutyCell group={dutyGroupOrEmpty(groups, "MARSHAL_PM")} pending={pending} />
      </div>
      <div className="dash-ops-row is-single">
        <OpsDutyCell group={dutyGroupOrEmpty(groups, "LEADER")} pending={pending} />
      </div>
    </div>
  );
}

function SummaryCard({
  hint,
  label,
  value,
  lines,
  children,
}: {
  hint: string;
  label: string;
  value: number | string | ReactNode;
  lines?: string[];
  children?: ReactNode;
}) {
  return (
    <article className="dash-kpi-card dash-kpi-stack" data-hint={hint}>
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-value">{value}</div>
      {lines && lines.length > 0 && (
        <div className="dash-kpi-sub">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
      {children}
    </article>
  );
}

export function TeamBoardPerson({ row }: { row: AdminOpsCaddyRow }) {
  const reason = row.reasons[0] || row.statusLabel;
  return (
    <li
      className={`dash-team-person is-${row.statusTone}`}
      data-caddy-id={row.id}
      data-status={row.status}
      data-tone={row.statusTone}
    >
      <span className="dash-team-person-name">{row.name}</span>
      <span className="dash-team-person-reason">{reason}</span>
    </li>
  );
}

export function AdminOpsTeamBoardSkeleton() {
  return (
    <div className="dash-team-board" aria-hidden>
      {PRIMARY_TEAMS.map((team) => (
        <section key={team} className="dash-team-col" data-team={team}>
          <header className="dash-team-col-head">
            <h3 className="dash-team-col-title">{team}</h3>
            <span className="dash-team-col-count">
              <span className="vh-skel vh-skel-line" style={{ width: 18, height: 10, margin: 0 }} />
            </span>
          </header>
          <ul className="dash-team-skel-list">
            <li className="vh-skel vh-skel-line" />
            <li className="vh-skel vh-skel-line" />
            <li className="vh-skel vh-skel-line" />
          </ul>
        </section>
      ))}
    </div>
  );
}

export function AdminOpsTeamBoard({
  groups,
}: {
  groups: readonly AdminOpsTeamGroup[];
}) {
  if (groups.length === 0) {
    return <p className="dash-empty">표시할 캐디가 없습니다.</p>;
  }
  return (
    <div className="dash-team-board">
      {groups.map((group) => (
        <section
          key={group.team}
          className="dash-team-col"
          data-team={group.team}
        >
          <header className="dash-team-col-head">
            <h3 className="dash-team-col-title">{group.team}</h3>
            <span className="dash-team-col-count">{group.rows.length}</span>
          </header>
          {group.rows.length === 0 ? (
            <p className="dash-team-empty">—</p>
          ) : (
            <ul className="dash-team-list">
              {group.rows.map((row) => (
                <TeamBoardPerson key={row.id} row={row} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function fetchDashboard(ymd: string, refresh = false): Promise<Response> {
  const qs = refresh
    ? `date=${encodeURIComponent(ymd)}&refresh=1`
    : `date=${encodeURIComponent(ymd)}`;
  return fetch(`/api/manage/dashboard?${qs}`, {
    cache: "no-store",
    credentials: "include",
    method: "GET",
  });
}

export default function AdminOpsDashboard() {
  const [date, setDate] = useState(todayYmd);
  const [data, setData] = useState<AdminOpsDashboardView | null>(() => {
    const ymd = todayYmd();
    return (
      peekLastNamespaceResource<DashboardResponse>(
        CLIENT_RESOURCE.DASHBOARD,
        ymd,
        (value) => value.date === ymd
      )?.value ?? null
    );
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const loadGen = useRef(0);
  const sheetReady = Boolean(data && data.date === date && data.sheetDerivedReady);
  const initial = loading && !data;
  const staleDate = isStaleDashboardDate(data?.date, date);
  const updatingCopy = dashboardUpdatingCopy({
    loading,
    hasData: Boolean(data),
    staleDate,
    error: Boolean(error),
    freshness: staleDate ? undefined : data?.freshness,
  });

  const load = useCallback(async (ymd: string) => {
    const gen = ++loadGen.current;
    const cached = peekLastNamespaceResource<DashboardResponse>(
      CLIENT_RESOURCE.DASHBOARD,
      ymd,
      (value) => value.date === ymd
    );
    if (cached) {
      setData(cached.value);
      setError(null);
    }
    setLoading(true);
    if (!cached) setError(null);
    let painted = Boolean(cached);
    const ns = await ensureClientAuthNamespace();
    if (!isCurrentLoadGen(gen, loadGen.current)) return;
    if (
      shouldSkipFreshResourceRefresh(cached) &&
      isDashboardSheetFreshPayload(cached?.value) &&
      ns
    ) {
      setLoading(false);
      return;
    }
    const apply = async (res: Response): Promise<DashboardResponse | null> => {
      if (!isCurrentLoadGen(gen, loadGen.current)) return null;
      if (res.status === 401 || res.status === 403) {
        clearClientResourceCache();
        location.href = "/login?callbackUrl=/manage";
        return null;
      }
      const json = (await res.json()) as DashboardResponse;
      if (
        !shouldApplyScopedResponse({
          requestGen: gen,
          latestGen: loadGen.current,
          selectedKey: ymd,
          responseKey: typeof json.date === "string" ? json.date : "",
        })
      ) {
        return null;
      }
      return json;
    };
    try {
      const fastRes = await runDedupedClientResource(
        ns
          ? clientResourceStoreKey(ns, CLIENT_RESOURCE.DASHBOARD, ymd)
          : `anon::dashboard::${ymd}`,
        () => fetchDashboard(ymd, false)
      );
      const fast = await apply(fastRes);
      if (!fast) return;
      if (!fastRes.ok) {
        setError(fast.error || "불러오기 실패");
        return;
      }
      setData(fast);
      painted = true;
      setError(fast.freshness === "error" ? "최신 정보 확인 실패" : null);
      setLoading(false);
      if (ns && isDashboardSheetFreshPayload(fast)) {
        writeClientResource(ns, CLIENT_RESOURCE.DASHBOARD, ymd, fast);
      }
      if (isDashboardSheetFreshPayload(fast)) return;

      const refreshRes = await runDedupedClientResource(
        ns
          ? `${clientResourceStoreKey(ns, CLIENT_RESOURCE.DASHBOARD, ymd)}::refresh`
          : `anon::dashboard::${ymd}::refresh`,
        () => fetchDashboard(ymd, true)
      );
      const refreshed = await apply(refreshRes);
      if (!refreshed) return;
      if (!refreshRes.ok) {
        setError(refreshed.error || "최신 정보 확인 실패");
        return;
      }
      setData(refreshed);
      setError(refreshed.freshness === "error" ? "최신 정보 확인 실패" : null);
      if (ns && isDashboardSheetFreshPayload(refreshed)) {
        writeClientResource(ns, CLIENT_RESOURCE.DASHBOARD, ymd, refreshed);
      }
    } catch {
      if (!isCurrentLoadGen(gen, loadGen.current)) return;
      setError(painted ? "최신 정보 확인 실패" : "대시보드 조회 실패");
    } finally {
      if (isCurrentLoadGen(gen, loadGen.current)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const visible = useMemo(
    () => (data ? filterDashboardCaddies(data.caddies, query) : []),
    [data, query]
  );
  const teamGroups = useMemo(() => groupCaddiesByPrimaryTeam(visible), [visible]);

  return (
    <div
      className="dash ops-dash"
      aria-busy={initial || undefined}
      data-date={date}
      data-resource-cache={data?.date === date ? "ready" : "empty"}
      data-freshness={data?.date === date ? data.freshness : undefined}
      data-sheet-ready={sheetReady ? "1" : "0"}
    >
      <div className="dash-scenic" aria-hidden>
        <div
          className="dash-scenic-img"
          style={{ backgroundImage: "url(/brand/strip-course.jpg)" }}
        />
        <div className="dash-scenic-veil" />
      </div>

      <header className="dash-top">
        <div>
          <h1 className="dash-title">관리자 대시보드</h1>
          <p className="dash-date">{dashboardSourceLine(data)}</p>
        </div>
        <div className="dash-date-nav" role="group" aria-label="날짜 선택">
          <button
            type="button"
            className="dash-date-btn"
            onClick={() => setDate((d) => addDays(d, -1))}
            aria-label="이전 날짜"
          >
            이전
          </button>
          <input
            type="date"
            className="dash-date-input"
            value={date}
            onChange={(e) => {
              const next = e.target.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(next)) setDate(next);
            }}
            aria-label="운영일"
          />
          <button
            type="button"
            className="dash-date-btn"
            onClick={() => setDate((d) => addDays(d, 1))}
            aria-label="다음 날짜"
          >
            다음
          </button>
          <button
            type="button"
            className="dash-date-btn"
            onClick={() => setDate(todayYmd())}
          >
            오늘
          </button>
        </div>
      </header>

      {error && <p className="dash-error">{error}</p>}

      <section className="dash-kpi dash-kpi-ops" aria-label="선택일 요약">
        <SummaryCard
          hint="people"
          label="재직 캐디"
          value={
            initial ? (
              <span className="vh-skel vh-skel-kpi" />
            ) : (
              data?.roster.activeCount ?? "—"
            )
          }
          lines={
            data
              ? [`하우스 ${data.roster.houseCount} · 3부반 ${data.roster.thirdCount}`]
              : undefined
          }
        />
        <SummaryCard
          hint="available"
          label="해당일 가용 캐디"
          value={
            initial ? (
              <span className="vh-skel vh-skel-kpi" />
            ) : sheetReady ? (
              data?.availability.finalAvailable ?? "—"
            ) : (
              "—"
            )
          }
          lines={
            data && sheetReady
              ? [
                  `하우스 가용 ${data.availability.houseAvailable} · 3부반 가용 ${data.availability.thirdAvailable}`,
                ]
              : data
                ? [`하우스 가용 ${DASHBOARD_PENDING_STATUS_LABEL} · 3부반 가용 ${DASHBOARD_PENDING_STATUS_LABEL}`]
                : undefined
          }
        />
        <SummaryCard
          hint="off"
          label="휴무"
          value={
            initial ? (
              <span className="vh-skel vh-skel-kpi" />
            ) : sheetReady ? (
              data?.availability.offCount ?? "—"
            ) : (
              "—"
            )
          }
        >
          {sheetReady && data && data.availability.reasonCounts.length > 0 && (
            <div className="dash-reason-strip">
              {data.availability.reasonCounts.map((item) => (
                <span key={item.reason} className="dash-reason-chip">
                  {item.reason} {item.count}
                </span>
              ))}
            </div>
          )}
        </SummaryCard>
      </section>

      {updatingCopy ? <p className="dash-updating">{updatingCopy}</p> : null}

      <section className="dash-duty" aria-label="운영 당번·마샬·조장">
        <h2 className="dash-duty-title">운영 당번 · 마샬 · 조장</h2>
        {initial ? (
          <div className="dash-ops-board" aria-hidden>
            <div className="vh-skel vh-skel-block" style={{ height: 120, marginTop: 0 }} />
          </div>
        ) : data ? (
          <AdminOpsDutyBoard groups={data.opsDuties} pending={!sheetReady} />
        ) : null}
      </section>

      <section className="dash-caddies" aria-label="조별 캐디 현황">
        <div className="dash-glance-head">
          <h2 className="dash-duty-title">
            조별 캐디 현황{" "}
            {shouldShowDashboardZeroCount(Boolean(data)) ? (
              <span className="dash-caddy-count">{visible.length}</span>
            ) : (
              <span className="dash-caddy-count" aria-hidden>
                <span className="vh-skel vh-skel-line" style={{ width: 28, height: 14, margin: 0 }} />
              </span>
            )}
          </h2>
          <input
            type="search"
            className="dash-caddy-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="캐디 이름 검색"
            aria-label="캐디 이름 검색"
          />
        </div>
        {initial ? (
          <AdminOpsTeamBoardSkeleton />
        ) : data ? (
          <AdminOpsTeamBoard groups={teamGroups} />
        ) : null}
      </section>

      <p className="dash-footnote">
        과거 날짜도 현재 재직 명단·저장된 휴무/당번으로 재구성합니다. 당시 스냅샷 저장은
        다음 단계에서 제공합니다.
      </p>
    </div>
  );
}
