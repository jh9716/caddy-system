"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getChatWsReuseDiagSnapshot,
  percentileMs,
  resetChatWsReuseDiag,
  reuseSuccessRate,
  startChatWsReuseDiag,
  stopChatWsReuseDiag,
  subscribeChatWsReuseDiag,
  type ChatWsReuseDiagSnapshot,
} from "@/lib/chatWsReuseDiag";

const FAIL_REASON_LABELS: Record<string, string> = {
  park_expired: "20초 TTL 만료",
  resume_timeout: "이력 대기 시간 초과",
  resume_auth: "세션/멤버십 거부",
  resume_null: "재개 실패",
  superseded: "이후 연결로 대체",
  socket_not_open: "소켓이 열려 있지 않음",
  compile_off: "재사용 컴파일 OFF",
  runtime_off: "런타임 재사용 OFF",
  no_park: "보관된 연결 없음",
  no_resume: "재개 핸들 없음",
  ws_ref: "소켓 참조 불일치",
  socket_closed: "소켓 종료",
  room_mismatch: "다른 채팅방",
  token_mismatch: "토큰 불일치",
  token_expiring: "토큰 만료 임박",
  park_false: "보관 실패",
};

function formatMs(ms: number | null): string {
  return ms == null ? "—" : `${ms}ms`;
}

function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function failEntries(snapshot: ChatWsReuseDiagSnapshot): Array<[string, number]> {
  return Object.entries(snapshot.failReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export default function ChatWsReuseDiagClient({
  adminAllowed,
}: {
  adminAllowed: boolean;
}) {
  const [snap, setSnap] = useState<ChatWsReuseDiagSnapshot>(() => getChatWsReuseDiagSnapshot());

  useEffect(() => subscribeChatWsReuseDiag(() => setSnap(getChatWsReuseDiagSnapshot())), []);

  const rate = useMemo(() => reuseSuccessRate(snap), [snap]);
  const reentryP50 = useMemo(() => percentileMs(snap.reentryMs, 50), [snap]);
  const reentryP95 = useMemo(() => percentileMs(snap.reentryMs, 95), [snap]);
  const newWsP50 = useMemo(() => percentileMs(snap.newWsMs, 50), [snap]);
  const newWsP95 = useMemo(() => percentileMs(snap.newWsMs, 95), [snap]);
  const fails = useMemo(() => failEntries(snap), [snap]);

  return (
    <div className="wsd-page">
      <header className="wsd-head">
        <div>
          <h1 className="wsd-title">채팅 성능 진단</h1>
          <p className="wsd-sub">
            WebSocket 재사용·재입장 속도. 이 기기 탭만 기록합니다. 메시지·토큰·DB 저장 없음.
          </p>
        </div>
        <span className={`wsd-badge${snap.running ? " is-on" : ""}`}>
          {snap.running ? "측정 ON" : "측정 OFF"}
        </span>
      </header>

      <div className="wsd-actions">
        <button
          type="button"
          className="wsd-btn wsd-btn-primary"
          disabled={!adminAllowed || snap.running}
          onClick={() => startChatWsReuseDiag({ adminAllowed })}
        >
          측정 시작
        </button>
        <button
          type="button"
          className="wsd-btn"
          disabled={!snap.running}
          onClick={() => stopChatWsReuseDiag()}
        >
          측정 종료
        </button>
        <button type="button" className="wsd-btn" onClick={() => resetChatWsReuseDiag()}>
          기록 초기화
        </button>
        <Link href="/chat" className="wsd-btn wsd-btn-link">
          채팅 열기
        </Link>
      </div>

      <p className="wsd-hint">
        시작 → 채팅 열기 → 방 입장 → 목록으로 나갔다가 다시 들어가기 → 이 화면으로 돌아오면 됩니다.
        전체 새로고침은 집계만 유지하고, 로그아웃하면 즉시 삭제합니다.
      </p>

      <section className="wsd-grid" aria-label="측정 결과">
        <Metric label="신규 WebSocket" value={String(snap.newWs)} />
        <Metric label="재입장 신규 연결" value={String(snap.newWsOnReentry)} />
        <Metric label="park 시도" value={String(snap.parkAttempts)} />
        <Metric label="park 성공" value={String(snap.parkOk)} />
        <Metric label="resume 시도" value={String(snap.resumeAttempts)} />
        <Metric label="resume 성공" value={String(snap.resumeOk)} />
        <Metric label="resume 실패" value={String(snap.resumeFail)} />
        <Metric label="재사용 성공률" value={formatRate(rate)} />
        <Metric label="재입장 p50" value={formatMs(reentryP50)} />
        <Metric label="재입장 p95" value={formatMs(reentryP95)} />
        <Metric label="신규 연결 p50" value={formatMs(newWsP50)} />
        <Metric label="신규 연결 p95" value={formatMs(newWsP95)} />
        <Metric label="20초 TTL 만료" value={String(snap.ttlExpired)} />
        <Metric label="park 건너뜀" value={String(snap.parkSkip)} />
      </section>

      <section className="wsd-fails">
        <h2 className="wsd-section-title">resume 실패·건너뜀 원인</h2>
        {fails.length === 0 ? (
          <p className="wsd-empty">아직 실패 기록이 없습니다.</p>
        ) : (
          <ul className="wsd-fail-list">
            {fails.map(([code, count]) => (
              <li key={code} className="wsd-fail-row">
                <span>
                  <strong>{FAIL_REASON_LABELS[code] || code}</strong>
                  <span className="wsd-fail-code">{code}</span>
                </span>
                <span className="wsd-fail-count">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <style>{`
        .wsd-page { max-width: 720px; padding-bottom: 28px; }
        .wsd-head {
          display: flex; justify-content: space-between; gap: 12px;
          align-items: flex-start; margin-bottom: 14px;
        }
        .wsd-title {
          margin: 0; font-size: 1.28rem; font-weight: 800;
          color: var(--vh-green-900); line-height: 1.15;
        }
        .wsd-sub { margin: 6px 0 0; font-size: 0.78rem; color: var(--vh-muted); line-height: 1.4; }
        .wsd-badge {
          flex: none; margin-top: 2px; padding: 6px 10px; border-radius: 999px;
          border: 1px solid var(--vh-border-strong); font-size: 0.72rem; font-weight: 800;
          color: var(--vh-muted); background: var(--vh-paper);
        }
        .wsd-badge.is-on {
          color: #fff; background: var(--vh-green-900); border-color: var(--vh-green-900);
        }
        .wsd-actions {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;
        }
        .wsd-btn {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 44px; padding: 8px 10px; border-radius: 10px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.86rem; font-weight: 800; color: var(--vh-ink);
          text-decoration: none;
        }
        .wsd-btn-primary {
          background: var(--vh-green-900); border-color: var(--vh-green-900); color: #fff;
        }
        .wsd-btn:disabled { opacity: 0.42; }
        .wsd-btn-link { grid-column: 1 / -1; }
        .wsd-hint {
          margin: 0 0 14px; font-size: 0.76rem; color: var(--vh-muted); line-height: 1.45;
        }
        .wsd-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px;
        }
        .wsd-metric {
          padding: 12px; border: 1px solid var(--vh-border); border-radius: 12px;
          background: var(--vh-paper);
        }
        .wsd-metric-label {
          display: block; font-size: 0.7rem; font-weight: 800; color: var(--vh-green-800);
        }
        .wsd-metric-value {
          display: block; margin-top: 6px; font-size: 1.18rem; font-weight: 800;
          color: var(--vh-green-900); font-variant-numeric: tabular-nums;
        }
        .wsd-section-title {
          margin: 0 0 8px; font-size: 0.78rem; font-weight: 800; color: var(--vh-green-800);
        }
        .wsd-empty { margin: 0; font-size: 0.8rem; color: var(--vh-muted); }
        .wsd-fail-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        .wsd-fail-row {
          display: flex; justify-content: space-between; gap: 10px; align-items: baseline;
          padding: 10px 12px; border: 1px solid var(--vh-border); border-radius: 10px;
          background: var(--vh-paper);
        }
        .wsd-fail-code {
          display: block; margin-top: 2px; font-size: 0.68rem; color: var(--vh-muted);
        }
        .wsd-fail-count { font-weight: 800; color: var(--vh-green-900); font-variant-numeric: tabular-nums; }
        @media (max-width: 420px) {
          .wsd-title { font-size: 1.12rem; }
          .wsd-metric-value { font-size: 1.05rem; }
        }
      `}</style>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="wsd-metric">
      <span className="wsd-metric-label">{label}</span>
      <span className="wsd-metric-value">{value}</span>
    </div>
  );
}
