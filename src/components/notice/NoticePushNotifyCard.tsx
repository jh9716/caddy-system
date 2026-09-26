"use client";

import { useCallback, useEffect, useState } from "react";
import { formatKstDisplay } from "@/lib/kstDate";
import {
  NOTICE_PUSH_CONFIRM,
  NOTICE_PUSH_CONFIRM_UI,
  NOTICE_PUSH_DELIVERY_FAILED_MESSAGE,
  NOTICE_PUSH_DONE_LABEL,
  NOTICE_PUSH_SEND_BUTTON,
} from "@/lib/noticeConstants";

type Preview = {
  noticeId: number;
  targetType: string;
  targetValue: string | null;
  counts: {
    eligibleUsers: number;
    subscribedUsers: number;
    subscriptions: number;
    noSubscription: number;
  };
  canSend: boolean;
  alreadySent: boolean;
  pushSentAt: string | null;
};

type SendResult = {
  ok: boolean;
  recipients: number;
  subscriptions: number;
  sent: number;
  failed: number;
  removedStale: number;
  error?: string;
};

export default function NoticePushNotifyCard({
  noticeId,
  pushSentAt = null,
}: {
  noticeId: number;
  pushSentAt?: string | null;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/push/notice-preview?noticeId=${encodeURIComponent(String(noticeId))}`,
        { credentials: "include", cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreview(null);
        setError(typeof data.message === "string" ? data.message : "미리보기 실패");
        return;
      }
      setPreview(data as Preview);
    } catch {
      setPreview(null);
      setError("미리보기 실패");
    } finally {
      setLoading(false);
    }
  }, [noticeId]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  async function onSend() {
    if (!preview?.canSend || preview.alreadySent || sending) return;
    const ok = window.confirm(NOTICE_PUSH_CONFIRM_UI);
    if (!ok) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/push/notice-send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noticeId, confirm: NOTICE_PUSH_CONFIRM }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.message === "string"
            ? data.message
            : typeof data.error === "string"
              ? data.error
              : "발송 실패"
        );
        await load();
        return;
      }
      setResult(data as SendResult);
      await load();
    } catch {
      setError("발송 실패");
    } finally {
      setSending(false);
    }
  }

  const alreadySent = preview?.alreadySent === true || Boolean(pushSentAt);
  const sentAt = preview?.pushSentAt ?? pushSentAt;
  const sendDisabled =
    sending || loading || !preview?.canSend || alreadySent;

  return (
    <section className="notice-push" aria-label="푸시 알림">
      <h2 className="notice-push-title">푸시 알림</h2>
      {loading && !preview ? <p className="notice-push-meta">확인 중…</p> : null}
      {preview ? (
        <>
          <p className="notice-push-meta">대상 {preview.counts.eligibleUsers}명</p>
          <p className="notice-push-meta">
            알림 가능 {preview.counts.subscribedUsers}명 · 기기{" "}
            {preview.counts.subscriptions}대
          </p>
        </>
      ) : null}
      {alreadySent ? (
        <p className="notice-push-done">
          {NOTICE_PUSH_DONE_LABEL}
          {sentAt ? ` · ${formatKstDisplay(sentAt, "ymd-hm")}` : ""}
        </p>
      ) : (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={sendDisabled}
          onClick={() => void onSend()}
        >
          {sending ? "보내는 중…" : NOTICE_PUSH_SEND_BUTTON}
        </button>
      )}
      {result ? (
        <p className="notice-push-result" role="status">
          {result.error === "no_recipients"
            ? "구독 중인 캐디가 없습니다."
            : result.error === "delivery_failed"
              ? NOTICE_PUSH_DELIVERY_FAILED_MESSAGE
              : `발송 ${result.sent} · 실패 ${result.failed} · 만료 삭제 ${result.removedStale}`}
        </p>
      ) : null}
      {error ? <p className="notice-push-error">{error}</p> : null}
    </section>
  );
}
