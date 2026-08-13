"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminLinkErrorMessage,
  initialAdminSelectedCaddyId,
} from "@/lib/caddyLinkRequestUi";

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
        `${selectedCaddy.name} / ${selectedCaddy.team} / 순번 ${selectedCaddy.teamOrder} / id ${selectedCaddy.id}\n\n` +
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
        `${user.caddy.name} / ${user.caddy.team} / 순번 ${user.caddy.teamOrder}\n\n` +
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
        `연결 캐디: ${cand.name} / ${cand.team} / 순번 ${cand.teamOrder} / id ${cand.id}\n\n` +
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
    <div style={{ maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
        계정 연결 (Kakao ↔ 캐디)
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14 }}>
        직원이 제출한 본인확인 요청을 승인한 뒤 연결하거나, 아래에서 수동으로
        연결할 수 있습니다. (후보 자동 승인 없음)
      </p>

      {message && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: 8,
            color: "#065f46",
            fontSize: 14,
          }}
        >
          {message}
        </div>
      )}
      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            background: "#fff1f2",
            border: "1px solid #fecdd3",
            borderRadius: 8,
            color: "#9f1239",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {/* —— 승인 대기 큐 —— */}
      <section style={{ marginBottom: 28 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 10,
          }}
        >
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>
            본인확인 승인 대기
            {!pendingLoading && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#64748b",
                }}
              >
                {pending.length}건
              </span>
            )}
          </h2>
          <button
            type="button"
            disabled={pendingLoading || queueBusyId != null}
            onClick={() => void loadPending()}
            style={btnGhost}
          >
            새로고침
          </button>
        </div>

        {pendingLoading ? (
          <p style={{ color: "#64748b", fontSize: 14 }}>불러오는 중…</p>
        ) : pending.length === 0 ? (
          <p
            style={{
              color: "#64748b",
              fontSize: 14,
              padding: 14,
              border: "1px dashed #e5e7eb",
              borderRadius: 8,
              background: "#fff",
            }}
          >
            승인 대기 중인 요청이 없습니다.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {pending.map((req) => {
              const selectedId = selectedByRequest[req.id] ?? null;
              const busyRow = queueBusyId === req.id;
              return (
                <div
                  key={req.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 10,
                    background: "#fff",
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 12,
                      justifyContent: "space-between",
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ fontSize: 14 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        {req.submittedName}{" "}
                        <span style={{ color: "#94a3b8", fontWeight: 500 }}>
                          · {req.maskedPhone || "010-****-****"}
                        </span>
                      </div>
                      <div style={{ color: "#64748b", fontSize: 13 }}>
                        Kakao username{" "}
                        <strong style={{ color: "#0f172a" }}>
                          {req.user.username}
                        </strong>
                        {" · "}
                        {formatRequestedAt(req.requestedAt)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button
                        type="button"
                        disabled={busyRow || selectedId == null}
                        onClick={() => void confirmApprove(req)}
                        style={
                          busyRow || selectedId == null
                            ? { ...btnPrimary, opacity: 0.5, cursor: "not-allowed" }
                            : btnPrimary
                        }
                      >
                        {busyRow ? "처리 중…" : "승인"}
                      </button>
                      <button
                        type="button"
                        disabled={busyRow}
                        onClick={() => void confirmReject(req)}
                        style={btnDanger}
                      >
                        반려
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                    후보 캐디
                    <span style={{ fontWeight: 500, color: "#94a3b8", marginLeft: 6 }}>
                      {req.candidates.length}명 · 직접 선택 필요 (자동 승인 없음)
                    </span>
                  </div>
                  {req.candidates.length === 0 ? (
                    <p style={{ color: "#be123c", fontSize: 13, margin: 0 }}>
                      후보가 없습니다. 반려 후 직원에게 이름 확인을 요청하세요.
                    </p>
                  ) : (
                    <div
                      style={{
                        border: "1px solid #f1f5f9",
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      {req.candidates.map((c) => {
                        const selected = selectedId === c.id;
                        return (
                          <label
                            key={c.id}
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "center",
                              padding: "10px 12px",
                              borderBottom: "1px solid #f8fafc",
                              background: selected ? "#eff6ff" : "#fff",
                              cursor: busyRow ? "default" : "pointer",
                              fontSize: 14,
                            }}
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
                              <strong>{c.name}</strong> · {c.team} · 순번{" "}
                              {c.teamOrder} · id {c.id} · {c.employmentStatus}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* —— 수동 연결 (기존) —— */}
      <h2 style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>
        수동 연결 / 해제
      </h2>
      <p style={{ color: "#64748b", marginBottom: 12, fontSize: 14 }}>
        Kakao로 가입한 계정만 표시됩니다. 관리자가 캐디를 직접 선택한 뒤에만
        연결됩니다. (이름 자동 매칭 없음)
      </p>

      {loading ? (
        <p>불러오는 중…</p>
      ) : users.length === 0 ? (
        <p style={{ color: "#64748b" }}>Kakao 가입 계정이 없습니다.</p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            overflow: "hidden",
            fontSize: 14,
          }}
        >
          <thead>
            <tr style={{ background: "#f8fafc", textAlign: "left" }}>
              <th style={th}>username</th>
              <th style={th}>상태</th>
              <th style={th}>연결된 캐디</th>
              <th style={th}>작업</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{u.username}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>
                    kakaoUserId {u.kakaoUserId} · role {u.role}
                  </div>
                </td>
                <td style={td}>{u.linked ? "연결됨" : "미연결"}</td>
                <td style={td}>
                  {u.caddy ? (
                    <>
                      {u.caddy.name} / {u.caddy.team} / 순번 {u.caddy.teamOrder}{" "}
                      <span style={{ color: "#94a3b8" }}>(id {u.caddy.id})</span>
                    </>
                  ) : (
                    <span style={{ color: "#94a3b8" }}>—</span>
                  )}
                </td>
                <td style={td}>
                  {!u.linked ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openLinkModal(u)}
                      style={btnPrimary}
                    >
                      캐디 연결
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void confirmUnlink(u)}
                      style={btnDanger}
                    >
                      연결 해제
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {linkUser && (
        <div style={modalOverlay} onClick={() => !busy && setLinkUser(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>
              캐디 연결
            </h2>
            <p style={{ fontSize: 14, color: "#64748b", marginBottom: 12 }}>
              계정 <strong>{linkUser.username}</strong> 에 연결할 ACTIVE
              캐디를 선택하세요. 이미 다른 계정에 연결된 캐디는 목록에 없습니다.
            </p>
            <input
              value={caddyQuery}
              onChange={(e) => setCaddyQuery(e.target.value)}
              placeholder="이름 / 조 / 순번 / id 검색"
              style={{
                width: "100%",
                marginBottom: 10,
                padding: "8px 10px",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
              }}
            />
            <div
              style={{
                maxHeight: 280,
                overflow: "auto",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              {filteredCaddies.length === 0 ? (
                <div style={{ padding: 12, color: "#94a3b8", fontSize: 13 }}>
                  선택 가능한 캐디가 없습니다.
                </div>
              ) : (
                filteredCaddies.map((c) => {
                  const selected = selectedCaddyId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedCaddyId(c.id)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        border: 0,
                        borderBottom: "1px solid #f1f5f9",
                        background: selected ? "#eff6ff" : "#fff",
                        cursor: "pointer",
                        fontSize: 14,
                      }}
                    >
                      <strong>{c.name}</strong> · {c.team} · 순번 {c.teamOrder}{" "}
                      · id {c.id}
                    </button>
                  );
                })
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setLinkUser(null)}
                style={btnGhost}
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy || selectedCaddyId == null}
                onClick={() => void confirmLink()}
                style={btnPrimary}
              >
                {busy ? "처리 중…" : "연결 확인"}
              </button>
            </div>
          </div>
        </div>
      )}
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

const th: React.CSSProperties = {
  padding: "10px 12px",
  fontWeight: 700,
  fontSize: 13,
  color: "#475569",
};
const td: React.CSSProperties = { padding: "12px", verticalAlign: "top" };
const btnPrimary: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};
const btnDanger: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #be123c",
  background: "#fff",
  color: "#be123c",
  fontSize: 13,
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#334155",
  fontSize: 13,
  cursor: "pointer",
};
const modalOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 50,
  padding: 16,
};
const modalCard: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "#fff",
  borderRadius: 12,
  padding: 20,
  boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
};
