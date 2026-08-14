'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AvailabilityResult, AvailabilityRow } from '@/lib/availabilityEngine';
import { PRIMARY_TEAMS } from '@/lib/caddyManage';

const GLANCE_TEAMS = PRIMARY_TEAMS.slice(0, 8) as readonly string[];

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function DensePersonList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: AvailabilityRow[];
  empty: string;
}) {
  return (
    <section className="av-panel">
      <h3 className="av-panel-title">
        {title} <span className="av-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="av-muted">{empty}</p>
      ) : (
        <ul className="av-dense">
          {rows.map((r) => (
            <li key={r.id} className="av-dense-row">
              <strong>{r.name}</strong>
              <span className="av-meta">{r.team}</span>
              <span className="av-num">{r.teamOrder}</span>
              <span className="av-meta muted">{r.caddyType}</span>
              {(r.extraFlags.length > 0 || r.specialTags.length > 0) && (
                <span className="av-tags">
                  {[...r.extraFlags, ...r.specialTags].join(' · ')}
                </span>
              )}
              {r.excludedReasons.length > 0 && (
                <span className="av-reason">{r.excludedReasons.join(', ')}</span>
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
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');

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

  const summary = useMemo(() => (data ? data.counts : null), [data]);

  const teamGlance = useMemo(() => {
    const map = new Map(
      (data?.available.byTeam ?? []).map((col) => [col.team, col.rows.length])
    );
    const specialByTeam = new Map<string, number>();
    const excludedByTeam = new Map<string, number>();
    for (const r of data?.special ?? []) {
      specialByTeam.set(r.team, (specialByTeam.get(r.team) ?? 0) + 1);
    }
    for (const r of data?.excluded ?? []) {
      excludedByTeam.set(r.team, (excludedByTeam.get(r.team) ?? 0) + 1);
    }
    return GLANCE_TEAMS.map((team) => ({
      team,
      available: map.get(team) ?? 0,
      special: specialByTeam.get(team) ?? 0,
      excluded: excludedByTeam.get(team) ?? 0,
    }));
  }, [data]);

  return (
    <div className="av-page">
      <header className="av-header">
        <div>
          <h1 className="av-title">가용표</h1>
          <p className="av-date">{date}</p>
        </div>
        <div className="av-header-actions">
          {data && (
            <div className="av-tabs" role="tablist" aria-label="보기 모드">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'summary'}
                className={viewMode === 'summary' ? 'is-active' : ''}
                onClick={() => setViewMode('summary')}
              >
                한눈에 보기
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'detail'}
                className={viewMode === 'detail' ? 'is-active' : ''}
                onClick={() => setViewMode('detail')}
              >
                상세 보기
              </button>
            </div>
          )}
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
        <button
          type="button"
          className="av-btn av-btn-primary"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? '계산 중…' : '가용 계산'}
        </button>
      </section>

      {error && <div className="av-banner-error">{error}</div>}

      {summary && (
        <div className="av-kpi">
          <article className="av-kpi-card">
            <div className="lbl">일반가용</div>
            <div className="val">{summary.available}</div>
          </article>
          <article className="av-kpi-card">
            <div className="lbl">특별/고정</div>
            <div className="val">{summary.special}</div>
          </article>
          <article className="av-kpi-card">
            <div className="lbl">제외</div>
            <div className="val">{summary.excluded}</div>
          </article>
        </div>
      )}

      {data && viewMode === 'summary' && (
        <section className="av-panel">
          <div className="av-panel-head">
            <h2 className="av-panel-title">조별 현황 (1~8조)</h2>
            <button
              type="button"
              className="av-link"
              onClick={() => setViewMode('detail')}
            >
              상세 보기 →
            </button>
          </div>
          <div className="av-team-grid">
            {teamGlance.map((t) => (
              <button
                key={t.team}
                type="button"
                className="av-team-card"
                onClick={() => setViewMode('detail')}
              >
                <div className="av-team-name">{t.team}</div>
                <ul className="av-team-stats">
                  <li>
                    <span className="dot ok" />
                    <span className="lbl">가용</span> <strong>{t.available}</strong>
                  </li>
                  <li>
                    <span className="dot gold" />
                    <span className="lbl">특별</span> <strong>{t.special}</strong>
                  </li>
                  <li>
                    <span className="dot out" />
                    <span className="lbl">제외</span> <strong>{t.excluded}</strong>
                  </li>
                </ul>
                <div className="av-team-foot">가용 {t.available}명</div>
              </button>
            ))}
          </div>
          <p className="av-muted av-type-line">
            HOUSE {summary?.byType.HOUSE} · THIRD {summary?.byType.THIRD} ·
            DRIVING {summary?.byType.DRIVING}
          </p>
        </section>
      )}

      {data && viewMode === 'detail' && (
        <>
          <DensePersonList
            title="일반 가용"
            rows={data.available.all}
            empty="해당일 일반 가용 캐디 없음"
          />
          <DensePersonList
            title="특별찾근 / 고정배치"
            rows={data.special}
            empty="특별 태그 캐디 없음"
          />
          <DensePersonList
            title="제외"
            rows={data.excluded}
            empty="제외 캐디 없음"
          />

          <section className="av-panel">
            <h3 className="av-panel-title">조별 일반가용</h3>
            {data.available.byTeam.length === 0 ? (
              <p className="av-muted">없음</p>
            ) : (
              <div className="av-team-detail">
                {data.available.byTeam.map((col) => (
                  <div key={col.team} className="av-team-block">
                    <div className="av-team-block-head">
                      {col.team} <strong>{col.rows.length}</strong>
                    </div>
                    <ol>
                      {col.rows.map((r) => (
                        <li key={r.id}>
                          <span className="av-num">{r.teamOrder}</span> {r.name}
                          <span className="av-meta muted"> · {r.caddyType}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <style>{`
        .av-page { max-width: 1200px; margin: 0 auto; }
        .av-header {
          display: flex; flex-wrap: wrap; gap: 10px;
          justify-content: space-between; align-items: flex-end;
          margin-bottom: 10px; padding-bottom: 10px;
          border-bottom: 1px solid var(--vh-gold-line);
        }
        .av-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.65rem; font-weight: 700;
          color: var(--vh-green-900); line-height: 1.12;
        }
        .av-date {
          margin: 3px 0 0; font-size: 0.74rem; color: var(--vh-muted);
          letter-spacing: 0.04em; font-variant-numeric: tabular-nums;
        }
        .av-tabs {
          display: inline-flex; border-bottom: 1px solid var(--vh-border);
        }
        .av-tabs button {
          border: 0; background: transparent; padding: 7px 12px;
          font-size: 0.8rem; font-weight: 600; color: var(--vh-muted);
          border-bottom: 2px solid transparent; margin-bottom: -1px;
          cursor: pointer; font-family: var(--font-sans);
        }
        .av-tabs button.is-active {
          color: var(--vh-green-900); border-bottom-color: var(--vh-gold);
        }
        .av-toolbar {
          display: flex; flex-wrap: wrap; gap: 8px; align-items: end;
          margin-bottom: 12px; padding: 10px;
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm); box-shadow: var(--vh-shadow-sm);
        }
        .av-toolbar label {
          display: grid; gap: 3px; font-size: 0.72rem; color: var(--vh-muted);
          font-weight: 600;
        }
        .av-toolbar input {
          padding: 7px 10px; border: 1px solid var(--vh-border-strong);
          border-radius: 8px; font-size: 16px; background: #fff;
          font-family: var(--font-sans);
        }
        .av-btn {
          min-height: 34px; padding: 6px 12px; border-radius: 8px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.78rem; font-weight: 600; cursor: pointer;
          font-family: var(--font-sans); color: var(--vh-ink);
        }
        .av-btn-primary {
          background: var(--vh-green-900); border-color: var(--vh-green-900); color: #fff;
        }
        .av-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .av-banner-error {
          margin-bottom: 10px; padding: 8px 10px; border-radius: 8px;
          background: var(--vh-danger-bg); border: 1px solid #f0c4c9;
          color: var(--vh-danger); font-size: 0.82rem;
        }
        .av-kpi {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px; margin-bottom: 12px;
        }
        .av-kpi-card {
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm); padding: 10px 12px;
          box-shadow: var(--vh-shadow-sm); position: relative; overflow: hidden;
        }
        .av-kpi-card::after {
          content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px;
          background: linear-gradient(90deg, transparent, var(--vh-gold), transparent);
          opacity: 0.5;
        }
        .av-kpi-card .lbl {
          font-size: 0.68rem; font-weight: 600; color: var(--vh-muted);
          letter-spacing: 0.03em;
        }
        .av-kpi-card .val {
          margin-top: 6px; font-size: 1.45rem; font-weight: 700;
          color: var(--vh-green-900); font-variant-numeric: tabular-nums; line-height: 1;
        }
        .av-panel {
          background: var(--vh-paper); border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius); padding: 12px;
          margin-bottom: 10px; box-shadow: var(--vh-shadow-sm);
        }
        .av-panel-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; margin-bottom: 10px;
        }
        .av-panel-title {
          margin: 0 0 8px;
          font-family: var(--font-display-kr);
          font-size: 1.05rem; font-weight: 700; color: var(--vh-green-900);
        }
        .av-panel-head .av-panel-title { margin: 0; }
        .av-link {
          border: 0; background: transparent; color: var(--vh-gold-deep);
          font-size: 0.74rem; font-weight: 600; cursor: pointer;
          font-family: var(--font-sans);
        }
        .av-count { color: var(--vh-muted); font-weight: 600; font-size: 0.85em; }
        .av-muted { color: var(--vh-muted); font-size: 0.78rem; margin: 0; }
        .av-type-line { margin-top: 10px; }
        .av-team-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
        }
        @media (min-width: 960px) {
          .av-title { font-size: 1.8rem; }
          .av-team-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
        }
        .av-team-card {
          text-align: left; border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: linear-gradient(180deg, #fffcf7 0%, #f7f4ec 100%);
          padding: 8px 9px 7px; cursor: pointer; font-family: var(--font-sans);
          color: inherit; box-shadow: var(--vh-shadow-sm);
        }
        .av-team-card:hover { border-color: var(--vh-gold); }
        .av-team-name {
          font-size: 0.88rem; font-weight: 700; color: var(--vh-green-900);
          margin-bottom: 4px;
        }
        .av-team-stats {
          list-style: none; margin: 0; padding: 0; display: grid; gap: 2px;
          font-size: 0.7rem; color: var(--vh-muted);
        }
        .av-team-stats li { display: flex; align-items: center; gap: 5px; }
        .av-team-stats strong {
          margin-left: auto; color: var(--vh-green-900); font-variant-numeric: tabular-nums;
        }
        .av-team-stats .dot {
          width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        }
        .av-team-stats .dot.ok { background: #2f8f5b; }
        .av-team-stats .dot.gold { background: #c9a227; }
        .av-team-stats .dot.out { background: #c44b4b; }
        .av-team-foot {
          margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--vh-border);
          text-align: center; font-size: 0.72rem; font-weight: 700;
          color: var(--vh-green-800); font-variant-numeric: tabular-nums;
        }
        @media (max-width: 959px) {
          .av-team-card {
            display: grid; grid-template-columns: auto 1fr auto;
            align-items: center; gap: 6px; padding: 7px 8px;
          }
          .av-team-name { margin: 0; font-size: 0.8rem; }
          .av-team-stats {
            display: flex; flex-wrap: nowrap; gap: 6px; font-size: 0.62rem;
          }
          .av-team-stats li span:not(.dot) { display: none; }
          .av-team-stats .lbl { display: none; }
          .av-team-stats strong { margin-left: 0; font-size: 0.66rem; }
          .av-team-foot { margin: 0; padding: 0; border: 0; font-size: 0.7rem; }
        }
        .av-dense {
          list-style: none; margin: 0; padding: 0;
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius-sm);
          overflow: hidden;
        }
        .av-dense-row {
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) auto 28px auto;
          gap: 6px; align-items: center;
          padding: 6px 8px; border-top: 1px solid var(--vh-border);
          font-size: 0.78rem;
        }
        .av-dense-row:first-child { border-top: 0; }
        .av-dense-row strong { color: var(--vh-green-900); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .av-meta { color: var(--vh-ink-soft); font-weight: 600; font-size: 0.72rem; }
        .av-meta.muted { color: var(--vh-muted); font-weight: 500; }
        .av-num { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--vh-green-800); text-align: center; }
        .av-tags, .av-reason {
          grid-column: 1 / -1; font-size: 0.68rem; color: var(--vh-muted);
        }
        .av-reason { color: var(--vh-warn); }
        .av-team-detail {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
        }
        @media (min-width: 720px) {
          .av-team-detail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (min-width: 1100px) {
          .av-team-detail { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        }
        .av-team-block {
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius-sm);
          padding: 8px; background: var(--vh-ivory);
        }
        .av-team-block-head {
          font-size: 0.82rem; font-weight: 700; color: var(--vh-green-900);
          margin-bottom: 4px; display: flex; justify-content: space-between;
        }
        .av-team-block ol {
          margin: 0; padding-left: 0; list-style: none;
          font-size: 0.74rem; color: var(--vh-ink);
        }
        .av-team-block li {
          display: flex; gap: 6px; align-items: baseline;
          padding: 2px 0; border-top: 1px solid rgba(230,224,212,0.7);
        }
        .av-team-block li:first-child { border-top: 0; }
      `}</style>
    </div>
  );
}
