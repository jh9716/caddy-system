"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminLinkErrorMessage,
  initialAdminSelectedCaddyId,
} from "@/lib/caddyLinkRequestUi";
import { formatCaddyLabel } from "@/lib/caddyDisplay";

type LinkedCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

type KakaoUserRow = {
  id: number;
  username: string;
  role: string;
  kakaoUserId: string;
  caddyId: number | null;
  linked: boolean;
  caddy: LinkedCaddy | null;
  createdAt: string;
};

type CaddyOption = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

type AdminCandidate = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

type PendingLinkRequest = {
  id: number;
  status: string;
  submittedName: string;
  maskedPhone: string | null;
  requestedAt: string;
  user: {
    id: number;
    username: string;
    kakaoUserId?: string | null;
  };
  candidates: AdminCandidate[];
};

export default function ManageUsersPage() {
  const [users, setUsers] = useState<KakaoUserRow[]>([]);
  const [occupiedCaddyIds, setOccupiedCaddyIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingLinkRequest[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [selectedByRequest, setSelectedByRequest] = useState<
    Record<number, number | null>
  >({});
  const [queueBusyId, setQueueBusyId] = useState<number | null>(null);

  const [linkUser, setLinkUser] = useState<KakaoUserRow | null>(null);
  const [caddies, setCaddies] = useState<CaddyOption[]>([]);
  const [caddyQuery, setCaddyQuery] = useState("");
  const [selectedCaddyId, setSelectedCaddyId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "목록 조회 실패");
      }
      setUsers(data.users || []);
      setOccupiedCaddyIds(data.occupiedCaddyIds || []);
    } catch (e: any) {
      setError(e?.message || "목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
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
      const rows: PendingLinkRequest[] = Array.isArray(data.requests)
        ? data.requests
        : [];
      setPending(rows);
      // 후보 1명이어도 자동 선택 금지 — 선택 상태 초기화(null)
      const next: Record<number, number | null> = {};
      for (const r of rows) {
        next[r.id] = initialAdminSelectedCaddyId(r.candidates?.length ?? 0);
      }
      setSelectedByRequest(next);
    } catch (e: any) {
      setError(e?.message || "승인 대기 목록 조회 실패");
    } finally {
      setPendingLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadPending(), loadUsers()]);
  }, [loadPending, loadUsers]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const openLinkModal = async (user: KakaoUserRow) => {
    setLinkUser(user);
    setSelectedCaddyId(null);
    setCaddyQuery("");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/caddies?employment=ACTIVE", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => []);
      if (!res.ok) {
        throw new Error(data?.error || "캐디 목록 실패");
      }
      setCaddies(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message || "캐디 목록 실패");
      setLinkUser(null);
    }
  };

  const occupiedSet = useMemo(
    () => new Set(occupiedCaddyIds),
    [occupiedCaddyIds]
  );

  const filteredCaddies = useMemo(() => {
    const q = caddyQuery.trim().toLowerCase();
    return caddies
      .filter((c) => !occupiedSet.has(c.id))
      .filter((c) => {
        if (!q) return true;
        const hay = `${c.name} ${c.team} ${c.teamOrder} ${c.id}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 80);
  }, [caddies, caddyQuery, occupiedSet]);

  const selectedCaddy = useMemo(
    () => caddies.find((c) => c.id === selectedCaddyId) || null,
    [caddies, selectedCaddyId]
  );

  const confirmLink = async () => {
    if (!linkUser || selectedCaddyId == null || !selectedCaddy) return;
    const ok = window.confirm(
      `${linkUser.username} 계정을 아래 캐디와 연결할까요?\n\n` +
        `${formatCaddyLabel(selectedCaddy)}\n\n` +
        `연결 후 이 계정으로 해당 캐디의 휴무 신청이 가능해집니다.`
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${linkUser.id}/link-caddy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caddyId: selectedCaddyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "연결 실패");
      }
      setMessage(`${linkUser.username} ↔ ${selectedCaddy.name} 연결 완료`);
      setLinkUser(null);
      await refreshAll();
    } catch (e: any) {
      setError(e?.message || "연결 실패");
    } finally {
      setBusy(false);
    }
  };

  const confirmUnlink = async (user: KakaoUserRow) => {
    if (!user.caddy) return;
    const ok = window.confirm(
      `${user.username} 계정과 캐디 연결을 해제할까요?\n\n` +
        `${formatCaddyLabel(user.caddy)}\n\n` +
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
    } catch (e: any) {
      setError(e?.message || "연결 해제 실패");
    } finally {
      setBusy(false);
    }
  };

  const confirmApprove = async (req: PendingLinkRequest) => {
    const selectedId = selectedByRequest[req.id];
    if (selectedId == null) {
      setError("승인할 후보 캐디를 선택해 주세요. (자동 승인 없음)");
      return;
    }
    const cand = req.candidates.find((c) => c.id === selectedId);
    if (!cand) {
      setError("선택한 캐디가 후보 목록에 없습니다.");
      return;
    }
    const ok = window.confirm(
      `본인확인 요청을 승인할까요?\n\n` +
        `계정: ${req.user.username}\n` +
        `제출 이름: ${req.submittedName}\n` +
        `휴대폰: ${req.maskedPhone || "010-****-****"}\n` +
        `연결 캐디: ${formatCaddyLabel(cand)}\n\n` +
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
        `${req.user.username} 요청 승인 · ${cand.name} 연결 완료`
      );
      await refreshAll();
    } catch (e: any) {
      setError(e?.message || "승인 실패");
      await loadPending();
    } finally {
      setQueueBusyId(null);
    }
  };

  const confirmReject = async (req: PendingLinkRequest) => {
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
    if (noteRaw === null) return; // prompt 취소

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
    } catch (e: any) {
      setError(e?.message || "반려 실패");
      await loadPending();
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
            승인 대기 요청과 수동 연결을 분리해 관리합니다. (후보 자동 승인 없음)
          </p>
        </div>
        <button
          type="button"
          className="us-btn"
          disabled={pendingLoading || loading || queueBusyId != null}
          onClick={() => void refreshAll()}
        >
          전체 새로고침
        </button>
      </header>

      {message && <div className="us-banner ok">{message}</div>}
      {error && <div className="us-banner err">{error}</div>}

      {/* —— 승인 대기 큐 —— */}
      <section className="us-section us-section-queue">
        <div className="us-section-head">
          <div>
            <div className="us-eyebrow">승인 큐</div>
            <h2 className="us-section-title">
              본인확인 승인 대기
              {!pendingLoading && (
                <span className="us-count">{pending.length}건</span>
              )}
            </h2>
          </div>
          <button
            type="button"
            disabled={pendingLoading || queueBusyId != null}
            onClick={() => void loadPending()}
            className="us-btn"
          >
            새로고침
          </button>
        </div>

        {pendingLoading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : pending.length === 0 ? (
          <p className="us-empty">승인 대기 중인 요청이 없습니다.</p>
        ) : (
          <div className="us-queue-list">
            {pending.map((req) => {
              const selectedId = selectedByRequest[req.id] ?? null;
              const busyRow = queueBusyId === req.id;
              return (
                <article key={req.id} className="us-queue-card">
                  <div className="us-queue-top">
                    <div>
                      <div className="us-queue-name">
                        {req.submittedName}
                        <span className="us-queue-phone">
                          · {req.maskedPhone || "010-****-****"}
                        </span>
                      </div>
                      <div className="us-queue-meta">
                        Kakao <strong>{req.user.username}</strong>
                        {" · "}
                        {formatRequestedAt(req.requestedAt)}
                      </div>
                    </div>
                    <div className="us-queue-actions">
                      <button
                        type="button"
                        className="us-btn us-btn-primary"
                        disabled={busyRow || selectedId == null}
                        onClick={() => void confirmApprove(req)}
                      >
                        {busyRow ? "처리 중…" : "승인"}
                      </button>
                      <button
                        type="button"
                        className="us-btn us-btn-danger"
                        disabled={busyRow}
                        onClick={() => void confirmReject(req)}
                      >
                        반려
                      </button>
                    </div>
                  </div>

                  <div className="us-cand-label">
                    후보 캐디
                    <span>
                      {req.candidates.length}명 · 직접 선택 필요 (자동 승인 없음)
                    </span>
                  </div>
                  {req.candidates.length === 0 ? (
                    <p className="us-warn">
                      후보가 없습니다. 반려 후 직원에게 이름 확인을 요청하세요.
                    </p>
                  ) : (
                    <div className="us-cand-list">
                      {req.candidates.map((c) => {
                        const selected = selectedId === c.id;
                        return (
                          <label
                            key={c.id}
                            className={`us-cand${selected ? " is-selected" : ""}`}
                          >
                            <input
                              type="radio"
                              name={`cand-${req.id}`}
                              checked={selected}
                              disabled={busyRow}
                              onChange={() =>
                                setSelectedByRequest((prev) => ({
                                  ...prev,
                                  [req.id]: c.id,
                                }))
                              }
                            />
                            <span>
                              <strong>{formatCaddyLabel(c)}</strong>
                              {c.employmentStatus && c.employmentStatus !== "ACTIVE"
                                ? ` · ${c.employmentStatus}`
                                : ""}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* —— 수동 연결 (기존) —— */}
      <section className="us-section us-section-manual">
        <div className="us-section-head">
          <div>
            <div className="us-eyebrow">수동 운영</div>
            <h2 className="us-section-title">수동 연결 / 해제</h2>
          </div>
        </div>
        <p className="us-sub us-sub-inline">
          Kakao 가입 계정만 표시됩니다. 관리자가 캐디를 직접 선택한 뒤에만
          연결됩니다. (이름 자동 매칭 없음)
        </p>

        {loading ? (
          <p className="us-muted">불러오는 중…</p>
        ) : users.length === 0 ? (
          <p className="us-muted">Kakao 가입 계정이 없습니다.</p>
        ) : (
          <>
            <div className="us-table-wrap us-manual-pc">
              <table className="us-table">
                <thead>
                  <tr>
                    <th>username</th>
                    <th>상태</th>
                    <th>연결된 캐디</th>
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="us-uname">{u.username}</div>
                        <div className="us-uid">
                          kakaoUserId {u.kakaoUserId} · role {u.role}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`us-status ${u.linked ? "ok" : "off"}`}
                        >
                          {u.linked ? "연결됨" : "미연결"}
                        </span>
                      </td>
                      <td>
                        {u.caddy ? (
                          <>
                            {formatCaddyLabel(u.caddy)}
                          </>
                        ) : (
                          <span className="us-muted">—</span>
                        )}
                      </td>
                      <td>
                        {!u.linked ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void openLinkModal(u)}
                            className="us-btn us-btn-primary us-btn-sm"
                          >
                            캐디 연결
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void confirmUnlink(u)}
                            className="us-btn us-btn-danger us-btn-sm"
                          >
                            연결 해제
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="us-manual-mobile">
              {users.map((u) => (
                <li key={u.id} className="us-user-row">
                  <div className="us-user-main">
                    <strong>{u.username}</strong>
                    <span
                      className={`us-status ${u.linked ? "ok" : "off"}`}
                    >
                      {u.linked ? "연결됨" : "미연결"}
                    </span>
                  </div>
                  <div className="us-user-sub">
                    {u.caddy
                      ? formatCaddyLabel(u.caddy)
                      : "연결된 캐디 없음"}
                  </div>
                  <div className="us-user-actions">
                    {!u.linked ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void openLinkModal(u)}
                        className="us-btn us-btn-primary us-btn-sm"
                      >
                        캐디 연결
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmUnlink(u)}
                        className="us-btn us-btn-danger us-btn-sm"
                      >
                        연결 해제
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {linkUser && (
        <div className="us-modal-overlay" onClick={() => !busy && setLinkUser(null)}>
          <div className="us-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="us-modal-title">캐디 연결</h2>
            <p className="us-sub us-sub-inline">
              계정 <strong>{linkUser.username}</strong> 에 연결할 ACTIVE
              캐디를 선택하세요. 이미 다른 계정에 연결된 캐디는 목록에 없습니다.
            </p>
            <input
              className="us-input"
              value={caddyQuery}
              onChange={(e) => setCaddyQuery(e.target.value)}
              placeholder="이름 / 조 검색"
            />
            <div className="us-modal-list">
              {filteredCaddies.length === 0 ? (
                <div className="us-muted" style={{ padding: 12 }}>
                  선택 가능한 캐디가 없습니다.
                </div>
              ) : (
                filteredCaddies.map((c) => {
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
            <div className="us-modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setLinkUser(null)}
                className="us-btn"
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy || selectedCaddyId == null}
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
        .users-page { max-width: 1100px; margin: 0 auto; }
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
        .us-section {
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius); padding: 14px;
          margin-bottom: 14px; box-shadow: var(--vh-shadow-sm);
        }
        .us-section-queue {
          border-color: rgba(196, 165, 116, 0.55);
          box-shadow: 0 0 0 1px rgba(196, 165, 116, 0.12), var(--vh-shadow-sm);
        }
        .us-section-manual {
          border-top: 3px solid var(--vh-green-800);
        }
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
        .us-muted { color: var(--vh-muted); font-size: 0.8rem; }
        .us-empty {
          margin: 0; padding: 12px; border: 1px dashed var(--vh-border-strong);
          border-radius: 8px; color: var(--vh-muted); font-size: 0.8rem;
          background: var(--vh-ivory);
        }
        .us-queue-list { display: grid; gap: 8px; }
        .us-queue-card {
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius-sm);
          background: linear-gradient(180deg, #fffcf7 0%, #f7f4ec 100%);
          padding: 10px 12px;
        }
        .us-queue-top {
          display: flex; flex-wrap: wrap; gap: 8px;
          justify-content: space-between; margin-bottom: 8px;
        }
        .us-queue-name {
          font-size: 0.9rem; font-weight: 700; color: var(--vh-green-900);
        }
        .us-queue-phone { color: var(--vh-muted); font-weight: 500; }
        .us-queue-meta { margin-top: 2px; font-size: 0.72rem; color: var(--vh-muted); }
        .us-queue-actions { display: flex; gap: 6px; align-items: center; }
        .us-cand-label {
          font-size: 0.74rem; font-weight: 700; color: var(--vh-ink-soft);
          margin-bottom: 5px;
        }
        .us-cand-label span {
          margin-left: 6px; font-weight: 500; color: var(--vh-muted);
        }
        .us-warn { margin: 0; color: var(--vh-danger); font-size: 0.78rem; }
        .us-cand-list {
          border: 1px solid var(--vh-border); border-radius: 8px; overflow: hidden;
          background: #fff;
        }
        .us-cand {
          display: flex; gap: 8px; align-items: center;
          padding: 7px 10px; border-top: 1px solid var(--vh-border);
          font-size: 0.78rem; cursor: pointer;
        }
        .us-cand:first-child { border-top: 0; }
        .us-cand.is-selected {
          background: rgba(196, 165, 116, 0.14);
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
        .us-table {
          width: 100%; border-collapse: collapse; font-size: 0.8rem;
        }
        .us-table th {
          text-align: left; padding: 7px 8px; background: var(--vh-green-50);
          color: var(--vh-green-800); font-size: 0.7rem; font-weight: 700;
          border-bottom: 1px solid var(--vh-border);
        }
        .us-table td {
          padding: 7px 8px; border-top: 1px solid var(--vh-border);
          vertical-align: middle;
        }
        .us-uname { font-weight: 700; color: var(--vh-green-900); }
        .us-uid { font-size: 0.68rem; color: var(--vh-muted); }
        .us-status {
          display: inline-flex; padding: 1px 7px; border-radius: 999px;
          font-size: 0.68rem; font-weight: 700;
        }
        .us-status.ok { background: var(--vh-ok-bg); color: var(--vh-ok); }
        .us-status.off { background: var(--vh-ivory-deep); color: var(--vh-muted); }
        .us-manual-mobile { display: grid; gap: 0; list-style: none; margin: 0; padding: 0;
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
        .us-user-actions { margin-top: 6px; }
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
        .us-modal-actions {
          display: flex; gap: 6px; justify-content: flex-end;
        }
      `}</style>
    </div>
  );
}

function formatRequestedAt(value: string | Date): string {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("ko-KR");
  } catch {
    return String(value);
  }
}
