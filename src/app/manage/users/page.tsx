"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

export default function ManageUsersPage() {
  const [users, setUsers] = useState<KakaoUserRow[]>([]);
  const [occupiedCaddyIds, setOccupiedCaddyIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

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
      await loadUsers();
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
      await loadUsers();
    } catch (e: any) {
      setError(e?.message || "연결 해제 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
        계정 연결 (Kakao ↔ 캐디)
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16, fontSize: 14 }}>
        Kakao로 가입한 계정만 표시됩니다. 관리자가 캐디를 직접 선택한 뒤에만
        연결됩니다. (이름 자동 매칭 없음)
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
