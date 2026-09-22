"use client";

import { useState } from "react";

export default function AccountDeletionForm() {
  const [accountIdentifier, setAccountIdentifier] = useState("");
  const [replyEmail, setReplyEmail] = useState("");
  const [note, setNote] = useState("");
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/account-deletion-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIdentifier,
          replyEmail,
          note,
          company,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || "요청을 보내지 못했습니다.");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청을 보내지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <p className="privacy-form-done" role="status">
        삭제 요청이 접수되었습니다. 운영자가 본인 여부를 확인한 뒤 계정
        정보 삭제 또는 익명화를 처리합니다. 자동으로 즉시 삭제되지는
        않습니다.
      </p>
    );
  }

  return (
    <form className="privacy-form" onSubmit={onSubmit}>
      <label className="privacy-form-label" htmlFor="deletion-account">
        계정 식별 정보
      </label>
      <input
        id="deletion-account"
        name="accountIdentifier"
        className="privacy-form-input"
        value={accountIdentifier}
        onChange={(e) => setAccountIdentifier(e.target.value)}
        autoComplete="username"
        required
        maxLength={80}
        placeholder="로그인 아이디 또는 카카오 로그인 사용 여부"
      />

      <label className="privacy-form-label" htmlFor="deletion-email">
        회신 받을 이메일
      </label>
      <input
        id="deletion-email"
        name="replyEmail"
        type="email"
        className="privacy-form-input"
        value={replyEmail}
        onChange={(e) => setReplyEmail(e.target.value)}
        autoComplete="email"
        required
        maxLength={128}
      />

      <label className="privacy-form-label" htmlFor="deletion-note">
        요청 내용 (선택)
      </label>
      <textarea
        id="deletion-note"
        name="note"
        className="privacy-form-input privacy-form-textarea"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={4}
      />

      <div className="privacy-form-hp" aria-hidden>
        <label htmlFor="deletion-company">회사</label>
        <input
          id="deletion-company"
          name="company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {error ? <p className="privacy-form-error">{error}</p> : null}

      <button type="submit" className="ui-btn ui-btn-primary" disabled={loading}>
        {loading ? "접수 중…" : "삭제 요청 보내기"}
      </button>
    </form>
  );
}
