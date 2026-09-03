"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  filterDashboardCaddies,
  type AdminOpsCaddyRow,
  type AdminOpsDashboardPayload,
  type AdminOpsDutyGroup,
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

export function CaddyCard({ row }: { row: AdminOpsCaddyRow }) {
  return (
    <article
      className={`dash-caddy-card is-${row.status}`}
      data-caddy-id={row.id}
      data-status={row.status}
    >
      <div className="dash-caddy-top">
        <strong className="dash-caddy-name">{row.name}</strong>
        <span className={`dash-caddy-badge is-${row.status}`}>{row.statusLabel}</span>
      </div>
      <div className="dash-caddy-meta">
        {row.team} · {row.caddyTypeLabel}
      </div>
      {row.reasons.length > 0 && (
        <div className="dash-caddy-reason">{row.reasons.join(" · ")}</div>
      )}
    </article>
  );
}

export function AdminOpsCaddyGrid({
  rows,
}: {
  rows: readonly AdminOpsCaddyRow[];
}) {
  if (rows.length === 0) {
    return <p className="dash-empty">표시할 캐디가 없습니다.</p>;
  }
  return (
    <div className="dash-caddy-grid">
      {rows.map((row) => (
        <CaddyCard key={row.id} row={row} />
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

  const kpi = data
    ? [
        { label: "재직 캐디", value: data.roster.activeCount, hint: "people" },
        { label: "HOUSE", value: data.roster.houseCount, hint: "house" },
        { label: "3부반", value: data.roster.thirdCount, hint: "third" },
        { label: "최종 가용", value: data.availability.finalAvailable, hint: "available" },
        { label: "휴무", value: data.availability.offCount, hint: "off" },
      ]
    : [
        { label: "재직 캐디", value: "—", hint: "people" },
        { label: "HOUSE", value: "—", hint: "house" },
        { label: "3부반", value: "—", hint: "third" },
        { label: "최종 가용", value: "—", hint: "available" },
        { label: "휴무", value: "—", hint: "off" },
      ];

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
        {kpi.map((k) => (
          <article key={k.label} className="dash-kpi-card" data-hint={k.hint}>
            <div className="dash-kpi-label">{k.label}</div>
            <div className="dash-kpi-value">{k.value}</div>
          </article>
        ))}
      </section>

      {data && data.availability.reasonCounts.length > 0 && (
        <section className="dash-reason-strip" aria-label="제외 사유">
          {data.availability.reasonCounts.map((item) => (
            <span key={item.reason} className="dash-reason-chip">
              {item.reason} {item.count}
            </span>
          ))}
        </section>
      )}

      <section className="dash-duty" aria-label="운영 당번·마샬·조장">
        <h2 className="dash-glance-title">운영 당번 · 마샬 · 조장</h2>
        <div className="dash-duty-grid">
          {(data?.opsDuties ?? []).map((group) => (
            <DutyCard key={group.role} group={group} />
          ))}
        </div>
      </section>

      <section className="dash-caddies" aria-label="전체 캐디 가용현황">
        <div className="dash-glance-head">
          <h2 className="dash-glance-title">
            전체 캐디 가용현황{" "}
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
          <AdminOpsCaddyGrid rows={visible} />
        )}
      </section>

      <p className="dash-footnote">
        과거 날짜도 현재 재직 명단·저장된 휴무/당번으로 재구성합니다. 당시 스냅샷 저장은
        다음 단계에서 제공합니다.
      </p>
    </div>
  );
}
