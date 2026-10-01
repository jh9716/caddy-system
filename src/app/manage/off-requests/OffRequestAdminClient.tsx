"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import {
  OFF_REQUEST_STATUS_FILTERS,
  OFF_REQUEST_STATUS_LABELS,
  canDecideOffRequestStatus,
  matchesOffRequestCaddyQuery,
  offRequestStatusLabel,
  offRequestTodayYmd,
  sortOffRequestsPendingFirst,
} from "@/lib/offRequestUi";
import type { OffRequestStatus } from "@/lib/offRequestDomain";

type AdminRow = {
  id: number;
  date: string;
  status: string;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  caddy: { id: number; name: string; team: string; teamOrder: number };
};

type Quota = {
  approvedCount: number;
  requestedCount: number;
  quota: number;
  overQuota: boolean;
};

function readError(data: { message?: string; error?: string } | null): string {
  return data?.message || data?.error || "요청에 실패했습니다.";
}

export default function OffRequestAdminClient() {
  const [date, setDate] = useState(offRequestTodayYmd);
  const [team, setTeam] = useState("");
  const [status, setStatus] = useState<OffRequestStatus | "">("REQUESTED");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AdminRow[]>([]);
  const [quotaByTeam, setQuotaByTeam] = useState<Record<string, Quota>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ date });
      if (team) params.set("team", team);
      if (status) params.set("status", status);
      const res = await fetch(`/api/off-requests?${params.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(readError(data));
      setItems(Array.isArray(data.items) ? data.items : []);
      setQuotaByTeam(data.quotaByTeam && typeof data.quotaByTeam === "object" ? data.quotaByTeam : {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [date, team, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () =>
      sortOffRequestsPendingFirst(items).filter((row) =>
        matchesOffRequestCaddyQuery(row, query)
      ),
    [items, query]
  );

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  const decide = async (id: number, action: "approve" | "reject") => {
    const label = action === "approve" ? "승인" : "거절";
    if (!window.confirm(`이 신청을 ${label}할까요?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/off-requests/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionNote: decisionNote.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.error === "quota_exceeded_confirm_required") {
        const ok = window.confirm(
          "조별 승인 정원을 초과합니다. 그래도 승인할까요?"
        );
        if (!ok) return;
        const retry = await fetch(`/api/off-requests/${id}/approve`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmOverQuota: true,
            decisionNote: decisionNote.trim() || null,
          }),
        });
        const retryData = await retry.json().catch(() => ({}));
        if (!retry.ok) throw new Error(readError(retryData));
      } else if (!res.ok) {
        throw new Error(readError(data));
      }
      setDecisionNote("");
      setNotice(`${label}했습니다.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label}에 실패했습니다.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-page off-admin">
      <header className="pt-head">
        <h1 className="pt-title">휴무 신청</h1>
        <p className="pt-sub">
          대기 신청을 먼저 보고 승인/거절합니다. 조장 처리는 캐디 화면에서
          기존 조 권한으로만 가능합니다.
        </p>
      </header>

      {error ? <p className="off-alert" role="alert">{error}</p> : null}
      {notice ? <p className="off-ok" role="status">{notice}</p> : null}

      <div className="off-filters">
        <label>
          날짜
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          조
          <select value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">전체</option>
            {PRIMARY_TEAMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          상태
          <select
            value={status}
            onChange={(e) => setStatus((e.target.value || "") as OffRequestStatus | "")}
          >
            {OFF_REQUEST_STATUS_FILTERS.map((code) => (
              <option key={code || "all"} value={code}>
                {code ? OFF_REQUEST_STATUS_LABELS[code] : "전체"}
              </option>
            ))}
          </select>
        </label>
        <label>
          캐디
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름 / 조"
          />
        </label>
      </div>

      {Object.keys(quotaByTeam).length > 0 ? (
        <p className="pt-sub">
          정원{" "}
          {Object.entries(quotaByTeam)
            .slice(0, 6)
            .map(([t, q]) => `${t} ${q.approvedCount}/${q.quota}`)
            .join(" · ")}
        </p>
      ) : null}

      {loading ? <p>불러오는 중…</p> : null}

      <div className="off-admin-grid">
        <ul className="off-list">
          {rows.length === 0 && !loading ? (
            <li className="off-empty">해당 조건의 신청이 없습니다.</li>
          ) : null}
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`off-row${selected?.id === row.id ? " is-on" : ""}`}
                onClick={() => setSelectedId(row.id)}
              >
                <span className={`off-badge is-${row.status.toLowerCase()}`}>
                  {offRequestStatusLabel(row.status)}
                </span>
                <span>
                  {row.caddy.name} · {row.caddy.team}
                </span>
                <span className="off-date">{row.date}</span>
              </button>
            </li>
          ))}
        </ul>

        <section className="off-detail">
          {selected ? (
            <>
              <h2>신청 상세</h2>
              <p>
                <strong>{selected.caddy.name}</strong> · {selected.caddy.team}
              </p>
              <p>날짜 {selected.date}</p>
              <p>상태 {offRequestStatusLabel(selected.status)}</p>
              <p>신청 {selected.requestedAt}</p>
              <p>사유 {selected.note || "없음"}</p>
              {selected.decisionNote ? <p>처리 메모 {selected.decisionNote}</p> : null}
              {canDecideOffRequestStatus(selected.status) ? (
                <>
                  <label>
                    처리 메모 (선택)
                    <textarea
                      value={decisionNote}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      rows={3}
                      maxLength={500}
                    />
                  </label>
                  <div className="off-actions">
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary"
                      disabled={busy}
                      onClick={() => void decide(selected.id, "approve")}
                    >
                      승인
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost"
                      disabled={busy}
                      onClick={() => void decide(selected.id, "reject")}
                    >
                      거절
                    </button>
                  </div>
                </>
              ) : (
                <p className="pt-sub">대기 상태가 아니면 승인/거절할 수 없습니다.</p>
              )}
            </>
          ) : (
            <p className="pt-sub">신청을 선택하세요.</p>
          )}
        </section>
      </div>

      <style>{`
        .pt-page { max-width: 1100px; padding-bottom: 24px; }
        .pt-head { margin-bottom: 16px; }
        .pt-title { margin: 0; font-size: 1.35rem; font-weight: 800; color: var(--vh-green-900); }
        .pt-sub { margin: 4px 0 0; font-size: 0.8rem; color: var(--vh-muted); }
        .off-filters { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
        .off-filters label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; min-width: 140px; }
        .off-filters input, .off-filters select, .off-detail textarea {
          font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #d1d5db;
        }
        .off-admin-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
        @media (min-width: 860px) {
          .off-admin-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); }
        }
        .off-list { list-style: none; margin: 0; padding: 0; }
        .off-row {
          width: 100%; text-align: left; display: flex; gap: 8px; align-items: center;
          flex-wrap: wrap; padding: 12px; margin-bottom: 8px; border-radius: 10px;
          border: 1px solid #e5e7eb; background: #fff;
        }
        .off-row.is-on { border-color: #163028; }
        .off-badge { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 2px 8px; background: #e2e8f0; }
        .off-badge.is-requested { background: #fde68a; }
        .off-badge.is-approved { background: #bbf7d0; }
        .off-badge.is-rejected { background: #fecaca; }
        .off-detail {
          border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; background: #fff;
        }
        .off-detail label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
        .off-actions { display: flex; gap: 8px; }
        .off-alert { color: #b91c1c; }
        .off-ok { color: #166534; }
        .off-empty, .off-date { color: #64748b; }
      `}</style>
    </div>
  );
}
