'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  EXTRA_FLAG_OPTIONS,
  TEAM_OPTIONS,
  employmentStatusLabel,
  normalizeEmploymentStatus,
  type ExtraFlagOption,
  type EmploymentStatus,
} from '@/lib/caddyManage';

type Caddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: EmploymentStatus | string;
  extraFlags: string[];
  status?: string | null;
  memo?: string | null;
  employeeCode?: string | null;
  caddyType?: string | null;
  missingFromImport?: boolean;
};

type Draft = {
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: EmploymentStatus;
  extraFlags: ExtraFlagOption[];
};

const emptyDraft = (): Draft => ({
  name: '',
  team: '1조',
  teamOrder: 0,
  employmentStatus: 'ACTIVE',
  extraFlags: [],
});

function toDraft(c: Caddy): Draft {
  return {
    name: c.name,
    team: c.team,
    teamOrder: c.teamOrder ?? 0,
    employmentStatus: normalizeEmploymentStatus(c.employmentStatus),
    extraFlags: (c.extraFlags ?? []).filter((f): f is ExtraFlagOption =>
      (EXTRA_FLAG_OPTIONS as readonly string[]).includes(f)
    ),
  };
}

export default function ManageCaddiesPage() {
  const [rows, setRows] = useState<Caddy[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [employmentFilter, setEmploymentFilter] = useState<
    EmploymentStatus | 'all'
  >('ACTIVE');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (employmentOverride?: EmploymentStatus | 'all') => {
      const employment = employmentOverride ?? employmentFilter;
      setLoading(true);
      setMessage(null);
      try {
        const res = await fetch(`/api/caddies?employment=${employment}`, {
          cache: 'no-store',
          credentials: 'include',
        });
        if (res.status === 401 || res.status === 403) {
          location.href = '/login?callbackUrl=/manage/caddies';
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setMessage(data?.error || '목록을 불러오지 못했습니다.');
          setRows([]);
          return;
        }
        setRows(Array.isArray(data) ? data : []);
      } finally {
        setLoading(false);
      }
    },
    [employmentFilter]
  );

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const query = q.trim();
    return rows.filter((r) => {
      if (teamFilter !== 'all' && r.team !== teamFilter) return false;
      if (!query) return true;
      return r.name.includes(query) || String(r.id).includes(query);
    });
  }, [rows, teamFilter, q]);

  const stats = useMemo(() => {
    const byTeam = new Map<string, number>();
    for (const r of filtered) {
      byTeam.set(r.team, (byTeam.get(r.team) ?? 0) + 1);
    }
    return { total: filtered.length, teams: byTeam.size };
  }, [filtered]);

  function startEdit(c: Caddy) {
    setEditingId(c.id);
    setDrafts((prev) => ({ ...prev, [c.id]: toDraft(c) }));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function updateDraft(id: number, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyDraft()), ...patch },
    }));
  }

  function toggleFlag(id: number, flag: ExtraFlagOption) {
    const cur = drafts[id]?.extraFlags ?? [];
    const next = cur.includes(flag) ? cur.filter((f) => f !== flag) : [...cur, flag];
    updateDraft(id, { extraFlags: next });
  }

  async function saveEdit(id: number) {
    const draft = drafts[id];
    if (!draft) return;
    if (!draft.name.trim() || !draft.team.trim()) {
      alert('이름과 조는 필수입니다.');
      return;
    }
    setSavingId(id);
    try {
      const res = await fetch(`/api/caddies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: draft.name.trim(),
          team: draft.team,
          teamOrder: Number(draft.teamOrder) || 0,
          employmentStatus: draft.employmentStatus,
          extraFlags: draft.extraFlags,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || '저장 실패');
        return;
      }
      setEditingId(null);
      await load();
      setMessage(`#${id} 저장됨 (ID 유지)`);
    } finally {
      setSavingId(null);
    }
  }

  async function moveOrder(c: Caddy, direction: -1 | 1) {
    const sameTeam = rows
      .filter((r) => r.team === c.team)
      .sort((a, b) => a.teamOrder - b.teamOrder || a.id - b.id);
    const idx = sameTeam.findIndex((r) => r.id === c.id);
    const swapWith = sameTeam[idx + direction];
    if (!swapWith) return;

    setSavingId(c.id);
    try {
      await Promise.all([
        fetch(`/api/caddies/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ teamOrder: swapWith.teamOrder }),
        }),
        fetch(`/api/caddies/${swapWith.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ teamOrder: c.teamOrder }),
        }),
      ]);
      await load();
    } finally {
      setSavingId(null);
    }
  }

  async function setEmployment(c: Caddy, status: EmploymentStatus) {
    const label =
      status === 'RETIRED'
        ? '퇴사 처리'
        : status === 'LEAVE'
          ? '휴직 처리'
          : '재직 복귀';
    if (
      !confirm(
        `${c.name}을(를) ${label}할까요?\n물리 삭제 없음 · ID(#${c.id})·배정 기록 유지`
      )
    ) {
      return;
    }
    setSavingId(c.id);
    try {
      const res = await fetch(`/api/caddies/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employmentStatus: status }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || '상태 변경 실패');
        return;
      }
      // 퇴사/휴직/복귀 직후 해당 필터로 전환해 목록에서 바로 확인·복귀 가능
      setEmploymentFilter(status);
      await load(status);
      setMessage(
        `${c.name}: ${employmentStatusLabel(status)} (id=${c.id}, 물리삭제 아님)`
      );
    } finally {
      setSavingId(null);
    }
  }

  async function createCaddy() {
    if (!createDraft.name.trim() || !createDraft.team.trim()) {
      alert('이름과 조는 필수입니다.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/caddies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: createDraft.name.trim(),
          team: createDraft.team,
          teamOrder: createDraft.teamOrder || undefined,
          employmentStatus: createDraft.employmentStatus,
          extraFlags: createDraft.extraFlags,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || '등록 실패');
        return;
      }
      setCreateDraft(emptyDraft());
      setCreateOpen(false);
      await load();
      setMessage(`신규 등록 완료 (id=${data.id})`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="caddy-manage">
      <header className="cm-header">
        <div>
          <h2 className="cm-title">캐디 관리</h2>
          <p className="cm-sub">
            퇴사=soft 처리(목록에서만 숨김) · ID·배정 보존 · 물리 삭제 없음 · XLSX 자동반영 보류
          </p>
        </div>
        <button type="button" className="cm-btn cm-btn-primary" onClick={() => setCreateOpen((v) => !v)}>
          {createOpen ? '등록 닫기' : '신규 등록'}
        </button>
      </header>

      {message && <div className="cm-banner">{message}</div>}

      {createOpen && (
        <section className="cm-card cm-create">
          <h3>신규 캐디 등록</h3>
          <div className="cm-form-grid">
            <label>
              이름
              <input
                value={createDraft.name}
                onChange={(e) => setCreateDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="이름"
              />
            </label>
            <label>
              조
              <select
                value={createDraft.team}
                onChange={(e) => setCreateDraft((d) => ({ ...d, team: e.target.value }))}
              >
                {TEAM_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              조내순번
              <input
                type="number"
                min={0}
                value={createDraft.teamOrder}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, teamOrder: Number(e.target.value) || 0 }))
                }
              />
            </label>
            <label>
              재직상태
              <select
                value={createDraft.employmentStatus}
                onChange={(e) =>
                  setCreateDraft((d) => ({
                    ...d,
                    employmentStatus: e.target.value as EmploymentStatus,
                  }))
                }
              >
                {EMPLOYMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EMPLOYMENT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="cm-flags">
            <legend>추가 속성</legend>
            {EXTRA_FLAG_OPTIONS.map((flag) => (
              <label key={flag} className="cm-check">
                <input
                  type="checkbox"
                  checked={createDraft.extraFlags.includes(flag)}
                  onChange={() =>
                    setCreateDraft((d) => ({
                      ...d,
                      extraFlags: d.extraFlags.includes(flag)
                        ? d.extraFlags.filter((f) => f !== flag)
                        : [...d.extraFlags, flag],
                    }))
                  }
                />
                {flag}
              </label>
            ))}
          </fieldset>
          <div className="cm-actions">
            <button type="button" className="cm-btn cm-btn-primary" disabled={creating} onClick={createCaddy}>
              {creating ? '등록 중…' : '등록'}
            </button>
          </div>
        </section>
      )}

      <section className="cm-filter-bar" aria-label="재직상태 필터">
        {(
          [
            ['all', '전체'],
            ['ACTIVE', '재직'],
            ['LEAVE', '휴직'],
            ['RETIRED', '퇴사'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`cm-filter-btn ${employmentFilter === value ? 'is-active' : ''}`}
            onClick={() => setEmploymentFilter(value)}
            disabled={loading}
          >
            {label}
          </button>
        ))}
      </section>

      <section className="cm-toolbar">
        <input
          className="cm-search"
          placeholder="이름 / ID 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
          <option value="all">전체 조</option>
          {TEAM_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button type="button" className="cm-btn" onClick={() => load()} disabled={loading}>
          새로고침
        </button>
      </section>

      <div className="cm-stats">
        표시 {stats.total}명 · {stats.teams}개 조
        {employmentFilter === 'ACTIVE' && (
          <span className="cm-stats-hint"> · 퇴사자는 「퇴사」 필터에서 조회·복귀</span>
        )}
      </div>

      {loading ? (
        <p className="cm-muted">불러오는 중…</p>
      ) : filtered.length === 0 ? (
        <p className="cm-muted">조건에 맞는 캐디가 없습니다.</p>
      ) : (
        <ul className="cm-list">
          {filtered.map((c) => {
            const editing = editingId === c.id;
            const draft = drafts[c.id] ?? toDraft(c);
            const busy = savingId === c.id;
            return (
              <li
                key={c.id}
                className={`cm-item ${normalizeEmploymentStatus(c.employmentStatus) === 'RETIRED' ? 'is-retired' : ''}`}
              >
                <div className="cm-item-top">
                  <div className="cm-id">#{c.id}</div>
                  <div className="cm-name-line">
                    <strong>{c.name}</strong>
                    <span className="cm-pill">{c.team}</span>
                    <span className="cm-pill muted">순번 {c.teamOrder}</span>
                    <span
                      className={`cm-pill ${
                        normalizeEmploymentStatus(c.employmentStatus) === 'ACTIVE'
                          ? 'ok'
                          : 'warn'
                      }`}
                    >
                      {employmentStatusLabel(c.employmentStatus)}
                    </span>
                  </div>
                  {(c.extraFlags?.length ?? 0) > 0 && (
                    <div className="cm-extra-row">
                      {c.extraFlags.map((f) => (
                        <span key={f} className="cm-pill accent">{f}</span>
                      ))}
                    </div>
                  )}
                </div>

                {!editing ? (
                  <div className="cm-item-actions">
                    <button type="button" className="cm-btn" disabled={busy} onClick={() => startEdit(c)}>
                      수정
                    </button>
                    <button type="button" className="cm-btn" disabled={busy} onClick={() => moveOrder(c, -1)}>
                      순번↑
                    </button>
                    <button type="button" className="cm-btn" disabled={busy} onClick={() => moveOrder(c, 1)}>
                      순번↓
                    </button>
                    {normalizeEmploymentStatus(c.employmentStatus) === 'RETIRED' ? (
                      <button
                        type="button"
                        className="cm-btn cm-btn-primary"
                        disabled={busy}
                        onClick={() => setEmployment(c, 'ACTIVE')}
                      >
                        재직 복귀
                      </button>
                    ) : (
                      <>
                        {normalizeEmploymentStatus(c.employmentStatus) !== 'LEAVE' && (
                          <button
                            type="button"
                            className="cm-btn"
                            disabled={busy}
                            onClick={() => setEmployment(c, 'LEAVE')}
                          >
                            휴직
                          </button>
                        )}
                        <button
                          type="button"
                          className="cm-btn cm-btn-danger"
                          disabled={busy}
                          onClick={() => setEmployment(c, 'RETIRED')}
                          title="물리 삭제 없음 · employmentStatus=RETIRED"
                        >
                          퇴사 처리
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="cm-edit">
                    <div className="cm-form-grid">
                      <label>
                        이름
                        <input
                          value={draft.name}
                          onChange={(e) => updateDraft(c.id, { name: e.target.value })}
                        />
                      </label>
                      <label>
                        조
                        <select
                          value={draft.team}
                          onChange={(e) => updateDraft(c.id, { team: e.target.value })}
                        >
                          {!(TEAM_OPTIONS as readonly string[]).includes(draft.team) && (
                            <option value={draft.team}>{draft.team}</option>
                          )}
                          {TEAM_OPTIONS.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        조내순번
                        <input
                          type="number"
                          min={0}
                          value={draft.teamOrder}
                          onChange={(e) =>
                            updateDraft(c.id, { teamOrder: Number(e.target.value) || 0 })
                          }
                        />
                      </label>
                      <label>
                        재직상태
                        <select
                          value={draft.employmentStatus}
                          onChange={(e) =>
                            updateDraft(c.id, {
                              employmentStatus: e.target.value as EmploymentStatus,
                            })
                          }
                        >
                          {EMPLOYMENT_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {EMPLOYMENT_STATUS_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <fieldset className="cm-flags">
                      <legend>추가 속성</legend>
                      {EXTRA_FLAG_OPTIONS.map((flag) => (
                        <label key={flag} className="cm-check">
                          <input
                            type="checkbox"
                            checked={draft.extraFlags.includes(flag)}
                            onChange={() => toggleFlag(c.id, flag)}
                          />
                          {flag}
                        </label>
                      ))}
                    </fieldset>
                    <div className="cm-item-actions">
                      <button
                        type="button"
                        className="cm-btn cm-btn-primary"
                        disabled={busy}
                        onClick={() => saveEdit(c.id)}
                      >
                        {busy ? '저장 중…' : '저장'}
                      </button>
                      <button type="button" className="cm-btn" disabled={busy} onClick={cancelEdit}>
                        취소
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <details className="cm-deferred">
        <summary>XLSX 명단 자동 매칭/반영 (보류)</summary>
        <p>
          운영 중 실수 방지를 위해 자동 반영은 잠시 꺼 두었습니다.
          캐디 등록·조 이동·순번·재직/퇴사·추가 속성은 이 화면에서 직접 관리하세요.
        </p>
      </details>

      <style>{`
        .caddy-manage {
          max-width: 920px;
          margin: 0 auto;
          padding-bottom: 48px;
        }
        .cm-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 12px;
        }
        .cm-title {
          margin: 0;
          font-size: 1.35rem;
          font-weight: 800;
        }
        .cm-sub {
          margin: 4px 0 0;
          color: #64748b;
          font-size: 0.85rem;
        }
        .cm-banner {
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
          color: #065f46;
          padding: 8px 10px;
          border-radius: 8px;
          margin-bottom: 12px;
          font-size: 0.9rem;
        }
        .cm-card,
        .cm-item {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 12px;
          margin-bottom: 10px;
        }
        .cm-create h3 {
          margin: 0 0 10px;
          font-size: 1rem;
        }
        .cm-filter-bar {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 6px;
          margin: 4px 0 8px;
        }
        .cm-filter-btn {
          padding: 10px 8px;
          border: 1px solid #cbd5e1;
          border-radius: 999px;
          background: #fff;
          color: #334155;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
        }
        .cm-filter-btn.is-active {
          background: #0f172a;
          border-color: #0f172a;
          color: #fff;
        }
        .cm-filter-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .cm-toolbar {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          margin: 12px 0;
        }
        .cm-search,
        .cm-toolbar select,
        .cm-form-grid input,
        .cm-form-grid select {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          font-size: 16px; /* iOS zoom 방지 */
          background: #fff;
        }
        .cm-stats {
          color: #475569;
          font-size: 0.85rem;
          margin-bottom: 8px;
        }
        .cm-stats-hint {
          color: #b45309;
        }
        .cm-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .cm-item.is-retired {
          opacity: 0.72;
          background: #f8fafc;
        }
        .cm-item-top {
          display: grid;
          gap: 6px;
        }
        .cm-id {
          color: #94a3b8;
          font-size: 0.75rem;
        }
        .cm-name-line {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .cm-name-line strong {
          font-size: 1.05rem;
          margin-right: 4px;
        }
        .cm-pill {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 0.75rem;
          background: #e2e8f0;
          color: #0f172a;
        }
        .cm-pill.muted { background: #f1f5f9; color: #64748b; }
        .cm-pill.ok { background: #dcfce7; color: #166534; }
        .cm-pill.warn { background: #fee2e2; color: #991b1b; }
        .cm-pill.accent { background: #e0e7ff; color: #3730a3; }
        .cm-extra-row { display: flex; flex-wrap: wrap; gap: 4px; }
        .cm-item-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        .cm-btn {
          min-height: 40px;
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #fff;
          cursor: pointer;
          font-size: 0.9rem;
        }
        .cm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .cm-btn-primary {
          background: #0f172a;
          border-color: #0f172a;
          color: #fff;
        }
        .cm-btn-danger {
          background: #fff;
          border-color: #fca5a5;
          color: #b91c1c;
        }
        .cm-form-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .cm-form-grid label {
          display: grid;
          gap: 4px;
          font-size: 0.8rem;
          color: #475569;
        }
        .cm-flags {
          border: 1px dashed #cbd5e1;
          border-radius: 8px;
          padding: 8px 10px;
          margin: 10px 0 0;
        }
        .cm-flags legend {
          padding: 0 4px;
          font-size: 0.8rem;
          color: #64748b;
        }
        .cm-check {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-right: 12px;
          margin-top: 4px;
          font-size: 0.9rem;
        }
        .cm-actions { margin-top: 12px; }
        .cm-muted { color: #64748b; }
        .cm-deferred {
          margin-top: 20px;
          color: #64748b;
          font-size: 0.85rem;
        }
        .cm-deferred p { margin: 8px 0 0; }

        @media (min-width: 720px) {
          .cm-toolbar {
            grid-template-columns: 1.4fr 1fr 1fr auto;
            align-items: center;
          }
          .cm-form-grid {
            grid-template-columns: 1.2fr 1fr 0.7fr 0.8fr;
          }
        }
      `}</style>
    </div>
  );
}
