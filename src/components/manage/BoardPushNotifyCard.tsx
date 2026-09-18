"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BOARD_PUSH_CONFIRM,
  BOARD_PUSH_STALE_MESSAGE,
  BOARD_PUSH_STALE_UI_LABEL,
} from "@/lib/boardPushConstants";

type FreshnessStatus =
  | "CURRENT"
  | "STALE"
  | "NO_PUBLISHED"
  | "UNKNOWN"
  | "PUBLISHED_ONLY";

type Preview = {
  date: string;
  published: boolean;
  freshness: {
    status: FreshnessStatus;
    canSend: boolean;
    publishedVersion: number | null;
    currentDraftVersion: number | null;
  };
  canSend: boolean;
  sourceDraftVersion: number | null;
  currentDraftVersion: number | null;
  alreadySent: boolean;
  counts: {
    assignedCaddies: number;
    linkedUsers: number;
    subscribedUsers: number;
    subscriptions: number;
    noUser: number;
    noSubscription: number;
  };
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

function versionLine(preview: Preview): string {
  const pub = preview.sourceDraftVersion ?? preview.freshness.publishedVersion;
  const cur = preview.currentDraftVersion ?? preview.freshness.currentDraftVersion;
  if (pub == null && cur == null) return "게시본 없음";
  if (preview.freshness.status === "STALE") {
    return `게시본 v${pub ?? "—"} · 작업본 v${cur ?? "—"}`;
  }
  if (cur == null) {
    return `게시본 v${pub ?? "—"} · 현재 작업본 없음`;
  }
  return `게시본 v${pub ?? "—"} · 현재 작업본 v${cur}`;
}

export function BoardPushNotifyCard({ date }: { date: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setPreview(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/push/board-preview?date=${encodeURIComponent(date)}`,
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
  }, [date]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  async function onSend() {
    if (!preview?.canSend || preview.alreadySent || sending) return;
    const ok = window.confirm(
      `${date} 배치표 알림을 구독 중인 캐디에게 보냅니다.`
    );
    if (!ok) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/push/board-send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, confirm: BOARD_PUSH_CONFIRM }),
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

  const stale = preview?.freshness.status === "STALE";
  const sendDisabled =
    sending ||
    loading ||
    !preview?.canSend ||
    preview?.alreadySent === true;

  return (
    <section className="ops-board-push" aria-label="배치표 알림">
      <h2 className="ops-board-push-title">배치표 알림</h2>
      {loading && !preview ? (
        <p className="ops-board-push-meta">확인 중…</p>
      ) : null}
      {preview ? (
        <>
          <p className="ops-board-push-meta">{versionLine(preview)}</p>
          {stale ? (
            <p className="ops-board-push-stale">{BOARD_PUSH_STALE_UI_LABEL}</p>
          ) : null}
          {stale ? (
            <p className="ops-board-push-hint">{BOARD_PUSH_STALE_MESSAGE}</p>
          ) : null}
          <p className="ops-board-push-meta">
            배치 {preview.counts.assignedCaddies}명
          </p>
          <p className="ops-board-push-meta">
            알림 가능 {preview.counts.subscribedUsers}명 / 등록 기기{" "}
            {preview.counts.subscriptions}대
          </p>
          {preview.alreadySent ? (
            <p className="ops-board-push-meta">이 게시본 알림은 이미 보냈습니다.</p>
          ) : null}
        </>
      ) : null}
      {stale ? (
        <button
          type="button"
          className="btn ghost ops-board-push-btn"
          onClick={() => void load()}
          disabled={loading || sending}
        >
          배치표 다시 확인
        </button>
      ) : null}
      <button
        type="button"
        className="btn primary ops-board-push-btn"
        disabled={sendDisabled}
        onClick={() => void onSend()}
      >
        {sending ? "보내는 중…" : "배치표 알림 보내기"}
      </button>
      {result ? (
        <p className="ops-board-push-result" role="status">
          {result.error === "no_recipients"
            ? "구독 중인 캐디가 없습니다."
            : `발송 ${result.sent} · 실패 ${result.failed} · 만료 삭제 ${result.removedStale} (대상 ${result.recipients}명 / 기기 ${result.subscriptions}대)`}
        </p>
      ) : null}
      {error ? <p className="ops-board-push-error">{error}</p> : null}
    </section>
  );
}
