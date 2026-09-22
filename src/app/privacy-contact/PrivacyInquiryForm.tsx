"use client";

import { useState } from "react";
import Link from "next/link";
import { ACCOUNT_DELETION_PATH } from "@/lib/privacy";
import {
  PRIVACY_INQUIRY_TOPIC_LABELS,
  PRIVACY_INQUIRY_TOPICS,
  type PrivacyInquiryTopic,
} from "@/lib/privacyInquiryRequest";

export default function PrivacyInquiryForm() {
  const [topic, setTopic] = useState<PrivacyInquiryTopic>("privacy_inquiry");
  const [replyEmail, setReplyEmail] = useState("");
  const [message, setMessage] = useState("");
  const [accountIdentifier, setAccountIdentifier] = useState("");
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<"inquiry" | "deletion" | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/privacy-inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          replyEmail,
          message,
          accountIdentifier,
          company,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || "요청을 보내지 못했습니다.");
      }
      setDone(topic === "account_deletion" ? "deletion" : "inquiry");
    } catch (err) {
      setError(err instanceof Error ? err.message : "요청을 보내지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  if (done === "deletion") {
    return (
      <p className="privacy-form-done" role="status">
        삭제 요청이 접수되었습니다. 운영자가 본인 여부를 확인한 뒤 계정
        정보 삭제 또는 익명화를 처리합니다. 자동으로 즉시 삭제되지는
        않습니다.
      </p>
    );
  }

  if (done === "inquiry") {
    return (
      <p className="privacy-form-done" role="status">
        개인정보 문의가 접수되었습니다. 운영자가 확인한 뒤 회신합니다.
      </p>
    );
  }

  return (
    <form className="privacy-form" onSubmit={onSubmit}>
      <label className="privacy-form-label" htmlFor="inquiry-topic">
        문의 유형
      </label>
      <select
        id="inquiry-topic"
        name="topic"
        className="privacy-form-input"
        value={topic}
        onChange={(e) => setTopic(e.target.value as PrivacyInquiryTopic)}
        required
      >
        {PRIVACY_INQUIRY_TOPICS.map((value) => (
          <option key={value} value={value}>
            {PRIVACY_INQUIRY_TOPIC_LABELS[value]}
          </option>
        ))}
      </select>

      {topic === "account_deletion" ? (
        <>
          <p className="privacy-form-hint">
            계정 삭제는{" "}
            <Link href={ACCOUNT_DELETION_PATH}>계정 삭제 요청</Link>{" "}
            페이지에서도 접수할 수 있습니다.
          </p>
          <label className="privacy-form-label" htmlFor="inquiry-account">
            계정 식별 정보
          </label>
          <input
            id="inquiry-account"
            name="accountIdentifier"
            className="privacy-form-input"
            value={accountIdentifier}
            onChange={(e) => setAccountIdentifier(e.target.value)}
            autoComplete="username"
            required
            maxLength={80}
            placeholder="로그인 아이디 또는 카카오 로그인 사용 여부"
          />
        </>
      ) : null}

      <label className="privacy-form-label" htmlFor="inquiry-email">
        회신 받을 이메일
      </label>
      <input
        id="inquiry-email"
        name="replyEmail"
        type="email"
        className="privacy-form-input"
        value={replyEmail}
        onChange={(e) => setReplyEmail(e.target.value)}
        autoComplete="email"
        required
        maxLength={128}
      />

      <label className="privacy-form-label" htmlFor="inquiry-message">
        문의 내용
      </label>
      <textarea
        id="inquiry-message"
        name="message"
        className="privacy-form-input privacy-form-textarea"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        required
        maxLength={500}
        rows={5}
      />

      <div className="privacy-form-hp" aria-hidden>
        <label htmlFor="inquiry-company">회사</label>
        <input
          id="inquiry-company"
          name="company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {error ? <p className="privacy-form-error">{error}</p> : null}

      <button type="submit" className="ui-btn ui-btn-primary" disabled={loading}>
        {loading ? "접수 중…" : "문의 보내기"}
      </button>
    </form>
  );
}
