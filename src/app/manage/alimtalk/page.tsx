"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { kstYmd } from "@/lib/kstDate";
import {
  ALIMTALK_PREVIEW_EMPTY_MESSAGE,
  type AlimtalkPreviewRecipient,
  type AlimtalkWorkNoticePreview,
} from "@/lib/alimtalkWorkNoticePreview";

type FilterId = "all" | "sendable" | "missing";

export default function ManageAlimtalkPreviewPage() {
  const [date, setDate] = useState(kstYmd);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AlimtalkWorkNoticePreview | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");

  const load = useCallback(async (ymd: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/notifications/alimtalk/preview?date=${encodeURIComponent(ymd)}`,
        { credentials: "include" }
      );
      if (res.status === 401) {
        setError("관리자만 사용할 수 있습니다.");
        setPreview(null);
        return;
      }
      if (!res.ok) {
        setError("알림톡 미리보기를 불러오지 못했습니다.");
        setPreview(null);
        return;
      }
      const data = (await res.json()) as AlimtalkWorkNoticePreview;
      setPreview(data);
    } catch {
      setError("알림톡 미리보기를 불러오지 못했습니다.");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const rows = useMemo(() => {
    const list = preview?.recipients ?? [];
    if (filter === "sendable") return list.filter((row) => row.hasPhone);
    if (filter === "missing") return list.filter((row) => !row.hasPhone);
    return list;
  }, [preview, filter]);

  const published = preview?.published === true;
  const counts = preview?.counts ?? {
    recipients: 0,
    sendable: 0,
    missingPhone: 0,
  };

  return (
    <div className="at-page">
      <header className="at-head">
        <div>
          <h1 className="at-title">알림톡 근무안내</h1>
          <p className="at-banner">미리보기 전용 · 실제 발송되지 않습니다</p>
        </div>
        <label className="at-date">
          날짜
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </header>

      {error ? (
        <p className="at-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="at-muted">불러오는 중…</p> : null}

      {!loading && preview && !published ? (
        <p className="at-empty" role="status">
          {ALIMTALK_PREVIEW_EMPTY_MESSAGE}
        </p>
      ) : null}

      {!loading && published ? (
        <>
          <div className="at-counts">
            <span>게시 배치 {counts.recipients}명</span>
            <span>발송 가능 {counts.sendable}명</span>
            <span>연락처 없음 {counts.missingPhone}명</span>
          </div>
          <div className="at-filters" role="tablist" aria-label="수신자 필터">
            {(
              [
                ["all", "전체"],
                ["sendable", "발송 가능"],
                ["missing", "연락처 없음"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`at-filter${filter === id ? " is-on" : ""}`}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <ul className="at-list">
            {rows.map((row) => (
              <RecipientCard key={row.caddyId} row={row} />
            ))}
          </ul>
        </>
      ) : null}

      <style>{`
        .at-page { max-width: 720px; padding-bottom: 28px; }
        .at-head {
          display: flex; justify-content: space-between; gap: 12px;
          align-items: flex-end; margin-bottom: 14px; flex-wrap: wrap;
        }
        .at-title {
          margin: 0; font-size: 1.35rem; font-weight: 800;
          color: var(--vh-green-900);
        }
        .at-banner {
          margin: 6px 0 0; font-size: 0.8rem; font-weight: 700;
          color: var(--vh-green-800);
        }
        .at-date {
          display: grid; gap: 4px; font-size: 0.74rem; font-weight: 700;
          color: var(--vh-ink-soft);
        }
        .at-date input {
          min-height: 40px; padding: 6px 10px; border-radius: 10px;
          border: 1px solid var(--vh-border-strong); font-size: 0.95rem;
        }
        .at-error { color: var(--vh-danger); font-size: 0.82rem; }
        .at-muted, .at-empty {
          font-size: 0.88rem; color: var(--vh-muted); white-space: pre-line;
        }
        .at-counts {
          display: flex; flex-wrap: wrap; gap: 8px 14px;
          font-size: 0.82rem; font-weight: 700; color: var(--vh-green-900);
          margin-bottom: 10px;
        }
        .at-filters { display: flex; gap: 6px; margin-bottom: 10px; }
        .at-filter {
          min-height: 34px; padding: 4px 10px; border-radius: 999px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.76rem; font-weight: 700;
        }
        .at-filter.is-on {
          background: var(--vh-green-900); border-color: var(--vh-green-900);
          color: #fff;
        }
        .at-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
        .at-card {
          border: 1px solid var(--vh-border); border-radius: 12px;
          background: var(--vh-paper); padding: 10px 12px;
        }
        .at-card summary {
          cursor: pointer; list-style: none; font-weight: 700;
        }
        .at-card summary::-webkit-details-marker { display: none; }
        .at-meta { margin-top: 3px; font-size: 0.76rem; color: var(--vh-muted); font-weight: 600; }
        .at-phone { margin-top: 4px; font-size: 0.84rem; font-weight: 700; }
        .at-phone.is-missing { color: var(--vh-muted); font-weight: 600; }
        .at-msg {
          margin: 10px 0 0; padding: 10px; border-radius: 10px;
          background: #f4f7f4; font-size: 0.82rem; line-height: 1.45;
          white-space: pre-wrap; font-family: var(--font-sans);
        }
      `}</style>
    </div>
  );
}

function RecipientCard({ row }: { row: AlimtalkPreviewRecipient }) {
  return (
    <li>
      <details className="at-card">
        <summary>
          {row.name}
          <div className="at-meta">
            {row.team || "조 없음"} · {row.caddyType || "HOUSE"}
          </div>
          <div className={`at-phone${row.hasPhone ? "" : " is-missing"}`}>
            {row.hasPhone ? row.maskedPhone : "연락처 없음"}
          </div>
        </summary>
        <pre className="at-msg">{row.messagePreview}</pre>
      </details>
    </li>
  );
}
