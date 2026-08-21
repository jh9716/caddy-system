"use client";

import { useState } from "react";
import {
  MIN_NEW_PASSWORD_LENGTH,
  newPasswordIssueMessage,
  validateNewPassword,
  validatePasswordConfirm,
} from "@/lib/passwordPolicy";

export default function ChangePasswordClient({
  forced,
  username,
}: {
  forced: boolean;
  username: string;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");

    const confirmIssue = validatePasswordConfirm(newPassword, confirmPassword);
    if (confirmIssue) {
      setErr(newPasswordIssueMessage(confirmIssue));
      return;
    }
    const issue = validateNewPassword(newPassword, currentPassword);
    if (issue) {
      setErr(newPasswordIssueMessage(issue));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "변경 실패");
      }
      location.href = "/manage";
    } catch (e: any) {
      setErr(e.message || "변경 실패");
    } finally {
      setLoading(false);
    }
  };

  const onLogout = async () => {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    location.href = "/login";
  };

  return (
    <div className="vh-auth-hero">
      <div
        className="vh-auth-bg"
        style={{ backgroundImage: "url(/brand/hero-fairway.jpg)" }}
        aria-hidden
      />
      <div className="vh-auth-overlay" aria-hidden />

      <div className="vh-auth-frame">
        <header className="vh-auth-top">
          <span className="vh-auth-brand">
            VERTHILL <span>Caddy</span>
          </span>
        </header>

        <div className="vh-auth-stage">
          <div className="vh-auth-intro">
            <p className="vh-auth-eyebrow">Account Security</p>
            <h1 className="vh-auth-title">비밀번호 변경</h1>
            <div className="vh-auth-rule" aria-hidden />
            <p className="vh-auth-lead">
              {forced
                ? "임시 비밀번호로 로그인했습니다. 새 비밀번호를 설정한 뒤 관리 화면을 이용할 수 있습니다."
                : "본인 계정의 비밀번호를 변경합니다."}
            </p>
          </div>

          <form onSubmit={onSubmit} className="vh-auth-card">
            <h2 className="vh-auth-card-title">비밀번호 변경</h2>
            <p className="vh-auth-card-sub">{username}</p>

            <label className="vh-auth-label" htmlFor="current-password">
              현재 비밀번호
            </label>
            <input
              id="current-password"
              name="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="vh-auth-input"
              autoComplete="current-password"
              required
            />

            <label className="vh-auth-label" htmlFor="new-password">
              새 비밀번호
            </label>
            <input
              id="new-password"
              name="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="vh-auth-input"
              autoComplete="new-password"
              minLength={MIN_NEW_PASSWORD_LENGTH}
              required
            />

            <label className="vh-auth-label" htmlFor="confirm-password">
              새 비밀번호 확인
            </label>
            <input
              id="confirm-password"
              name="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="vh-auth-input"
              autoComplete="new-password"
              minLength={MIN_NEW_PASSWORD_LENGTH}
              required
            />

            {err && <div className="vh-auth-error">{err}</div>}

            <button
              type="submit"
              disabled={loading}
              className="vh-auth-submit"
            >
              {loading ? "변경 중…" : "변경"}
            </button>

            <button
              type="button"
              onClick={() => void onLogout()}
              className="vh-auth-kakao"
              style={{ marginTop: 12 }}
            >
              로그아웃
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
