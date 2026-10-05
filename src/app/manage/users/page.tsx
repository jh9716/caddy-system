"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ADMIN_LINK_STATUS_LABELS,
  buildAdminCaddyLinkRoster,
  canApprovePendingForCaddy,
  filterAdminCaddyLinkRoster,
  groupAdminCaddyLinkRoster,
  isCaddyOccupied,
  summarizeAdminCaddyLinkRoster,
  toSafeRosterCaddy,
  uniqueRosterTeams,
  unlinkedKakaoAccounts,
  type AdminCaddyLinkRow,
  type AdminLinkStatus,
  type RosterCaddy,
  type RosterPending,
  type RosterUser,
} from "@/lib/adminCaddyLinkRoster";
import {
  adminLinkErrorMessage,
  initialAdminSelectedCaddyId,
} from "@/lib/caddyLinkRequestUi";
import { formatCaddyLabel } from "@/lib/caddyDisplay";

type KakaoUserRow = RosterUser & {
  role: string;
  kakaoUserId: string;
  caddy: {
    id: number;
    name: string;
    team: string;
    teamOrder: number;
    employmentStatus: string;
  } | null;
  createdAt?: string;
};

type LinkModal =
  | { kind: "caddy"; caddy: RosterCaddy }
  | { kind: "user"; user: KakaoUserRow }
  | null;

export default function ManageUsersPage() {
  const [users, setUsers] = useState<KakaoUserRow[]>([]);
  const [occupiedCaddyIds, setOccupiedCaddyIds] = useState<number[]>([]);
  const [caddies, setCaddies] = useState<RosterCaddy[]>([]);
  const [pending, setPending] = useState<RosterPending[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedByRequest, setSelectedByRequest] = useState<
    Record<number, number | null>
  >({});
  const [queueBusyId, setQueueBusyId] = useState<number | null>(null);

  const [teamFilter, setTeamFilter] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AdminLinkStatus | "">("");

  const [linkModal, setLinkModal] = useState<LinkModal>(null);
  const [pendingModal, setPendingModal] = useState<{
    req: RosterPending;
    caddy: RosterCaddy;
  } | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedCaddyId, setSelectedCaddyId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    const res = await fetch("/api/users", {
      credentials: "include",
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || data?.error || "계정 목록 조회 실패");
    }
    setUsers(data.users || []);
    setOccupiedCaddyIds(data.occupiedCaddyIds || []);
  }, []);

  const loadCaddies = useCallback(async () => {
    const res = await fetch("/api/caddies?employment=ACTIVE", {
      credentials: "include",
      cache: "no-store",
    });
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      throw new Error(data?.error || "캐디 명단 조회 실패");
    }
    const rows = (Array.isArray(data) ? data : []).map((c: RosterCaddy) =>
      toSafeRosterCaddy(c)
    );
    setCaddies(rows);
  }, []);

  const loadPending = useCallback(async () => {
    const res = await fetch("/api/caddy-link-requests?status=PENDING", {
      credentials: "include",
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        adminLinkErrorMessage(data?.error, data?.message) ||
          "승인 대기 목록 조회 실패"
      );
    }
    const rows: RosterPending[] = Array.isArray(data.requests)
      ? data.requests
      : [];
    setPending(rows);
    const next: Record<number, number | null> = {};
    for (const r of rows) {
      next[r.id] = initialAdminSelectedCaddyId(r.candidates?.length ?? 0);
    }
    setSelectedByRequest(next);
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadCaddies(), loadUsers(), loadPending()]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [loadCaddies, loadPending, loadUsers]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const roster = useMemo(
    () => buildAdminCaddyLinkRoster(caddies, users, pending),
    [caddies, users, pending]
  );
  const summary = useMemo(() => summarizeAdminCaddyLinkRoster(roster), [roster]);
  const teams = useMemo(() => uniqueRosterTeams(caddies), [caddies]);
  const visibleRows = useMemo(
    () =>
      filterAdminCaddyLinkRoster(roster, {
        team: teamFilter,
        nameQuery,
        status: statusFilter,
      }),
    [roster, teamFilter, nameQuery, statusFilter]
  );
  const groupedRows = useMemo(
    () => groupAdminCaddyLinkRoster(visibleRows),
    [visibleRows]
  );
  const orphanUsers = useMemo(() => unlinkedKakaoAccounts(users), [users]);
  const occupiedSet = useMemo(
    () => new Set(occupiedCaddyIds),
    [occupiedCaddyIds]
  );

  const openLinkCaddy = (caddy: RosterCaddy) => {
    if (isCaddyOccupied(caddy.id, occupiedSet)) {
      setError("이미 다른 계정에 연결된 캐디입니다.");
      return;
    }
    setLinkModal({ kind: "caddy", caddy });
    setSelectedUserId(null);
    setSelectedCaddyId(null);
    setPickerQuery("");
    setError(null);
    setMessage(null);
  };

  const openLinkUser = (user: KakaoUserRow) => {
    setLinkModal({ kind: "user", user });
    setSelectedUserId(null);
    setSelectedCaddyId(null);
    setPickerQuery("");
    setError(null);
    setMessage(null);
  };

  const vacantCaddies = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return caddies
      .filter((c) => !isCaddyOccupied(c.id, occupiedSet))
      .filter((c) => {
        if (!q) return true;
        return `${c.name} ${c.team} ${c.teamOrder}`.toLowerCase().includes(q);
      })
      .slice(0, 80);
  }, [caddies, occupiedSet, pickerQuery]);

  const linkableUsers = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return orphanUsers.filter((u) => {
      if (!q) return true;
      return u.username.toLowerCase().includes(q);
    });
  }, [orphanUsers, pickerQuery]);

  const confirmLink = async () => {
    if (!linkModal) return;
    const userId =
      linkModal.kind === "user" ? linkModal.user.id : selectedUserId;
    const caddyId =
      linkModal.kind === "caddy" ? linkModal.caddy.id : selectedCaddyId;
    const user =
      linkModal.kind === "user"
        ? linkModal.user
        : users.find((u) => u.id === userId);
    const caddy =
      linkModal.kind === "caddy"
        ? linkModal.caddy
        : caddies.find((c) => c.id === caddyId);
    if (userId == null || caddyId == null || !user || !caddy) return;
    if (isCaddyOccupied(caddyId, occupiedSet)) {
      setError("이미 다른 계정에 연결된 캐디입니다.");
      return;
    }
    const ok = window.confirm(
      `${user.username} 계정을 아래 캐디와 연결할까요?\n\n` +
        `${formatCaddyLabel(caddy)}\n\n` +
        `연결 후 이 계정으로 해당 캐디의 휴무 신청이 가능해집니다.`
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/link-caddy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caddyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "연결 실패");
      }
      setMessage(`${user.username} ↔ ${formatCaddyLabel(caddy)} 연결 완료`);
      setLinkModal(null);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "연결 실패");
    } finally {
      setBusy(false);
    }
  };

  const confirmUnlink = async (user: RosterUser, caddy: RosterCaddy) => {
    const ok = window.confirm(
      `${user.username} 계정과 캐디 연결을 해제할까요?\n\n` +
        `${formatCaddyLabel(caddy)}\n\n` +
        `해제 후 이 계정은 휴무 신청을 할 수 없습니다.`
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${user.id}/unlink-caddy`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "연결 해제 실패");
      }
      setMessage(`${user.username} 연결 해제 완료`);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "연결 해제 실패");
    } finally {
      setBusy(false);
    }
  };

  const confirmApprove = async (
    req: RosterPending,
    caddy: RosterCaddy
  ): Promise<boolean> => {
    const selectedId = selectedByRequest[req.id];
    if (selectedId == null) {
      setError("승인할 후보 캐디를 선택해 주세요. (자동 승인 없음)");
      return false;
    }
    if (!canApprovePendingForCaddy(req, caddy.id) || selectedId !== caddy.id) {
      setError("선택한 캐디가 후보 목록에 없습니다.");
      return false;
    }
    const ok = window.confirm(
      `본인확인 요청을 승인할까요?\n\n` +
        `계정: ${req.user.username}\n` +
        `제출 이름: ${req.submittedName}\n` +
        `휴대폰: ${req.maskedPhone || "010-****-****"}\n` +
        `연결 캐디: ${formatCaddyLabel(caddy)}\n\n` +
        `승인 시 계정-캐디 연결과 휴대폰번호가 함께 반영됩니다.`
    );
    if (!ok) return false;

    setQueueBusyId(req.id);
    setError(null);
    try {
      const res = await fetch(`/api/caddy-link-requests/${req.id}/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedCaddyId: selectedId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(adminLinkErrorMessage(data?.error, data?.message));
      }
      setMessage(
        `${req.user.username} 요청 승인 · ${formatCaddyLabel(caddy)} 연결 완료`
      );
      await refreshAll();
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "승인 실패");
      try {
        await loadPending();
      } catch {
        /* keep approve error */
      }
      return false;
    } finally {
      setQueueBusyId(null);
    }
  };

  const confirmReject = async (req: RosterPending) => {
    const ok = window.confirm(
      `본인확인 요청을 반려할까요?\n\n` +
        `계정: ${req.user.username}\n` +
        `제출 이름: ${req.submittedName}\n` +
        `휴대폰: ${req.maskedPhone || "010-****-****"}\n\n` +
        `반려 시 계정/캐디 연결은 변경되지 않습니다.`
    );
    if (!ok) return;

    const noteRaw = window.prompt(
      "반려 안내 문구(선택). 직원 화면에 표시될 수 있습니다.",
      ""
    );
    if (noteRaw === null) return;

    setQueueBusyId(req.id);
    setError(null);
    try {
      const res = await fetch(`/api/caddy-link-requests/${req.id}/reject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionNote: noteRaw.trim() ? noteRaw.trim() : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(adminLinkErrorMessage(data?.error, data?.message));
      }
      setMessage(`${req.user.username} 요청 반려 완료`);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "반려 실패");
      try {
        await loadPending();
      } catch {
        /* keep reject error */
      }
    } finally {
      setQueueBusyId(null);
    }
  };

  return (
    <div className="users-page">
      <header className="us-header">
        <div>
          <h1 className="us-title">계정 연결</h1>
          <p className="us-sub">
            ACTIVE 캐디 명단 · 후보 자동 승인 없음 · 이름/번호 자동 연결 없음
          </p>
        </div>
        <button
          type="button"
          className="us-btn us-btn-sm"
          disabled={loading || queueBusyId != null}
          onClick={() => void refreshAll()}
        >
          새로고침
        </button>
      </header>

      {message && <div className="us-banner ok">{message}</div>}
      {error && <div className="us-banner err">{error}</div>}

      <section className="us-summary-line" aria-label="연결 요약">
        <span>전체 <strong>{summary.total}</strong></span>
        <span className="ok">연결됨 <strong>{summary.linked}</strong></span>
        <span className="wait">승인대기 <strong>{summary.pending}</strong></span>
        <span>미연결 <strong>{summary.unlinked}</strong></span>
      </section>

      <section className="us-section us-section-roster">
        <div className="us-section-head">
          <h2 className="us-section-title">
            캐디 명단
            {!loading && <span className="us-count">{visibleRows.length}</span>}
          </h2>
        </div>

        <div className="us-filters">
          <select
            aria-label="조"
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            <option value="">조 전체</option>
            {teams.map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>
          <select
            aria-label="상태"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter((e.target.value || "") as AdminLinkStatus | "")
            }
          >
            <option value="">상태 전체</option>
            <option value="linked">연결됨</option>
            <option value="pending">승인대기</option>
            <option value="unlinked">미연결</option>
          </select>
          <input
            aria-label="이름/계정 검색"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="이름/계정"
          />
        </div>

        {loading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : visibleRows.length === 0 ? (
          <p className="us-empty">조건에 맞는 캐디가 없습니다.</p>
        ) : (
          <div className="us-dense-list">
            {groupedRows.map((group) => (
              <div key={group.team}>
                <div className="us-team-h">{group.team}</div>
                {group.rows.map((row) => (
                  <div key={row.caddy.id} className="us-dense-row">
                    <span className="us-team">{row.caddy.team || "—"}</span>
                    <span className="us-ord">{row.caddy.teamOrder || "—"}</span>
                    <strong className="us-uname">{row.caddy.name}</strong>
                    <StatusPill status={row.status} />
                    <span className="us-acct" title={accountLabel(row)}>
                      {shortAccount(accountLabel(row))}
                    </span>
                    <RowActions
                      row={row}
                      busy={busy}
                      queueBusyId={queueBusyId}
                      onUnlink={confirmUnlink}
                      onManualLink={openLinkCaddy}
                      onOpenPending={(req) => setPendingModal({ req, caddy: row.caddy })}
                      onReject={confirmReject}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="us-section us-section-manual">
        <div className="us-section-head">
          <h2 className="us-section-title">
            캐디와 연결되지 않은 Kakao 계정
            {!loading && <span className="us-count">{orphanUsers.length}</span>}
          </h2>
        </div>
        {loading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : orphanUsers.length === 0 ? (
          <p className="us-empty">캐디와 연결되지 않은 Kakao 계정이 없습니다.</p>
        ) : (
          <div className="us-dense-list">
            {orphanUsers.map((u) => (
              <div key={u.id} className="us-dense-row">
                <strong className="us-uname us-orphan-name">{u.username}</strong>
                <span className="us-status off">미연결</span>
                <span className="us-acct" title={u.kakaoUserId}>
                  {shortAccount(u.kakaoUserId || u.role || "")}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void openLinkUser(u as KakaoUserRow)}
                  className="us-btn us-btn-primary us-btn-xs"
                >
                  연결
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {linkModal && (
        <div
          className="us-modal-overlay"
          onClick={() => !busy && setLinkModal(null)}
        >
          <div className="us-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="us-modal-title">캐디 연결</h2>
            {linkModal.kind === "caddy" ? (
              <>
                <p className="us-sub us-sub-inline">
                  캐디 <strong>{formatCaddyLabel(linkModal.caddy)}</strong> 에
                  연결할 미연결 Kakao 계정을 선택하세요. 이미 다른 계정에
                  연결된 캐디는 연결할 수 없습니다.
                </p>
                <input
                  className="us-input"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="계정 검색"
                />
                <div className="us-modal-list">
                  {linkableUsers.length === 0 ? (
                    <div className="us-muted" style={{ padding: 12 }}>
                      선택 가능한 계정이 없습니다.
                    </div>
                  ) : (
                    linkableUsers.map((u) => {
                      const selected = selectedUserId === u.id;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          className={`us-modal-item${selected ? " is-selected" : ""}`}
                          onClick={() => setSelectedUserId(u.id)}
                        >
                          <strong>{u.username}</strong>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="us-sub us-sub-inline">
                  계정 <strong>{linkModal.user.username}</strong> 에 연결할
                  ACTIVE 캐디를 선택하세요. 이미 다른 계정에 연결된 캐디는
                  목록에 없습니다.
                </p>
                <input
                  className="us-input"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="이름 / 조 검색"
                />
                <div className="us-modal-list">
                  {vacantCaddies.length === 0 ? (
                    <div className="us-muted" style={{ padding: 12 }}>
                      선택 가능한 캐디가 없습니다.
                    </div>
                  ) : (
                    vacantCaddies.map((c) => {
                      const selected = selectedCaddyId === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`us-modal-item${selected ? " is-selected" : ""}`}
                          onClick={() => setSelectedCaddyId(c.id)}
                        >
                          <strong>{formatCaddyLabel(c)}</strong>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
            <div className="us-modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setLinkModal(null)}
                className="us-btn us-btn-sm"
              >
                취소
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  (linkModal.kind === "caddy"
                    ? selectedUserId == null
                    : selectedCaddyId == null)
                }
                onClick={() => void confirmLink()}
                className="us-btn us-btn-primary us-btn-sm"
              >
                {busy ? "처리 중…" : "연결 확인"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingModal && (
        <PendingDetailModal
          req={pendingModal.req}
          caddy={pendingModal.caddy}
          selectedId={selectedByRequest[pendingModal.req.id] ?? null}
          busy={queueBusyId === pendingModal.req.id}
          onClose={() => setPendingModal(null)}
          onSelect={(caddyId) =>
            setSelectedByRequest((prev) => ({
              ...prev,
              [pendingModal.req.id]: caddyId,
            }))
          }
          onApprove={async () => {
            const ok = await confirmApprove(pendingModal.req, pendingModal.caddy);
            if (ok) setPendingModal(null);
          }}
        />
      )}

      <style>{`
        .users-page { max-width: 960px; margin: 0 auto; }
        .us-header {
          display: flex; gap: 8px; justify-content: space-between; align-items: center;
          margin-bottom: 6px;
        }
        .us-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.2rem; font-weight: 700;
          color: var(--vh-green-900); line-height: 1.1;
        }
        .us-sub { margin: 2px 0 0; color: var(--vh-muted); font-size: 0.68rem; }
        .us-sub-inline { margin: 0 0 8px; }
        .us-banner {
          padding: 5px 8px; border-radius: 6px; margin-bottom: 6px; font-size: 0.74rem;
        }
        .us-banner.ok { background: var(--vh-ok-bg); color: var(--vh-ok); }
        .us-banner.err { background: var(--vh-danger-bg); color: var(--vh-danger); }
        .us-summary-line {
          display: flex; flex-wrap: wrap; gap: 8px 12px;
          margin-bottom: 8px; font-size: 0.72rem; color: var(--vh-muted);
        }
        .us-summary-line strong { color: var(--vh-green-900); font-size: 0.86rem; }
        .us-summary-line .ok strong { color: var(--vh-ok); }
        .us-summary-line .wait strong { color: #9a6b12; }
        .us-section { margin-bottom: 10px; }
        .us-section-head { margin-bottom: 6px; }
        .us-section-title {
          margin: 0; font-size: 0.82rem; font-weight: 800; color: var(--vh-green-900);
        }
        .us-count { margin-left: 6px; font-size: 0.72rem; font-weight: 600; color: var(--vh-muted); }
        .us-filters {
          display: grid; grid-template-columns: 72px 78px 1fr; gap: 6px; margin-bottom: 6px;
        }
        .us-filters select, .us-filters input {
          min-height: 32px; padding: 4px 6px; border-radius: 6px;
          border: 1px solid var(--vh-border-strong); background: #fff;
          font-size: 16px; color: var(--vh-ink);
        }
        .us-muted { color: var(--vh-muted); font-size: 0.74rem; }
        .us-empty {
          margin: 0; padding: 8px; border: 1px dashed var(--vh-border-strong);
          border-radius: 6px; color: var(--vh-muted); font-size: 0.74rem;
        }
        .us-dense-list {
          border: 1px solid var(--vh-border); border-radius: 8px; overflow: hidden;
          background: var(--vh-paper);
        }
        .us-team-h {
          padding: 3px 8px; background: var(--vh-green-50);
          color: var(--vh-green-800); font-size: 0.66rem; font-weight: 800;
          letter-spacing: 0.04em;
        }
        .us-dense-row {
          display: grid;
          grid-template-columns: 28px 20px minmax(0, 1fr) auto minmax(0, 0.85fr) auto;
          align-items: center; gap: 4px;
          min-height: 32px; padding: 1px 6px;
          border-top: 1px solid var(--vh-border);
          font-size: 0.74rem;
        }
        .us-team { color: var(--vh-muted); font-size: 0.66rem; font-weight: 700; white-space: nowrap; }
        .us-ord { color: var(--vh-muted); font-variant-numeric: tabular-nums; text-align: right; }
        .us-uname {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-weight: 700; color: var(--vh-green-900);
        }
        .us-orphan-name { grid-column: 1 / 4; }
        .us-acct {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: var(--vh-muted); font-size: 0.68rem;
        }
        .us-row-actions { display: flex; gap: 3px; justify-content: flex-end; }
        .us-cand { display: flex; gap: 6px; align-items: center; font-size: 0.78rem; margin: 8px 0 12px; }
        .us-pending-detail {
          display: grid; gap: 4px; margin: 8px 0; font-size: 0.78rem; color: var(--vh-muted);
        }
        .us-pending-detail strong { color: var(--vh-green-900); }
        .us-btn {
          min-height: 28px; padding: 2px 7px; border-radius: 6px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.68rem; font-weight: 700; cursor: pointer;
          font-family: var(--font-sans); color: var(--vh-ink);
        }
        .us-btn-sm { min-height: 26px; padding: 2px 7px; }
        .us-btn-xs { min-height: 24px; padding: 1px 6px; font-size: 0.66rem; }
        .us-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .us-btn-primary { background: var(--vh-green-900); border-color: var(--vh-green-900); color: #fff; }
        .us-btn-danger { background: #fff; border-color: #e2b4ba; color: var(--vh-danger); }
        .us-status {
          display: inline-flex; padding: 0 6px; border-radius: 999px;
          font-size: 0.62rem; font-weight: 800; line-height: 1.5; white-space: nowrap;
        }
        .us-status.ok { background: var(--vh-ok-bg); color: var(--vh-ok); }
        .us-status.wait { background: #fff4d6; color: #9a6b12; }
        .us-status.off { background: var(--vh-ivory-deep); color: var(--vh-muted); }
        .us-modal-overlay {
          position: fixed; inset: 0; z-index: 60;
          background: rgba(15, 31, 24, 0.48);
          display: flex; align-items: center; justify-content: center; padding: 16px;
        }
        .us-modal {
          width: 100%; max-width: 480px; background: var(--vh-paper);
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius);
          padding: 16px; box-shadow: var(--vh-shadow);
        }
        .us-modal-title {
          margin: 0 0 6px; font-family: var(--font-display-kr);
          font-size: 1.1rem; color: var(--vh-green-900);
        }
        .us-input {
          width: 100%; margin-bottom: 8px; padding: 8px 10px;
          border: 1px solid var(--vh-border-strong); border-radius: 8px;
          font-size: 16px; background: #fff;
        }
        .us-modal-list {
          max-height: 280px; overflow: auto;
          border: 1px solid var(--vh-border); border-radius: 8px; margin-bottom: 10px;
        }
        .us-modal-item {
          display: block; width: 100%; text-align: left; padding: 8px 10px;
          border: 0; border-bottom: 1px solid var(--vh-border);
          background: #fff; cursor: pointer; font-size: 0.8rem;
          font-family: var(--font-sans); color: var(--vh-ink);
        }
        .us-modal-item.is-selected { background: rgba(196, 165, 116, 0.16); }
        .us-modal-actions { display: flex; gap: 6px; justify-content: flex-end; }
      `}</style>
    </div>
  );
}

function accountLabel(row: AdminCaddyLinkRow): string {
  if (row.status === "linked" && row.linkedUser) return row.linkedUser.username;
  if (row.status === "pending" && row.pendingForCaddy[0]) {
    const extra = row.pendingForCaddy.length > 1 ? ` +${row.pendingForCaddy.length - 1}` : "";
    return `${row.pendingForCaddy[0].user.username}${extra}`;
  }
  return "—";
}

function shortAccount(value: string): string {
  const v = value.trim();
  if (!v || v === "—") return "—";
  if (v.length <= 14) return v;
  return `${v.slice(0, 10)}…`;
}

function StatusPill({ status }: { status: AdminLinkStatus }) {
  const tone = status === "linked" ? "ok" : status === "pending" ? "wait" : "off";
  return <span className={`us-status ${tone}`}>{ADMIN_LINK_STATUS_LABELS[status]}</span>;
}

function RowActions({
  row,
  busy,
  queueBusyId,
  onUnlink,
  onManualLink,
  onOpenPending,
  onReject,
}: {
  row: AdminCaddyLinkRow;
  busy: boolean;
  queueBusyId: number | null;
  onUnlink: (user: RosterUser, caddy: RosterCaddy) => void;
  onManualLink: (caddy: RosterCaddy) => void;
  onOpenPending: (req: RosterPending) => void;
  onReject: (req: RosterPending) => void;
}) {
  if (row.status === "linked" && row.linkedUser) {
    return (
      <div className="us-row-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onUnlink(row.linkedUser!, row.caddy)}
          className="us-btn us-btn-danger us-btn-xs"
        >
          해제
        </button>
      </div>
    );
  }

  if (row.status === "pending") {
    const req = row.pendingForCaddy[0];
    if (!req) return null;
    const busyRow = queueBusyId === req.id;
    return (
      <div className="us-row-actions">
        <button
          type="button"
          className="us-btn us-btn-primary us-btn-xs"
          disabled={busyRow}
          onClick={() => onOpenPending(req)}
        >
          승인
        </button>
        <button
          type="button"
          className="us-btn us-btn-danger us-btn-xs"
          disabled={busyRow}
          onClick={() => void onReject(req)}
        >
          반려
        </button>
      </div>
    );
  }

  return (
    <div className="us-row-actions">
      <button
        type="button"
        disabled={busy}
        onClick={() => onManualLink(row.caddy)}
        className="us-btn us-btn-primary us-btn-xs"
      >
        연결
      </button>
    </div>
  );
}

function PendingDetailModal({
  req,
  caddy,
  selectedId,
  busy,
  onClose,
  onSelect,
  onApprove,
}: {
  req: RosterPending;
  caddy: RosterCaddy;
  selectedId: number | null;
  busy: boolean;
  onClose: () => void;
  onSelect: (caddyId: number) => void;
  onApprove: () => void | Promise<void>;
}) {
  const canApprove = canApprovePendingForCaddy(req, caddy.id);
  const selected = selectedId === caddy.id;
  return (
    <div className="us-modal-overlay" onClick={() => !busy && onClose()}>
      <div className="us-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="us-modal-title">승인대기 상세</h2>
        <p className="us-sub us-sub-inline">
          캐디 <strong>{formatCaddyLabel(caddy)}</strong> · 후보 자동 승인 없음
        </p>
        <div className="us-pending-detail">
          <div>계정 <strong>{req.user.username}</strong></div>
          <div>제출 이름 <strong>{req.submittedName}</strong></div>
          <div>휴대폰 <strong>{req.maskedPhone || "010-****-****"}</strong></div>
        </div>
        {canApprove ? (
          <label className="us-cand">
            <input
              type="radio"
              name={`cand-${req.id}`}
              checked={selected}
              disabled={busy}
              onChange={() => onSelect(caddy.id)}
            />
            이 캐디로 승인
          </label>
        ) : (
          <p className="us-muted">이 캐디는 후보가 아닙니다.</p>
        )}
        <div className="us-modal-actions">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="us-btn us-btn-sm"
          >
            닫기
          </button>
          <button
            type="button"
            className="us-btn us-btn-primary us-btn-sm"
            disabled={busy || !canApprove || !selected}
            onClick={() => void onApprove()}
          >
            {busy ? "처리 중…" : "승인"}
          </button>
        </div>
      </div>
    </div>
  );
}
