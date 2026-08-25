'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AvailabilityResult, AvailabilityRow } from '@/lib/availabilityEngine';
import type { TeamSlotGrid, SlotCell } from '@/lib/availabilitySlotGrid';
import { PRIMARY_TEAMS } from '@/lib/caddyManage';
import { formatCaddyLabel } from '@/lib/caddyDisplay';

const GLANCE_TEAMS = PRIMARY_TEAMS;

type AvailabilityPayload = AvailabilityResult & { slotGrid?: TeamSlotGrid };

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
              <strong>{formatCaddyLabel(r)}</strong>
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

function slotKindLabel(cell: SlotCell): string {
  if (cell.kind === 'empty') return '빈자리';
  if (cell.kind === 'leave') return '휴직';
  if (cell.kind === 'special') return cell.specialTags[0] || '특수';
  if (cell.kind === 'excluded') return cell.statusLabels[0] || '제외';
  return '가용';
}

export default function ManageAvailabilityPage() {
  const [date, setDate] = useState(todayYmd);
  const [data, setData] = useState<AvailabilityPayload | null>(null);
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
      setData(json as AvailabilityPayload);
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

  const slotGrid = data?.slotGrid;

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
                슬롯 그리드
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'detail'}
                className={viewMode === 'detail' ? 'is-active' : ''}
                onClick={() => setViewMode('detail')}
              >
                목록
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
        <>
          <section className="av-panel">
            <div className="av-panel-head">
              <h2 className="av-panel-title">
                고정 슬롯 그리드 (1~12조 · 최대 {slotGrid?.maxSlot ?? '—'}번)
              </h2>
            </div>
            <p className="av-muted av-legend">
              <span className="lg ok">가용</span>
              <span className="lg out">휴무·당번·마샬·병가·타구사고·경조사 등</span>
              <span className="lg leave">휴직</span>
              <span className="lg special">특수(찾근/54/1·3 여지)</span>
              <span className="lg empty">빈자리</span>
            </p>
            {slotGrid ? (
              <div className="av-slot-scroll">
                <table className="av-slot-table">
                  <thead>
                    <tr>
                      <th className="av-slot-corner">슬롯</th>
                      {slotGrid.teams.map((col) => (
                        <th key={col.team}>{col.team}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: slotGrid.maxSlot }, (_, i) => i + 1).map(
                      (slot) => (
                        <tr key={slot}>
                          <th scope="row">{slot}</th>
                          {slotGrid.teams.map((col) => {
                            const cell = col.slots[slot - 1];
                            return (
                              <td
                                key={`${col.team}-${slot}`}
                                className={`av-slot-cell is-${cell?.kind ?? 'empty'}`}
                              >
                                {cell?.kind === 'empty' ? (
                                  <span className="av-slot-empty">·</span>
                                ) : (
                                  <>
                                    <div className="av-slot-name">{cell.name}</div>
                                    <div className="av-slot-status">
                                      {slotKindLabel(cell)}
                                      {cell.statusLabels.length > 1
                                        ? ` · ${cell.statusLabels.slice(1).join(' · ')}`
                                        : ''}
                                      {cell.specialTags.length > 0 &&
                                      cell.kind !== 'special'
                                        ? ` · ${cell.specialTags.join(' · ')}`
                                        : ''}
                                    </div>
                                  </>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="av-muted">슬롯 그리드 없음 — 다시 계산해주세요.</p>
            )}
          </section>

          <section className="av-panel">
            <div className="av-panel-head">
              <h2 className="av-panel-title">조별 요약 (1~12조)</h2>
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
                </button>
              ))}
            </div>
          </section>
        </>
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
        </>
      )}

      <style>{`
        .av-page { max-width: 1400px; margin: 0 auto; }
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
          box-shadow: var(--vh-shadow-sm);
        }
        .av-kpi-card .lbl {
          font-size: 0.68rem; font-weight: 600; color: var(--vh-muted);
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
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.05rem; font-weight: 700; color: var(--vh-green-900);
        }
        .av-muted { color: var(--vh-muted); font-size: 0.78rem; margin: 0; }
        .av-legend {
          display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 10px;
          font-size: 0.68rem;
        }
        .av-legend .lg {
          padding: 2px 6px; border-radius: 4px; border: 1px solid var(--vh-border);
        }
        .av-legend .ok { background: #e8f6ee; }
        .av-legend .out { background: #fdecec; }
        .av-legend .leave { background: #f3f0e8; }
        .av-legend .special { background: #f8f1d8; }
        .av-legend .empty { background: #f7f7f5; color: var(--vh-muted); }
        .av-slot-scroll {
          overflow-x: auto; -webkit-overflow-scrolling: touch;
          border: 1px solid var(--vh-border); border-radius: var(--vh-radius-sm);
        }
        .av-slot-table {
          border-collapse: collapse; width: max-content; min-width: 100%;
          font-size: 0.72rem;
        }
        .av-slot-table th, .av-slot-table td {
          border: 1px solid var(--vh-border); padding: 5px 6px;
          vertical-align: top; min-width: 72px; max-width: 110px;
        }
        .av-slot-table thead th {
          background: var(--vh-ivory); color: var(--vh-green-900);
          font-weight: 700; position: sticky; top: 0; z-index: 1;
        }
        .av-slot-table tbody th {
          background: var(--vh-paper); font-variant-numeric: tabular-nums;
          text-align: center; position: sticky; left: 0; z-index: 1;
        }
        .av-slot-corner { left: 0; z-index: 2 !important; }
        .av-slot-cell.is-empty { background: #fafaf8; color: var(--vh-muted); text-align: center; }
        .av-slot-cell.is-available { background: #eef8f1; }
        .av-slot-cell.is-excluded { background: #fdecec; }
        .av-slot-cell.is-leave { background: #f3f0e8; }
        .av-slot-cell.is-special { background: #f8f1d8; }
        .av-slot-name { font-weight: 700; color: var(--vh-green-900); line-height: 1.2; }
        .av-slot-status { margin-top: 2px; font-size: 0.62rem; color: var(--vh-muted); line-height: 1.25; }
        .av-slot-empty { opacity: 0.45; }
        .av-count { color: var(--vh-muted); font-weight: 600; font-size: 0.85em; }
        .av-team-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
        }
        @media (min-width: 960px) {
          .av-team-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
        }
        @media (min-width: 1200px) {
          .av-team-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
        }
        .av-team-card {
          text-align: left; border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: linear-gradient(180deg, #fffcf7 0%, #f7f4ec 100%);
          padding: 8px 9px 7px; cursor: pointer; font-family: var(--font-sans);
          color: inherit; box-shadow: var(--vh-shadow-sm);
        }
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
        .av-dense-row strong { color: var(--vh-green-900); }
        .av-meta { color: var(--vh-ink-soft); font-weight: 600; font-size: 0.72rem; }
        .av-meta.muted { color: var(--vh-muted); font-weight: 500; }
        .av-num { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--vh-green-800); text-align: center; }
        .av-tags, .av-reason {
          grid-column: 1 / -1; font-size: 0.68rem; color: var(--vh-muted);
        }
        .av-reason { color: var(--vh-warn); }
      `}</style>
    </div>
  );
}
