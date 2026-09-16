"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { kstYmd } from "@/lib/kstDate";
import {
  ALIMTALK_ASSIGNMENTS_HREF,
  ALIMTALK_BADGE_CURRENT,
  ALIMTALK_BADGE_STALE,
  ALIMTALK_CANNOT_SEND_LABEL,
  ALIMTALK_GO_ASSIGNMENTS_LABEL,
  ALIMTALK_SENDABLE_STATUS_LABEL,
  ALIMTALK_STALE_PREVIEW_NOTE,
  ALIMTALK_STALE_REPUBLISH_HINT,
  ALIMTALK_STALE_TITLE,
  alimtalkBlockedCountLabel,
  alimtalkCurrentDraftVersionLine,
  alimtalkCurrentPublishedVersionLine,
  alimtalkReadyCountLabel,
  alimtalkStaleDraftVersionLine,
  alimtalkStalePublishedVersionLine,
  type AlimtalkPublishedFreshness,
} from "@/lib/alimtalkPublishedFreshness";
import {
  ALIMTALK_PREVIEW_EMPTY_MESSAGE,
  type AlimtalkPreviewRecipient,
  type AlimtalkWorkNoticePreview,
} from "@/lib/alimtalkWorkNoticePreview";

type FilterId = "all" | "ready" | "missing";

function freshnessOf(
  preview: AlimtalkWorkNoticePreview | null
): AlimtalkPublishedFreshness | null {
  return preview?.freshness ?? null;
}

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

  const freshness = freshnessOf(preview);
  const canSend = freshness?.canSend === true;
  const stale = freshness?.status === "STALE";
  const rows = useMemo(() => {
    const list = preview?.recipients ?? [];
    if (filter === "ready") return list.filter((row) => row.hasPhone);
    if (filter === "missing") return list.filter((row) => !row.hasPhone);
    return list;
  }, [preview, filter]);

  const published = preview?.published === true;
  const counts = preview?.counts ?? {
    recipients: 0,
    sendable: 0,
    contactReady: 0,
    missingPhone: 0,
  };
  const contactReady = counts.contactReady ?? counts.sendable ?? 0;
  const readyFilterLabel = alimtalkReadyCountLabel(canSend);
  const blockedLabel = alimtalkBlockedCountLabel(freshness?.status ?? "NO_PUBLISHED");
  const showCurrentBadge = canSend;

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
          <div className="at-status-row">
            {showCurrentBadge ? (
              <span className="at-badge is-current">{ALIMTALK_BADGE_CURRENT}</span>
            ) : (
              <span className="at-badge is-stale">
                {stale ? ALIMTALK_BADGE_STALE : ALIMTALK_CANNOT_SEND_LABEL}
              </span>
            )}
          </div>

          {stale ? (
            <div className="at-stale" role="alert">
              <strong>{ALIMTALK_STALE_TITLE}</strong>
              <p className="at-stale-versions">
                {alimtalkStalePublishedVersionLine(freshness?.publishedVersion)}
              </p>
              <p className="at-stale-versions">
                {alimtalkStaleDraftVersionLine(freshness?.currentDraftVersion)}
              </p>
              <p>{ALIMTALK_STALE_PREVIEW_NOTE}</p>
              <p>{ALIMTALK_STALE_REPUBLISH_HINT}</p>
              <Link className="at-go" href={ALIMTALK_ASSIGNMENTS_HREF}>
                {ALIMTALK_GO_ASSIGNMENTS_LABEL}
              </Link>
            </div>
          ) : null}

          {showCurrentBadge ? (
            <div className="at-current" role="status">
              <p className="at-current-versions">
                {alimtalkCurrentPublishedVersionLine(freshness?.publishedVersion)}
              </p>
              <p className="at-current-versions">
                {alimtalkCurrentDraftVersionLine(freshness?.currentDraftVersion)}
              </p>
              <p>{ALIMTALK_SENDABLE_STATUS_LABEL}</p>
            </div>
          ) : null}

          <div className="at-counts">
            <span>대상 {counts.recipients}명</span>
            <span>
              {readyFilterLabel} {contactReady}명
            </span>
            <span>연락처 없음 {counts.missingPhone}명</span>
            {blockedLabel ? (
              <span className="at-nosend">{blockedLabel}</span>
            ) : null}
          </div>
          <div className="at-filters" role="tablist" aria-label="수신자 필터">
            {(
              [
                ["all", "전체"],
                ["ready", readyFilterLabel],
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
          {stale ? (
            <p className="at-preview-basis" role="note">
              {ALIMTALK_STALE_PREVIEW_NOTE}
            </p>
          ) : null}
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
        .at-status-row { margin-bottom: 10px; }
        .at-badge {
          display: inline-block; padding: 4px 10px; border-radius: 999px;
          font-size: 0.76rem; font-weight: 800;
        }
        .at-badge.is-current {
          background: #e7f3ea; color: var(--vh-green-900);
        }
        .at-badge.is-stale {
          background: #fdecec; color: #8a1f1f;
        }
        .at-stale {
          margin-bottom: 12px; padding: 12px 14px; border-radius: 12px;
          border: 1px solid #e7b0b0; background: #fff6f6;
          color: #6b1d1d; font-size: 0.86rem; line-height: 1.45;
        }
        .at-stale strong { display: block; font-size: 0.95rem; margin-bottom: 6px; }
        .at-stale p { margin: 4px 0; }
        .at-stale-versions { font-weight: 800; }
        .at-current {
          margin-bottom: 12px; padding: 12px 14px; border-radius: 12px;
          border: 1px solid #b7d4be; background: #f3faf4;
          color: var(--vh-green-900); font-size: 0.86rem; line-height: 1.45;
        }
        .at-current p { margin: 4px 0; }
        .at-current-versions { font-weight: 800; }
        .at-preview-basis {
          margin: 0 0 8px; font-size: 0.78rem; font-weight: 700;
          color: #8a1f1f;
        }
        .at-go {
          display: inline-block; margin-top: 8px; font-weight: 800;
          color: var(--vh-green-900); text-decoration: underline;
        }
        .at-counts {
          display: flex; flex-wrap: wrap; gap: 8px 14px;
          font-size: 0.82rem; font-weight: 700; color: var(--vh-green-900);
          margin-bottom: 10px;
        }
        .at-nosend { color: #8a1f1f; }
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
