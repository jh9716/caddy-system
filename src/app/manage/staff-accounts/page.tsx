"use client";

import { useCallback, useEffect, useState } from "react";

type StaffRow = {
  id: number;
  username: string;
  role: string;
  mustChangePassword: boolean;
  caddyId: number | null;
  createdAt: string;
};

export default function StaffAccountsPage() {
  const [users, setUsers] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [issued, setIssued] = useState<{
    username: string;
    temporaryPassword: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/staff-accounts", {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "목록 조회 실패");
      }
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (e: any) {
      setError(e?.message || "목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPassword = async (user: StaffRow) => {
    const ok = window.confirm(
      `${user.username} 계정의 비밀번호를 임시 비밀번호로 재설정할까요?\n\n` +
        `기존 로그인은 즉시 무효가 되고, 다음 로그인에서 비밀번호 변경이 강제됩니다.\n` +
        `임시 비밀번호는 지금 한 번만 표시됩니다.`
    );
    if (!ok) return;

    setBusyId(user.id);
    setError(null);
    setIssued(null);
    try {
      const res = await fetch(
        `/api/admin/staff-accounts/${user.id}/reset-password`,
        { method: "POST", credentials: "include" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "재설정 실패");
      }
      const temporaryPassword = String(data?.temporaryPassword || "");
      if (!temporaryPassword) {
        throw new Error("임시 비밀번호를 받지 못했습니다.");
      }
      setIssued({
        username: String(data?.user?.username || user.username),
        temporaryPassword,
      });
      await load();
    } catch (e: any) {
      setError(e?.message || "재설정 실패");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="vh-page">
      <div className="vh-page-head">
        <h1>직원 계정</h1>
        <p>
          경기과 직원 ID/PW 계정만 다룹니다. 카카오 계정 연결은{" "}
          <a href="/manage/users">계정 연결</a>에서 관리합니다.
        </p>
      </div>

      {issued && (
        <div
          className="ui-banner"
          style={{
            marginBottom: 16,
            padding: 16,
            border: "1px solid var(--vh-gold-line)",
            borderRadius: 8,
            background: "var(--vh-ok-bg)",
          }}
        >
          <strong>{issued.username}</strong> 임시 비밀번호 (지금만 표시)
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 22,
              letterSpacing: "0.12em",
              marginTop: 8,
            }}
          >
            {issued.temporaryPassword}
          </div>
          <p style={{ margin: "8px 0 0", color: "var(--vh-ink-soft)" }}>
            이 값을 직원에게 전달한 뒤 이 안내를 닫으세요. 화면을 새로고침하면
            다시 볼 수 없습니다.
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            style={{ marginTop: 8 }}
            onClick={() => setIssued(null)}
          >
            닫기
          </button>
        </div>
      )}

      {error && (
        <p className="vh-auth-error" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      {loading ? (
        <p>불러오는 중…</p>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>아이디</th>
                <th>역할</th>
                <th>비밀번호 변경</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={4}>ID/PW 직원 계정이 없습니다.</td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>{u.role}</td>
                    <td>
                      {u.mustChangePassword ? "변경 필요" : "변경 완료"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ui-btn"
                        disabled={busyId === u.id}
                        onClick={() => void resetPassword(u)}
                      >
                        {busyId === u.id ? "재설정 중…" : "임시 비밀번호 재설정"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
