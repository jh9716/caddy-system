'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AvailabilityResult, AvailabilityRow } from '@/lib/availabilityEngine';

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function RowList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: AvailabilityRow[];
  empty: string;
}) {
  return (
    <section className="av-section">
      <h3>
        {title} <span className="av-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="av-muted">{empty}</p>
      ) : (
        <ul className="av-list">
          {rows.map((r) => (
            <li key={r.id} className="av-item">
              <div className="av-id">#{r.id}</div>
              <strong>{r.name}</strong>
              <span className="av-pill">{r.team}</span>
              <span className="av-pill muted">순번 {r.teamOrder}</span>
              <span className="av-pill muted">{r.caddyType}</span>
              {r.extraFlags.map((f) => (
                <span key={f} className="av-pill accent">
                  {f}
                </span>
              ))}
              {r.specialTags.map((t) => (
                <span key={t} className="av-pill warn">
                  {t}
                </span>
              ))}
              {r.excludedReasons.length > 0 && (
                <div className="av-reasons">
                  제외: {r.excludedReasons.join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ManageAvailabilityPage() {
  const [date, setDate] = useState(todayYmd);
  const [data, setData] = useState<AvailabilityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/availability?date=${encodeURIComponent(date)}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (res.status === 401 || res.status === 403) {
        location.href = `/login?callbackUrl=/manage/availability`;
        return;
      }
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || '불러오기 실패');
        setData(null);
        return;
      }
      setData(json as AvailabilityResult);
    } finally {
      setLoading(false);
    }
  }, [date]);

  const summary = useMemo(() => {
    if (!data) return null;
    return data.counts;
  }, [data]);

  return (
    <div className="av-page">
      <header className="av-header">
        <div>
          <h2>가용 캐디 계산 (1단계)</h2>
          <p className="av-sub">
            날짜 기준 일반가용 / 특별찾근·고정 / 제외 사유. 자동배치는 아직 없음.
          </p>
        </div>
      </header>

      <section className="av-toolbar">
        <label>
          날짜
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button type="button" className="av-btn" onClick={load} disabled={loading}>
          {loading ? '계산 중…' : '가용 계산'}
        </button>
      </section>

      {error && <div className="av-error">{error}</div>}

      {summary && (
        <div className="av-summary">
          {data?.date} · 일반가용 {summary.available} (HOUSE {summary.byType.HOUSE} /
          THIRD {summary.byType.THIRD} / DRIVING {summary.byType.DRIVING}) · 특별{' '}
          {summary.special} · 제외 {summary.excluded}
        </div>
      )}

      {data && (
        <>
          <RowList
            title="일반 가용"
            rows={data.available.all}
            empty="해당일 일반 가용 캐디 없음"
          />
          <RowList
            title="특별찾근 / 고정배치"
            rows={data.special}
            empty="특별 태그 캐디 없음"
          />
          <RowList
            title="제외"
            rows={data.excluded}
            empty="제외 캐디 없음"
          />

          <section className="av-section">
            <h3>조별 일반가용</h3>
            {data.available.byTeam.length === 0 ? (
              <p className="av-muted">없음</p>
            ) : (
              data.available.byTeam.map((col) => (
                <div key={col.team} className="av-team">
                  <h4>
                    {col.team} ({col.rows.length})
                  </h4>
                  <ol>
                    {col.rows.map((r) => (
                      <li key={r.id}>
                        #{r.id} {r.name} · 순번 {r.teamOrder} · {r.caddyType}
                        {r.extraFlags.length > 0 ? ` · ${r.extraFlags.join('/')}` : ''}
                      </li>
                    ))}
                  </ol>
                </div>
              ))
            )}
          </section>
        </>
      )}

      <style>{`
        .av-page { max-width: 920px; margin: 0 auto; padding-bottom: 48px; }
        .av-header { margin-bottom: 12px; }
        .av-header h2 { margin: 0; font-size: 1.3rem; font-weight: 800; }
        .av-sub { margin: 4px 0 0; color: #64748b; font-size: 0.85rem; }
        .av-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin: 12px 0; }
        .av-toolbar label { display: grid; gap: 4px; font-size: 0.85rem; }
        .av-toolbar input { padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 16px; }
        .av-btn { padding: 10px 14px; border-radius: 8px; border: 0; background: #0f172a; color: #fff; font-weight: 600; cursor: pointer; }
        .av-btn:disabled { opacity: 0.6; }
        .av-error { background: #fff1f2; color: #9f1239; border: 1px solid #fecdd3; padding: 8px 10px; border-radius: 8px; margin-bottom: 10px; }
        .av-summary { font-size: 0.9rem; color: #334155; margin-bottom: 12px; }
        .av-section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
        .av-section h3 { margin: 0 0 8px; font-size: 1rem; }
        .av-count { color: #64748b; font-weight: 600; }
        .av-muted { color: #94a3b8; font-size: 0.9rem; }
        .av-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
        .av-item { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .av-id { color: #94a3b8; font-size: 0.75rem; width: 100%; }
        .av-pill { display: inline-flex; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; font-size: 0.75rem; }
        .av-pill.muted { color: #64748b; }
        .av-pill.accent { background: #e0f2fe; color: #075985; }
        .av-pill.warn { background: #ffedd5; color: #9a3412; }
        .av-reasons { width: 100%; color: #b45309; font-size: 0.8rem; }
        .av-team { margin-top: 10px; }
        .av-team h4 { margin: 0 0 4px; }
        .av-team ol { margin: 0; padding-left: 1.2rem; }
      `}</style>
    </div>
  );
}
