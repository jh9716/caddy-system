"use client";

import { useRef, useEffect, useState } from "react";
import { TEST_PUSH_CONFIRM } from "@/lib/webPushTestConstants";

type Target = {
  userId: number;
  caddyId: number | null;
  name: string;
  team: string;
  role: string;
  subscriptionCount: number;
};

function roleLabel(role: string): string {
  if (role === "leader") return "조장";
  if (role === "caddy") return "캐디";
  return role;
}

export default function PushTestClient({ nativeTokenCount }: { nativeTokenCount: number }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Target[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [nativeSending, setNativeSending] = useState(false);
  const nativeLock = useRef(false);
  const canNative = nativeTokenCount >= 1;

  useEffect(() => {
    const q = query.replace(/\u00a0/g, " ").trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/push/test-targets?q=${encodeURIComponent(q)}`,
          { credentials: "include", signal: ctrl.signal }
        );
        if (res.status === 401) {
          setError("관리자만 사용할 수 있습니다.");
          setHits([]);
          return;
        }
        if (!res.ok) {
          setError("검색에 실패했습니다.");
          setHits([]);
          return;
        }
        const data = (await res.json()) as { results?: Target[] };
        setHits(Array.isArray(data.results) ? data.results : []);
        setError(null);
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setError("검색에 실패했습니다.");
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  async function sendTo(target: Target) {
    if (target.subscriptionCount < 1) return;
    const ok = window.confirm("이 캐디 1명에게 테스트 알림을 보냅니다.");
    if (!ok) return;
    setSendingId(target.userId);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: target.userId,
          confirm: TEST_PUSH_CONFIRM,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        sent?: number;
        failed?: number;
        removedStale?: number;
      };
      if (res.status === 401) {
        setError("관리자만 사용할 수 있습니다.");
        return;
      }
      if (!res.ok) {
        if (data.error === "push_not_configured") {
          setError("알림 설정 준비 중");
        } else if (data.error === "retired") {
          setError("퇴사한 캐디에게는 보낼 수 없습니다.");
        } else if (data.error === "no_subscription") {
          setNotice("등록된 알림 기기가 없습니다.");
        } else {
          setError("보내기에 실패했습니다.");
        }
        return;
      }
      if (data.error === "no_subscription") {
        setNotice("등록된 알림 기기가 없습니다.");
        return;
      }
      setNotice(
        `보냄 ${data.sent ?? 0} · 실패 ${data.failed ?? 0} · 만료 삭제 ${data.removedStale ?? 0}`
      );
    } catch {
      setError("보내기에 실패했습니다.");
    } finally {
      setSendingId(null);
    }
  }

  async function sendNative() {
    if (!canNative || nativeLock.current) return;
    const ok = window.confirm("내 Android 앱으로 테스트 알림 1건을 보냅니다.");
    if (!ok || nativeLock.current) return;
    nativeLock.current = true;
    setNativeSending(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        sent?: number;
        failed?: number;
      };
      if (res.status === 401) {
        setError("관리자만 사용할 수 있습니다.");
        return;
      }
      if (!res.ok) {
        setError("보내기에 실패했습니다.");
        return;
      }
      if (data.error === "no_native_token") {
        setNotice("등록된 Android 앱 알림이 없습니다.");
        return;
      }
      if (data.error === "fcm_send_disabled") {
        setNotice("네이티브 알림 발송이 꺼져 있습니다.");
        return;
      }
      if (data.error) {
        setError("보내기에 실패했습니다.");
        return;
      }
      setNotice(`네이티브 알림 보냄 ${data.sent ?? 0} · 실패 ${data.failed ?? 0}`);
    } catch {
      setError("보내기에 실패했습니다.");
    } finally {
      nativeLock.current = false;
      setNativeSending(false);
    }
  }

  return (
    <div className="pt-page">
      <header className="pt-head">
        <h1 className="pt-title">푸시 알림 테스트</h1>
        <p className="pt-sub">구독된 캐디 1명에게만 고정 테스트 알림을 보냅니다.</p>
      </header>

      {canNative ? (
        <section className="pt-self">
          <div>
            <strong className="pt-name">내 Android 앱</strong>
            <div className="pt-meta">이 관리자 계정의 Android 알림으로 1건만 보냅니다.</div>
          </div>
          <button
            type="button"
            className="pt-btn"
            disabled={nativeSending}
            onClick={() => void sendNative()}
          >
            {nativeSending ? "보내는 중…" : "내 Android 앱 알림 테스트"}
          </button>
        </section>
      ) : null}

      <label className="pt-search-label">
        캐디 이름 검색
        <input
          type="search"
          className="pt-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름 또는 조"
          autoComplete="off"
          spellCheck={false}
          aria-label="캐디 이름 검색"
        />
      </label>

      {error ? (
        <p className="pt-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="pt-notice">{notice}</p> : null}
      {loading ? <p className="pt-muted">검색 중…</p> : null}
      {!loading && !query.trim() ? (
        <p className="pt-empty">이름 또는 조를 입력하세요.</p>
      ) : null}

      <ul className="pt-list">
        {hits.map((hit) => {
          const canSend = hit.subscriptionCount > 0;
          return (
            <li key={hit.userId} className="pt-card">
              <div>
                <strong className="pt-name">{hit.name}</strong>
                <div className="pt-meta">
                  {hit.team || "조 없음"} · {roleLabel(hit.role)} · 알림 등록 기기{" "}
                  {hit.subscriptionCount}대
                </div>
              </div>
              <button
                type="button"
                className={`pt-btn${canSend ? "" : " is-disabled"}`}
                disabled={!canSend || sendingId === hit.userId}
                onClick={() => void sendTo(hit)}
              >
                테스트 알림 보내기
              </button>
            </li>
          );
        })}
      </ul>

      <style>{`
        .pt-page { max-width: 720px; padding-bottom: 24px; }
        .pt-head { margin-bottom: 16px; }
        .pt-title {
          margin: 0; font-size: 1.35rem; font-weight: 800;
          color: var(--vh-green-900);
        }
        .pt-sub { margin: 4px 0 0; font-size: 0.8rem; color: var(--vh-muted); }
        .pt-self {
          display: flex; justify-content: space-between; gap: 10px; align-items: center;
          margin-bottom: 14px; padding: 12px;
          border: 1px solid var(--vh-green-800); border-radius: 12px;
          background: var(--vh-paper);
        }
        .pt-search-label {
          display: grid; gap: 6px; font-size: 0.74rem; font-weight: 700;
          color: var(--vh-ink-soft);
        }
        .pt-search {
          width: 100%; min-height: 44px; padding: 8px 12px;
          border: 1px solid var(--vh-border-strong); border-radius: 10px;
          font-size: 1rem; font-family: var(--font-sans);
        }
        .pt-error { color: var(--vh-danger); font-size: 0.82rem; }
        .pt-notice { color: var(--vh-green-800); font-size: 0.82rem; font-weight: 700; }
        .pt-muted, .pt-empty { font-size: 0.8rem; color: var(--vh-muted); }
        .pt-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
        .pt-card {
          display: flex; justify-content: space-between; gap: 10px; align-items: center;
          padding: 12px; border: 1px solid var(--vh-border); border-radius: 12px;
          background: var(--vh-paper);
        }
        .pt-name { font-size: 1rem; color: var(--vh-green-900); }
        .pt-meta { margin-top: 3px; font-size: 0.78rem; color: var(--vh-muted); }
        .pt-btn {
          min-height: 36px; padding: 4px 10px; border-radius: 8px;
          border: 1px solid var(--vh-green-900); background: var(--vh-green-900);
          color: #fff; font-size: 0.78rem; font-weight: 700; cursor: pointer;
        }
        .pt-btn.is-disabled, .pt-btn:disabled {
          opacity: 0.45; cursor: not-allowed;
          background: var(--vh-paper); color: var(--vh-ink);
          border-color: var(--vh-border-strong);
        }
      `}</style>
    </div>
  );
}
