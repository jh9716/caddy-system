"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  filterDashboardCaddies,
  groupCaddiesByPrimaryTeam,
  type AdminOpsCaddyRow,
  type AdminOpsDashboardPayload,
  type AdminOpsDutyGroup,
  type AdminOpsTeamGroup,
} from "@/lib/adminOpsDashboard";
import { addDays } from "@/lib/krHolidays";

type DashboardResponse = AdminOpsDashboardPayload & { ok?: boolean; error?: string };

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatNames(names: string[]): string {
  if (names.length === 0) return "없음";
  return names.join(" · ");
}

function DutyCard({ group }: { group: AdminOpsDutyGroup }) {
  return (
    <article className="dash-duty-card" data-role={group.role}>
      <div className="dash-duty-label">{group.label}</div>
      <div className="dash-duty-count">{group.names.length}명</div>
      <div className="dash-duty-names">{formatNames(group.names)}</div>
    </article>
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
  value: number | string;
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

export default function AdminOpsDashboard() {
  const [date, setDate] = useState(todayYmd);
  const [data, setData] = useState<AdminOpsDashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async (ymd: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/manage/dashboard?date=${encodeURIComponent(ymd)}`, {
        cache: "no-store",
        credentials: "include",
        method: "GET",
      });
      if (res.status === 401 || res.status === 403) {
        location.href = "/login?callbackUrl=/manage";
        return;
      }
      const json = (await res.json()) as DashboardResponse;
      if (!res.ok) {
        setError(json?.error || "불러오기 실패");
        setData(null);
        return;
      }
      setData(json);
    } catch {
      setError("대시보드 조회 실패");
      setData(null);
    } finally {
      setLoading(false);
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
    <div className="dash ops-dash" aria-busy={loading || undefined} data-date={date}>
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
          <p className="dash-date">선택일 운영현황 · 현재 DB 기준 재구성</p>
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
          value={data?.roster.activeCount ?? "—"}
          lines={
            data
              ? [
                  `하우스 ${data.roster.houseCount}명`,
                  `3부반 ${data.roster.thirdCount}명`,
                ]
              : undefined
          }
        />
        <SummaryCard
          hint="available"
          label="해당일 가용 캐디"
          value={data?.availability.finalAvailable ?? "—"}
          lines={
            data
              ? [
                  `하우스 가용 ${data.availability.houseAvailable}명`,
                  `3부반 가용 ${data.availability.thirdAvailable}명`,
                ]
              : undefined
          }
        />
        <SummaryCard
          hint="off"
          label="휴무"
          value={data?.availability.offCount ?? "—"}
        >
          {data && data.availability.reasonCounts.length > 0 && (
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

      <section className="dash-duty" aria-label="운영 당번·마샬·조장">
        <h2 className="dash-duty-title">운영 당번 · 마샬 · 조장</h2>
        <div className="dash-duty-grid">
          {(data?.opsDuties ?? []).map((group) => (
            <DutyCard key={group.role} group={group} />
          ))}
        </div>
      </section>

      <section className="dash-caddies" aria-label="조별 캐디 현황">
        <div className="dash-glance-head">
          <h2 className="dash-duty-title">
            조별 캐디 현황{" "}
            <span className="dash-caddy-count">{visible.length}</span>
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
        {loading && !data ? (
          <p className="dash-empty">불러오는 중…</p>
        ) : (
          <AdminOpsTeamBoard groups={teamGroups} />
        )}
      </section>

      <p className="dash-footnote">
        과거 날짜도 현재 재직 명단·저장된 휴무/당번으로 재구성합니다. 당시 스냅샷 저장은
        다음 단계에서 제공합니다.
      </p>
    </div>
  );
}
