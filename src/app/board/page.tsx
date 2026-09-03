"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BoardImageExportMenu } from "@/components/board/BoardImageExportMenu";
import PublishedBoardView from "@/components/board/PublishedBoardView";
import { assignmentDraftFromPublishedPayload } from "@/lib/assignmentBoardExport";
import {
  addDaysYmd,
  formatPublishedAt,
  todayYmd,
  type DailyBoardPublishedPayloadV1,
} from "@/lib/dailyBoardPublished";
import { type ShiftPart } from "@/lib/reservationParser";

type PublishedResponse = {
  ok?: boolean;
  date?: string;
  published?: {
    date: string;
    sourceDraftVersion: number;
    payload: DailyBoardPublishedPayloadV1;
    publishedAt: string;
    publishedByUsername?: string | null;
  } | null;
  error?: string;
};

export default function PublishedBoardPage() {
  const [date, setDate] = useState(todayYmd);
  const [shift, setShift] = useState<ShiftPart>("1부");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishedResponse["published"]>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const exportDraft = useMemo(
    () =>
      published?.payload
        ? assignmentDraftFromPublishedPayload(published.payload)
        : null,
    [published]
  );

  const today = useMemo(() => todayYmd(), []);
  const yesterday = useMemo(() => addDaysYmd(today, -1), [today]);

  const load = useCallback(async (ymd: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/assignments/published?date=${encodeURIComponent(ymd)}`,
        { credentials: "include", cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as PublishedResponse;
      if (!res.ok) {
        throw new Error(data.error || "배치표 조회 실패");
      }
      setPublished(data.published ?? null);
    } catch (e: unknown) {
      setPublished(null);
      setError(e instanceof Error ? e.message : "배치표 조회 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  return (
    <div className="pub-page">
      <header className="pub-head">
        <h1>배치표</h1>
        <p>확정된 날짜별 최종 배치표입니다.</p>
      </header>

      <div className="pub-dates" role="group" aria-label="날짜">
        <button
          type="button"
          className={date === today ? "on" : ""}
          onClick={() => setDate(today)}
        >
          오늘
        </button>
        <button
          type="button"
          className={date === yesterday ? "on" : ""}
          onClick={() => setDate(yesterday)}
        >
          어제
        </button>
        <label className="pub-date-pick">
          <span>날짜 선택</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>

      <nav className="pub-shifts" aria-label="부">
        <button
          type="button"
          className={shift === "1부" ? "on" : ""}
          onClick={() => setShift("1부")}
        >
          1부
        </button>
        <button
          type="button"
          className={shift === "2부" ? "on" : ""}
          onClick={() => setShift("2부")}
        >
          2부
        </button>
        <button
          type="button"
          className={shift === "3부" ? "on" : ""}
          onClick={() => setShift("3부")}
        >
          3부
        </button>
      </nav>

      {loading ? <p className="pub-msg">불러오는 중…</p> : null}
      {error ? <p className="pub-msg error">{error}</p> : null}
      {!loading && !error && !published ? (
        <p className="pub-empty">아직 확정된 배치표가 없습니다.</p>
      ) : null}
      {!loading && published ? (
        <>
          <div className="pub-tools">
            <p className="pub-meta">
              {published.date} · {formatPublishedAt(published.publishedAt)} 확정
            </p>
            {exportDraft ? (
              <BoardImageExportMenu draft={exportDraft} onNotice={setNotice} />
            ) : null}
          </div>
          {notice ? <p className="pub-notice">{notice}</p> : null}
          <PublishedBoardView payload={published.payload} shift={shift} />
        </>
      ) : null}

      <style>{`
        .pub-page {
          max-width: 720px;
          margin: 0 auto;
          padding: 12px 10px 72px;
          display: grid;
          gap: 10px;
        }
        .pub-head h1 {
          margin: 0;
          font-size: 1.25rem;
        }
        .pub-head p {
          margin: 4px 0 0;
          color: #64748b;
          font-size: 0.85rem;
        }
        .pub-dates,
        .pub-shifts {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .pub-dates button,
        .pub-shifts button {
          min-height: 36px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          background: #fff;
          font-weight: 700;
        }
        .pub-dates button.on,
        .pub-shifts button.on {
          background: #0f172a;
          color: #fff;
          border-color: #0f172a;
        }
        .pub-date-pick {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.8rem;
          color: #64748b;
        }
        .pub-date-pick input {
          min-height: 36px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 0 8px;
        }
        .pub-msg, .pub-empty, .pub-meta, .pub-notice {
          margin: 0;
          font-size: 0.9rem;
        }
        .pub-empty { color: #475569; padding: 24px 4px; }
        .pub-msg.error { color: #b91c1c; }
        .pub-meta { color: #64748b; }
        .pub-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .pub-notice { color: #334155; }
      `}</style>
    </div>
  );
}
