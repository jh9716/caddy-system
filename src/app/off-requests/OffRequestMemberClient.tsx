"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  consumeUnauthorizedMemberResponse,
} from "@/lib/memberSessionRedirect";
import {
  OFF_REQUEST_LINK_HINT,
  OFF_REQUEST_STATUS_LABELS,
  canCancelOwnOffRequestStatus,
  canDecideOffRequestStatus,
  matchesOffRequestCaddyQuery,
  offRequestStatusLabel,
  offRequestTodayYmd,
  sortOffRequestsPendingFirst,
} from "@/lib/offRequestUi";
type MineRow = {
  id: number;
  date: string;
  status: string;
  note: string | null;
  requestedAt: string;
  decisionNote: string | null;
};

type InboxRow = MineRow & {
  caddy: { id: number; name: string; team: string; teamOrder: number };
};

function readError(data: { message?: string; error?: string } | null): string {
  return data?.message || data?.error || "요청에 실패했습니다.";
}

export default function OffRequestMemberClient({
  linked,
  showInbox,
  managedTeams,
}: {
  linked: boolean;
  showInbox: boolean;
  managedTeams: string[];
}) {
  const [date, setDate] = useState(offRequestTodayYmd);
  const [note, setNote] = useState("");
  const [mine, setMine] = useState<MineRow[]>([]);
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [inboxDate, setInboxDate] = useState(offRequestTodayYmd);
  const [inboxTeam, setInboxTeam] = useState("");
  const [inboxQuery, setInboxQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMine = useCallback(async () => {
    if (!linked) return;
    const res = await fetch("/api/off-requests/mine", {
      credentials: "include",
      cache: "no-store",
    });
    if (consumeUnauthorizedMemberResponse(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readError(data));
    setMine(Array.isArray(data.items) ? data.items : []);
  }, [linked]);

  const loadInbox = useCallback(async () => {
    if (!showInbox) return;
    const params = new URLSearchParams({ date: inboxDate, status: "REQUESTED" });
    if (inboxTeam) params.set("team", inboxTeam);
    const res = await fetch(`/api/off-requests?${params.toString()}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (consumeUnauthorizedMemberResponse(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(readError(data));
    setInbox(Array.isArray(data.items) ? data.items : []);
  }, [showInbox, inboxDate, inboxTeam]);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      await Promise.all([loadMine(), loadInbox()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [loadMine, loadInbox]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch("/api/off-requests", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, note: note.trim() || null }),
      });
      if (consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(readError(data));
      setNote("");
      setNotice("휴무 신청을 접수했습니다.");
      await loadMine();
    } catch (err) {
      setError(err instanceof Error ? err.message : "신청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: number) => {
    if (!window.confirm("이 신청을 취소할까요?")) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/off-requests/${id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      if (consumeUnauthorizedMemberResponse(res)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(readError(data));
      setNotice("신청을 취소했습니다.");
      await loadMine();
    } catch (err) {
      setError(err instanceof Error ? err.message : "취소에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: number, action: "approve" | "reject") => {
    const label = action === "approve" ? "승인" : "거절";
    if (!window.confirm(`이 신청을 ${label}할까요?`)) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/off-requests/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (consumeUnauthorizedMemberResponse(res)) return;
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
          body: JSON.stringify({ confirmOverQuota: true }),
        });
        if (consumeUnauthorizedMemberResponse(retry)) return;
        const retryData = await retry.json().catch(() => ({}));
        if (!retry.ok) throw new Error(readError(retryData));
      } else if (!res.ok) {
        throw new Error(readError(data));
      }
      setNotice(`${label}했습니다.`);
      await Promise.all([loadMine(), loadInbox()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}에 실패했습니다.`);
    } finally {
      setBusy(false);
    }
  };

  const inboxRows = useMemo(
    () =>
      sortOffRequestsPendingFirst(inbox).filter((row) =>
        matchesOffRequestCaddyQuery(row, inboxQuery)
      ),
    [inbox, inboxQuery]
  );

  return (
    <div className="off-page">
      <header className="off-head">
        <h1 className="ui-page-title">휴무 신청</h1>
        <p className="off-sub">날짜를 고르고 신청하면 관리자/조장이 처리합니다.</p>
      </header>

      {error ? (
        <p className="off-alert" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="off-ok" role="status">
          {notice}
        </p>
      ) : null}

      {linked ? (
        <form className="off-card" onSubmit={submit}>
          <label className="off-label">
            휴무 날짜
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="off-label">
            사유 (선택)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={busy}
              placeholder="필요하면 사유를 적어 주세요"
            />
          </label>
          <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
            {busy ? "처리 중…" : "신청하기"}
          </button>
        </form>
      ) : (
        <p className="off-hint">
          {OFF_REQUEST_LINK_HINT}{" "}
          <a href="/caddy/link">본인확인</a>
        </p>
      )}

      <section className="off-section">
        <h2>내 신청</h2>
        {loading ? <p className="off-muted">불러오는 중…</p> : null}
        {!loading && mine.length === 0 ? (
          <p className="off-muted">신청 내역이 없습니다.</p>
        ) : (
          <ul className="off-list">
            {mine.map((row) => (
              <li key={row.id} className="off-item">
                <div className="off-item-top">
                  <span className={`off-badge is-${row.status.toLowerCase()}`}>
                    {offRequestStatusLabel(row.status)}
                  </span>
                  <strong>{row.date}</strong>
                </div>
                {row.note ? <p className="off-note">{row.note}</p> : null}
                {row.decisionNote ? (
                  <p className="off-note">처리 메모 · {row.decisionNote}</p>
                ) : null}
                {canCancelOwnOffRequestStatus(row.status) ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost"
                    disabled={busy}
                    onClick={() => void cancel(row.id)}
                  >
                    취소
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {showInbox ? (
        <section className="off-section">
          <h2>조 신청 처리</h2>
          <p className="off-muted">기존 조장 권한 범위의 대기 신청만 보입니다.</p>
          <div className="off-filters">
            <label className="off-label">
              날짜
              <input
                type="date"
                value={inboxDate}
                onChange={(e) => setInboxDate(e.target.value)}
                disabled={busy}
              />
            </label>
            {managedTeams.length > 0 ? (
              <label className="off-label">
                조
                <select
                  value={inboxTeam}
                  onChange={(e) => setInboxTeam(e.target.value)}
                  disabled={busy}
                >
                  <option value="">관리 조 전체</option>
                  {managedTeams.map((team) => (
                    <option key={team} value={team}>
                      {team}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="off-label">
              캐디
              <input
                type="search"
                value={inboxQuery}
                onChange={(e) => setInboxQuery(e.target.value)}
                placeholder="이름"
              />
            </label>
          </div>
          {inboxRows.length === 0 ? (
            <p className="off-muted">대기 신청이 없습니다.</p>
          ) : (
            <ul className="off-list">
              {inboxRows.map((row) => (
                <li key={row.id} className="off-item">
                  <div className="off-item-top">
                    <span className={`off-badge is-${row.status.toLowerCase()}`}>
                      {offRequestStatusLabel(row.status)}
                    </span>
                    <strong>
                      {row.caddy.name} · {row.caddy.team}
                    </strong>
                  </div>
                  {row.note ? <p className="off-note">{row.note}</p> : null}
                  {canDecideOffRequestStatus(row.status) ? (
                    <div className="off-actions">
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary"
                        disabled={busy}
                        onClick={() => void decide(row.id, "approve")}
                      >
                        승인
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost"
                        disabled={busy}
                        onClick={() => void decide(row.id, "reject")}
                      >
                        거절
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <p className="off-legend">
        상태 · {OFF_REQUEST_STATUS_LABELS.REQUESTED}/
        {OFF_REQUEST_STATUS_LABELS.APPROVED}/
        {OFF_REQUEST_STATUS_LABELS.REJECTED}/
        {OFF_REQUEST_STATUS_LABELS.CANCELLED}
      </p>

      <style>{`
        .off-page { max-width: 720px; padding: 12px 16px 32px; }
        .off-head { margin-bottom: 16px; }
        .off-sub, .off-muted, .off-legend, .off-hint {
          color: var(--vh-muted, #64748b); font-size: 0.9rem;
        }
        .off-card, .off-item {
          border: 1px solid #e5e7eb; border-radius: 12px;
          background: #fff; padding: 14px; margin-bottom: 12px;
        }
        .off-label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-weight: 600; }
        .off-label input, .off-label textarea, .off-label select {
          font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid #d1d5db;
        }
        .off-section { margin-top: 24px; }
        .off-section h2 { font-size: 1.1rem; margin: 0 0 10px; }
        .off-list { list-style: none; margin: 0; padding: 0; }
        .off-item-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .off-badge {
          font-size: 12px; font-weight: 700; border-radius: 999px;
          padding: 2px 8px; background: #e2e8f0;
        }
        .off-badge.is-requested { background: #fde68a; }
        .off-badge.is-approved { background: #bbf7d0; }
        .off-badge.is-rejected { background: #fecaca; }
        .off-badge.is-cancelled { background: #e2e8f0; }
        .off-note { margin: 8px 0; white-space: pre-wrap; }
        .off-actions, .off-filters { display: flex; gap: 8px; flex-wrap: wrap; }
        .off-filters .off-label { flex: 1 1 140px; }
        .off-alert { color: #b91c1c; }
        .off-ok { color: #166534; }
      `}</style>
    </div>
  );
}
