"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ADMIN_LINK_STATUS_LABELS,
  buildAdminCaddyLinkRoster,
  canApprovePendingForCaddy,
  filterAdminCaddyLinkRoster,
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

  const confirmApprove = async (req: RosterPending, caddy: RosterCaddy) => {
    const selectedId = selectedByRequest[req.id];
    if (selectedId == null) {
      setError("승인할 후보 캐디를 선택해 주세요. (자동 승인 없음)");
      return;
    }
    if (!canApprovePendingForCaddy(req, caddy.id) || selectedId !== caddy.id) {
      setError("선택한 캐디가 후보 목록에 없습니다.");
      return;
    }
    const ok = window.confirm(
      `본인확인 요청을 승인할까요?\n\n` +
        `계정: ${req.user.username}\n` +
        `제출 이름: ${req.submittedName}\n` +
        `휴대폰: ${req.maskedPhone || "010-****-****"}\n` +
        `연결 캐디: ${formatCaddyLabel(caddy)}\n\n` +
        `승인 시 계정-캐디 연결과 휴대폰번호가 함께 반영됩니다.`
    );
    if (!ok) return;

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "승인 실패");
      try {
        await loadPending();
      } catch {
        /* keep approve error */
      }
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
            ACTIVE 캐디 명단을 기준으로 연결 상태를 관리합니다. (후보 자동 승인
            없음 · 이름/번호 자동 연결 없음)
          </p>
        </div>
        <button
          type="button"
          className="us-btn"
          disabled={loading || queueBusyId != null}
          onClick={() => void refreshAll()}
        >
          전체 새로고침
        </button>
      </header>

      {message && <div className="us-banner ok">{message}</div>}
      {error && <div className="us-banner err">{error}</div>}

      <section className="us-summary" aria-label="연결 요약">
        <SummaryChip label="전체" value={summary.total} />
        <SummaryChip label="연결됨" value={summary.linked} tone="ok" />
        <SummaryChip label="승인대기" value={summary.pending} tone="wait" />
        <SummaryChip label="미연결" value={summary.unlinked} />
      </section>

      <section className="us-section us-section-roster">
        <div className="us-section-head">
          <div>
            <div className="us-eyebrow">캐디 명단</div>
            <h2 className="us-section-title">
              계정 연결 관리
              {!loading && <span className="us-count">{visibleRows.length}명</span>}
            </h2>
          </div>
        </div>

        <div className="us-filters">
          <label className="us-filter">
            <span>조</span>
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
            >
              <option value="">전체</option>
              {teams.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
          </label>
          <label className="us-filter us-filter-grow">
            <span>이름</span>
            <input
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="캐디 / 계정 검색"
            />
          </label>
          <label className="us-filter">
            <span>상태</span>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter((e.target.value || "") as AdminLinkStatus | "")
              }
            >
              <option value="">전체</option>
              <option value="linked">연결됨</option>
              <option value="pending">승인대기</option>
              <option value="unlinked">미연결</option>
            </select>
          </label>
        </div>

        {loading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : visibleRows.length === 0 ? (
          <p className="us-empty">조건에 맞는 캐디가 없습니다.</p>
        ) : (
          <>
            <div className="us-table-wrap us-manual-pc">
              <table className="us-table">
                <thead>
                  <tr>
                    <th>조</th>
                    <th>순번</th>
                    <th>캐디</th>
                    <th>상태</th>
                    <th>연결 계정</th>
                    <th>승인대기</th>
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.caddy.id}>
                      <td>{row.caddy.team || "—"}</td>
                      <td>{row.caddy.teamOrder || "—"}</td>
                      <td className="us-uname">{row.caddy.name}</td>
                      <td>
                        <StatusPill status={row.status} />
                      </td>
                      <td>
                        {row.linkedUser ? (
                          row.linkedUser.username
                        ) : (
                          <span className="us-muted">—</span>
                        )}
                      </td>
                      <td>
                        <PendingCell row={row} />
                      </td>
                      <td>
                        <RowActions
                          row={row}
                          busy={busy}
                          queueBusyId={queueBusyId}
                          selectedByRequest={selectedByRequest}
                          onSelect={(requestId, caddyId) =>
                            setSelectedByRequest((prev) => ({
                              ...prev,
                              [requestId]: caddyId,
                            }))
                          }
                          onApprove={confirmApprove}
                          onReject={confirmReject}
                          onUnlink={confirmUnlink}
                          onManualLink={openLinkCaddy}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="us-manual-mobile">
              {visibleRows.map((row) => (
                <li key={row.caddy.id} className="us-user-row">
                  <div className="us-user-main">
                    <strong>
                      {row.caddy.team} {row.caddy.teamOrder} {row.caddy.name}
                    </strong>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="us-user-sub">
                    {row.linkedUser
                      ? `연결 계정 ${row.linkedUser.username}`
                      : "연결 계정 없음"}
                  </div>
                  <PendingCell row={row} />
                  <div className="us-user-actions">
                    <RowActions
                      row={row}
                      busy={busy}
                      queueBusyId={queueBusyId}
                      selectedByRequest={selectedByRequest}
                      onSelect={(requestId, caddyId) =>
                        setSelectedByRequest((prev) => ({
                          ...prev,
                          [requestId]: caddyId,
                        }))
                      }
                      onApprove={confirmApprove}
                      onReject={confirmReject}
                      onUnlink={confirmUnlink}
                      onManualLink={openLinkCaddy}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="us-section us-section-manual">
        <div className="us-section-head">
          <div>
            <div className="us-eyebrow">미연결 Kakao</div>
            <h2 className="us-section-title">
              캐디와 연결되지 않은 Kakao 계정
              {!loading && <span className="us-count">{orphanUsers.length}명</span>}
            </h2>
          </div>
        </div>
        <p className="us-sub us-sub-inline">
          캐디 명단과 별도로 유지합니다. 정체불명/미연결 Kakao 계정은 여기서
          수동 연결할 수 있습니다. (이름 자동 매칭 없음)
        </p>
        {loading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : orphanUsers.length === 0 ? (
          <p className="us-empty">캐디와 연결되지 않은 Kakao 계정이 없습니다.</p>
        ) : (
          <ul className="us-orphan-list">
            {orphanUsers.map((u) => (
              <li key={u.id} className="us-user-row">
                <div className="us-user-main">
                  <strong>{u.username}</strong>
                  <span className="us-status off">미연결</span>
                </div>
                <div className="us-user-sub">
                  role {u.role}
                  {u.kakaoUserId ? ` · kakaoUserId ${u.kakaoUserId}` : ""}
                </div>
                <div className="us-user-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openLinkUser(u as KakaoUserRow)}
                    className="us-btn us-btn-primary us-btn-sm"
                  >
                    캐디 연결
                  </button>
                </div>
              </li>
            ))}
          </ul>
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
                className="us-btn"
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
                className="us-btn us-btn-primary"
              >
                {busy ? "처리 중…" : "연결 확인"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .users-page { max-width: 1180px; margin: 0 auto; }
        .us-header {
          display: flex; flex-wrap: wrap; gap: 10px;
          justify-content: space-between; align-items: flex-end;
          margin-bottom: 12px; padding-bottom: 10px;
          border-bottom: 1px solid var(--vh-gold-line);
        }
        .us-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.65rem; font-weight: 700;
          color: var(--vh-green-900); line-height: 1.12;
        }
        .us-sub {
          margin: 4px 0 0; color: var(--vh-muted); font-size: 0.78rem;
        }
        .us-sub-inline { margin: 0 0 10px; }
        .us-banner {
          padding: 8px 10px; border-radius: 8px; margin-bottom: 10px;
          font-size: 0.82rem;
        }
        .us-banner.ok {
          background: var(--vh-ok-bg); border: 1px solid #b7dfc8; color: var(--vh-ok);
        }
        .us-banner.err {
          background: var(--vh-danger-bg); border: 1px solid #f0c4c9; color: var(--vh-danger);
        }
        .us-summary {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px; margin-bottom: 14px;
        }
        .us-chip {
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm); padding: 10px 12px;
        }
        .us-chip-label { font-size: 0.68rem; color: var(--vh-muted); font-weight: 700; }
        .us-chip-value { font-size: 1.2rem; font-weight: 800; color: var(--vh-green-900); }
        .us-chip.wait .us-chip-value { color: #9a6b12; }
        .us-chip.ok .us-chip-value { color: var(--vh-ok); }
        .us-section {
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius); padding: 14px;
          margin-bottom: 14px; box-shadow: var(--vh-shadow-sm);
        }
        .us-section-roster {
          border-color: rgba(196, 165, 116, 0.55);
          box-shadow: 0 0 0 1px rgba(196, 165, 116, 0.12), var(--vh-shadow-sm);
        }
        .us-section-manual { border-top: 3px solid var(--vh-green-800); }
        .us-section-head {
          display: flex; justify-content: space-between; align-items: flex-start;
          gap: 10px; margin-bottom: 10px;
        }
        .us-eyebrow {
          font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--vh-gold-deep); margin-bottom: 2px;
        }
        .us-section-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.12rem; font-weight: 700; color: var(--vh-green-900);
        }
        .us-count {
          margin-left: 8px; font-size: 0.78rem; font-weight: 600;
          color: var(--vh-muted); font-family: var(--font-sans);
        }
        .us-filters {
          display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 12px;
        }
        .us-filter { display: grid; gap: 4px; font-size: 0.7rem; font-weight: 700; color: var(--vh-muted); }
        .us-filter select, .us-filter input {
          min-height: 34px; padding: 6px 8px; border-radius: 8px;
          border: 1px solid var(--vh-border-strong); background: #fff;
          font-size: 16px; color: var(--vh-ink); font-weight: 500;
        }
        .us-muted { color: var(--vh-muted); font-size: 0.8rem; }
        .us-empty {
          margin: 0; padding: 12px; border: 1px dashed var(--vh-border-strong);
          border-radius: 8px; color: var(--vh-muted); font-size: 0.8rem;
          background: var(--vh-ivory);
        }
        .us-pending-cell { font-size: 0.74rem; color: var(--vh-ink-soft); }
        .us-pending-user { font-weight: 700; }
        .us-pending-phone { color: var(--vh-muted); }
        .us-row-actions { display: grid; gap: 6px; }
        .us-cand {
          display: flex; gap: 8px; align-items: center;
          padding: 6px 0; font-size: 0.74rem; cursor: pointer;
        }
        .us-btn {
          min-height: 30px; padding: 5px 10px; border-radius: 8px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.74rem; font-weight: 600; cursor: pointer;
          font-family: var(--font-sans); color: var(--vh-ink);
        }
        .us-btn-sm { min-height: 26px; padding: 3px 8px; font-size: 0.7rem; }
        .us-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .us-btn-primary {
          background: var(--vh-green-900); border-color: var(--vh-green-900); color: #fff;
        }
        .us-btn-danger {
          background: #fff; border-color: #e2b4ba; color: var(--vh-danger);
        }
        .us-table-wrap {
          overflow: auto; border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
        }
        .us-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
        .us-table th {
          text-align: left; padding: 7px 8px; background: var(--vh-green-50);
          color: var(--vh-green-800); font-size: 0.7rem; font-weight: 700;
          border-bottom: 1px solid var(--vh-border); white-space: nowrap;
        }
        .us-table td {
          padding: 7px 8px; border-top: 1px solid var(--vh-border);
          vertical-align: top;
        }
        .us-uname { font-weight: 700; color: var(--vh-green-900); }
        .us-status {
          display: inline-flex; padding: 1px 7px; border-radius: 999px;
          font-size: 0.68rem; font-weight: 700;
        }
        .us-status.ok { background: var(--vh-ok-bg); color: var(--vh-ok); }
        .us-status.wait { background: #fff4d6; color: #9a6b12; }
        .us-status.off { background: var(--vh-ivory-deep); color: var(--vh-muted); }
        .us-manual-mobile, .us-orphan-list {
          display: grid; gap: 0; list-style: none; margin: 0; padding: 0;
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius-sm); overflow: hidden;
        }
        .us-manual-pc { display: none; }
        .us-user-row {
          padding: 8px 10px; border-top: 1px solid var(--vh-border);
          background: var(--vh-paper);
        }
        .us-user-row:first-child { border-top: 0; }
        .us-user-main {
          display: flex; justify-content: space-between; gap: 8px; align-items: center;
        }
        .us-user-main strong { color: var(--vh-green-900); font-size: 0.86rem; }
        .us-user-sub { margin-top: 2px; font-size: 0.72rem; color: var(--vh-muted); }
        .us-user-actions { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
        @media (min-width: 720px) {
          .us-summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
          .us-filters { grid-template-columns: 140px 1fr 140px; }
        }
        @media (min-width: 960px) {
          .us-title { font-size: 1.8rem; }
          .us-manual-mobile { display: none; }
          .us-manual-pc { display: block; }
        }
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
          margin: 0 0 6px;
          font-family: var(--font-display-kr);
          font-size: 1.2rem; color: var(--vh-green-900);
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

function SummaryChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "wait";
}) {
  return (
    <div className={`us-chip${tone ? ` ${tone}` : ""}`}>
      <div className="us-chip-label">{label}</div>
      <div className="us-chip-value">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: AdminLinkStatus }) {
  const tone = status === "linked" ? "ok" : status === "pending" ? "wait" : "off";
  return <span className={`us-status ${tone}`}>{ADMIN_LINK_STATUS_LABELS[status]}</span>;
}

function PendingCell({ row }: { row: AdminCaddyLinkRow }) {
  if (row.status !== "pending" || row.pendingForCaddy.length === 0) {
    return <span className="us-muted">—</span>;
  }
  return (
    <div className="us-pending-cell">
      {row.pendingForCaddy.map((req) => (
        <div key={req.id}>
          <span className="us-pending-user">{req.user.username}</span>
          <span className="us-pending-phone">
            {" · "}
            {req.maskedPhone || "010-****-****"}
          </span>
        </div>
      ))}
    </div>
  );
}

function RowActions({
  row,
  busy,
  queueBusyId,
  selectedByRequest,
  onSelect,
  onApprove,
  onReject,
  onUnlink,
  onManualLink,
}: {
  row: AdminCaddyLinkRow;
  busy: boolean;
  queueBusyId: number | null;
  selectedByRequest: Record<number, number | null>;
  onSelect: (requestId: number, caddyId: number) => void;
  onApprove: (req: RosterPending, caddy: RosterCaddy) => void;
  onReject: (req: RosterPending) => void;
  onUnlink: (user: RosterUser, caddy: RosterCaddy) => void;
  onManualLink: (caddy: RosterCaddy) => void;
}) {
  if (row.status === "linked" && row.linkedUser) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void onUnlink(row.linkedUser!, row.caddy)}
        className="us-btn us-btn-danger us-btn-sm"
      >
        연결 해제
      </button>
    );
  }

  if (row.status === "pending") {
    return (
      <div className="us-row-actions">
        {row.pendingForCaddy.map((req) => {
          const canApprove = canApprovePendingForCaddy(req, row.caddy.id);
          const selected = selectedByRequest[req.id] === row.caddy.id;
          const busyRow = queueBusyId === req.id;
          return (
            <div key={req.id}>
              {canApprove ? (
                <label className="us-cand">
                  <input
                    type="radio"
                    name={`cand-${req.id}`}
                    checked={selected}
                    disabled={busyRow}
                    onChange={() => onSelect(req.id, row.caddy.id)}
                  />
                  이 캐디로 승인
                </label>
              ) : (
                <p className="us-muted">이 캐디는 후보가 아닙니다.</p>
              )}
              <div className="us-user-actions">
                <button
                  type="button"
                  className="us-btn us-btn-primary us-btn-sm"
                  disabled={busyRow || !canApprove || !selected}
                  onClick={() => void onApprove(req, row.caddy)}
                >
                  {busyRow ? "처리 중…" : "승인"}
                </button>
                <button
                  type="button"
                  className="us-btn us-btn-danger us-btn-sm"
                  disabled={busyRow}
                  onClick={() => void onReject(req)}
                >
                  반려
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onManualLink(row.caddy)}
      className="us-btn us-btn-primary us-btn-sm"
    >
      수동 연결
    </button>
  );
}
