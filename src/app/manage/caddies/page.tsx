'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  EXTRA_FLAG_OPTIONS,
  PRIMARY_TEAMS,
  TEAM_OPTIONS,
  employmentStatusLabel,
  normalizeEmploymentStatus,
  type ExtraFlagOption,
  type EmploymentStatus,
} from '@/lib/caddyManage';
import { maskKrMobile } from '@/lib/caddyPhone';

/** 시안: 한눈에 보기 1~8조 */
const GLANCE_TEAMS = PRIMARY_TEAMS.slice(0, 8) as readonly string[];

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
  phoneNormalized?: string | null;
};

type Draft = {
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: EmploymentStatus;
  extraFlags: ExtraFlagOption[];
  /** 입력용 원문/정규화 번호. 목록 표시는 maskKrMobile 사용 */
  phone: string;
};

const emptyDraft = (): Draft => ({
  name: '',
  team: '1조',
  teamOrder: 0,
  employmentStatus: 'ACTIVE',
  extraFlags: [],
  phone: '',
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
    phone: c.phoneNormalized ?? '',
  };
}

function formatPhoneDisplay(phoneNormalized: string | null | undefined): string {
  return maskKrMobile(phoneNormalized) ?? '—';
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
  /** UI only — 한눈에(조별 요약) / 상세(목록·편집) */
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  /** 모바일 상세: 액션 펼침 */
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(
    async (employmentOverride?: EmploymentStatus | 'all') => {
      // 한눈에 보기: 재직/휴직/퇴사 집계를 위해 전체 로드
      const employment =
        employmentOverride ??
        (viewMode === 'summary' ? 'all' : employmentFilter);
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
    [employmentFilter, viewMode]
  );

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const query = q.trim();
    return rows.filter((r) => {
      if (viewMode === 'detail') {
        if (employmentFilter !== 'all') {
          if (normalizeEmploymentStatus(r.employmentStatus) !== employmentFilter) {
            return false;
          }
        }
      }
      if (teamFilter !== 'all' && r.team !== teamFilter) return false;
      if (!query) return true;
      return r.name.includes(query) || String(r.id).includes(query);
    });
  }, [rows, teamFilter, q, viewMode, employmentFilter]);

  const stats = useMemo(() => {
    const byTeam = new Map<string, number>();
    for (const r of filtered) {
      byTeam.set(r.team, (byTeam.get(r.team) ?? 0) + 1);
    }
    return { total: filtered.length, teams: byTeam.size };
  }, [filtered]);

  const teamSummaries = useMemo(() => {
    const map = new Map(
      GLANCE_TEAMS.map((team) => [
        team,
        { team, total: 0, active: 0, leave: 0, retired: 0, other: 0 },
      ])
    );
    for (const r of rows) {
      const cur = map.get(r.team);
      if (!cur) continue;
      cur.total += 1;
      const st = normalizeEmploymentStatus(r.employmentStatus);
      if (st === 'ACTIVE') cur.active += 1;
      else if (st === 'LEAVE') cur.leave += 1;
      else if (st === 'RETIRED') cur.retired += 1;
      else cur.other += 1;
    }
    return GLANCE_TEAMS.map((t) => map.get(t)!);
  }, [rows]);

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
          phone: draft.phone.trim() === '' ? null : draft.phone.trim(),
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
          phone:
            createDraft.phone.trim() === '' ? null : createDraft.phone.trim(),
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
    <div className={`caddy-manage mode-${viewMode}`}>
      <header className="cm-header">
        <div>
          <h1 className="cm-title">캐디 관리</h1>
        </div>
        <div className="cm-header-actions">
          <button
            type="button"
            className="cm-btn cm-btn-primary cm-btn-sm"
            onClick={() => {
              setViewMode('detail');
              setCreateOpen(true);
            }}
          >
            신규 등록
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-sm"
            onClick={() => load()}
            disabled={loading}
          >
            새로고침
          </button>
        </div>
      </header>

      <div className="cm-tabs" role="tablist" aria-label="보기 모드">
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

      {message && <div className="cm-banner">{message}</div>}

      {createOpen && viewMode === 'detail' && (
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
            <label>
              휴대폰번호
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={createDraft.phone}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, phone: e.target.value }))
                }
                placeholder="010-1234-5678"
              />
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

      {viewMode === 'detail' && (
        <>
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
          </section>

          <div className="cm-stats">
            표시 {stats.total}명 · {stats.teams}개 조
            {employmentFilter === 'ACTIVE' && (
              <span className="cm-stats-hint"> · 퇴사자는 「퇴사」 필터에서 조회·복귀</span>
            )}
          </div>
        </>
      )}

      {loading ? (
        <p className="cm-muted">불러오는 중…</p>
      ) : viewMode === 'summary' ? (
        <div className="cm-summary-grid">
          {teamSummaries.map((t) => (
            <button
              key={t.team}
              type="button"
              className="cm-team-card"
              onClick={() => {
                setTeamFilter(t.team);
                setEmploymentFilter('all');
                setViewMode('detail');
              }}
            >
              <div className="cm-team-head">
                <span className="cm-team-name">{t.team}</span>
                <span className="cm-team-chevron" aria-hidden>›</span>
              </div>
              <ul className="cm-team-status">
                <li>
                  <span className="dot active" />
                  <span className="lbl">재직</span> <strong>{t.active}</strong>
                </li>
                <li>
                  <span className="dot leave" />
                  <span className="lbl">휴직</span> <strong>{t.leave}</strong>
                </li>
                <li>
                  <span className="dot retired" />
                  <span className="lbl">퇴사</span> <strong>{t.retired}</strong>
                </li>
                <li>
                  <span className="dot other" />
                  <span className="lbl">기타</span> <strong>{t.other}</strong>
                </li>
              </ul>
              <div className="cm-team-foot">총 {t.total}명</div>
            </button>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="cm-muted">조건에 맞는 캐디가 없습니다.</p>
      ) : (
        <>
          {/* PC: dense table */}
          <div className="cm-table-wrap cm-detail-pc">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>조</th>
                  <th>순번</th>
                  <th>상태</th>
                  <th>휴대폰</th>
                  <th>속성</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const editing = editingId === c.id;
                  const draft = drafts[c.id] ?? toDraft(c);
                  const busy = savingId === c.id;
                  const st = normalizeEmploymentStatus(c.employmentStatus);
                  return (
                    <tr
                      key={c.id}
                      className={st === 'RETIRED' ? 'is-retired' : ''}
                    >
                      {editing ? (
                        <td colSpan={7} className="cm-edit-cell">
                          <div className="cm-form-grid">
                            <label>
                              이름
                              <input
                                value={draft.name}
                                onChange={(e) =>
                                  updateDraft(c.id, { name: e.target.value })
                                }
                              />
                            </label>
                            <label>
                              조
                              <select
                                value={draft.team}
                                onChange={(e) =>
                                  updateDraft(c.id, { team: e.target.value })
                                }
                              >
                                {!(TEAM_OPTIONS as readonly string[]).includes(
                                  draft.team
                                ) && (
                                  <option value={draft.team}>{draft.team}</option>
                                )}
                                {TEAM_OPTIONS.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
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
                                  updateDraft(c.id, {
                                    teamOrder: Number(e.target.value) || 0,
                                  })
                                }
                              />
                            </label>
                            <label>
                              재직상태
                              <select
                                value={draft.employmentStatus}
                                onChange={(e) =>
                                  updateDraft(c.id, {
                                    employmentStatus: e.target
                                      .value as EmploymentStatus,
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
                            <label>
                              휴대폰
                              <input
                                type="tel"
                                value={draft.phone}
                                onChange={(e) =>
                                  updateDraft(c.id, { phone: e.target.value })
                                }
                              />
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
                              className="cm-btn cm-btn-primary cm-btn-sm"
                              disabled={busy}
                              onClick={() => saveEdit(c.id)}
                            >
                              {busy ? '저장 중…' : '저장'}
                            </button>
                            <button
                              type="button"
                              className="cm-btn cm-btn-sm"
                              disabled={busy}
                              onClick={cancelEdit}
                            >
                              취소
                            </button>
                          </div>
                        </td>
                      ) : (
                        <>
                          <td>
                            <strong className="cm-name">{c.name}</strong>
                            <span className="cm-id-inline">#{c.id}</span>
                          </td>
                          <td>{c.team}</td>
                          <td className="cm-num">{c.teamOrder}</td>
                          <td>
                            <span
                              className={`cm-status ${
                                st === 'ACTIVE'
                                  ? 'ok'
                                  : st === 'LEAVE'
                                    ? 'leave'
                                    : 'out'
                              }`}
                            >
                              {employmentStatusLabel(c.employmentStatus)}
                            </span>
                          </td>
                          <td className="cm-phone">
                            {formatPhoneDisplay(c.phoneNormalized)}
                          </td>
                          <td className="cm-flags-cell">
                            {(c.extraFlags ?? []).join(' · ') || '—'}
                          </td>
                          <td>
                            <div className="cm-row-actions">
                              <button
                                type="button"
                                className="cm-btn cm-btn-sm"
                                disabled={busy}
                                onClick={() => startEdit(c)}
                              >
                                수정
                              </button>
                              <button
                                type="button"
                                className="cm-btn cm-btn-sm"
                                disabled={busy}
                                onClick={() => moveOrder(c, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="cm-btn cm-btn-sm"
                                disabled={busy}
                                onClick={() => moveOrder(c, 1)}
                              >
                                ↓
                              </button>
                              {st === 'RETIRED' ? (
                                <button
                                  type="button"
                                  className="cm-btn cm-btn-primary cm-btn-sm"
                                  disabled={busy}
                                  onClick={() => setEmployment(c, 'ACTIVE')}
                                >
                                  복귀
                                </button>
                              ) : (
                                <>
                                  {st !== 'LEAVE' && (
                                    <button
                                      type="button"
                                      className="cm-btn cm-btn-sm"
                                      disabled={busy}
                                      onClick={() => setEmployment(c, 'LEAVE')}
                                    >
                                      휴직
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="cm-btn cm-btn-danger cm-btn-sm"
                                    disabled={busy}
                                    onClick={() => setEmployment(c, 'RETIRED')}
                                  >
                                    퇴사
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: compact one-line rows */}
          <ul className="cm-dense-list cm-detail-mobile">
            {filtered.map((c) => {
              const editing = editingId === c.id;
              const draft = drafts[c.id] ?? toDraft(c);
              const busy = savingId === c.id;
              const st = normalizeEmploymentStatus(c.employmentStatus);
              const open = expandedId === c.id || editing;
              return (
                <li
                  key={c.id}
                  className={`cm-dense-row ${st === 'RETIRED' ? 'is-retired' : ''} ${open ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="cm-dense-main"
                    onClick={() =>
                      setExpandedId((id) => (id === c.id ? null : c.id))
                    }
                  >
                    <strong className="cm-name">{c.name}</strong>
                    <span className="cm-meta">{c.team}</span>
                    <span className="cm-num">{c.teamOrder}</span>
                    <span
                      className={`cm-status ${
                        st === 'ACTIVE' ? 'ok' : st === 'LEAVE' ? 'leave' : 'out'
                      }`}
                    >
                      {employmentStatusLabel(c.employmentStatus)}
                    </span>
                    <span className="cm-more" aria-hidden>
                      {open ? '▾' : '⋮'}
                    </span>
                  </button>
                  {open && (
                    <div className="cm-dense-panel">
                      <div className="cm-phone-line">
                        휴대폰 {formatPhoneDisplay(c.phoneNormalized)}
                        {(c.extraFlags?.length ?? 0) > 0 &&
                          ` · ${c.extraFlags.join('/')}`}
                      </div>
                      {!editing ? (
                        <div className="cm-item-actions">
                          <button
                            type="button"
                            className="cm-btn cm-btn-sm"
                            disabled={busy}
                            onClick={() => startEdit(c)}
                          >
                            수정
                          </button>
                          <button
                            type="button"
                            className="cm-btn cm-btn-sm"
                            disabled={busy}
                            onClick={() => moveOrder(c, -1)}
                          >
                            순번↑
                          </button>
                          <button
                            type="button"
                            className="cm-btn cm-btn-sm"
                            disabled={busy}
                            onClick={() => moveOrder(c, 1)}
                          >
                            순번↓
                          </button>
                          {st === 'RETIRED' ? (
                            <button
                              type="button"
                              className="cm-btn cm-btn-primary cm-btn-sm"
                              disabled={busy}
                              onClick={() => setEmployment(c, 'ACTIVE')}
                            >
                              재직 복귀
                            </button>
                          ) : (
                            <>
                              {st !== 'LEAVE' && (
                                <button
                                  type="button"
                                  className="cm-btn cm-btn-sm"
                                  disabled={busy}
                                  onClick={() => setEmployment(c, 'LEAVE')}
                                >
                                  휴직
                                </button>
                              )}
                              <button
                                type="button"
                                className="cm-btn cm-btn-danger cm-btn-sm"
                                disabled={busy}
                                onClick={() => setEmployment(c, 'RETIRED')}
                              >
                                퇴사
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
                                onChange={(e) =>
                                  updateDraft(c.id, { name: e.target.value })
                                }
                              />
                            </label>
                            <label>
                              조
                              <select
                                value={draft.team}
                                onChange={(e) =>
                                  updateDraft(c.id, { team: e.target.value })
                                }
                              >
                                {TEAM_OPTIONS.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              순번
                              <input
                                type="number"
                                min={0}
                                value={draft.teamOrder}
                                onChange={(e) =>
                                  updateDraft(c.id, {
                                    teamOrder: Number(e.target.value) || 0,
                                  })
                                }
                              />
                            </label>
                            <label>
                              상태
                              <select
                                value={draft.employmentStatus}
                                onChange={(e) =>
                                  updateDraft(c.id, {
                                    employmentStatus: e.target
                                      .value as EmploymentStatus,
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
                            <label>
                              휴대폰
                              <input
                                type="tel"
                                value={draft.phone}
                                onChange={(e) =>
                                  updateDraft(c.id, { phone: e.target.value })
                                }
                              />
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
                              className="cm-btn cm-btn-primary cm-btn-sm"
                              disabled={busy}
                              onClick={() => saveEdit(c.id)}
                            >
                              {busy ? '저장 중…' : '저장'}
                            </button>
                            <button
                              type="button"
                              className="cm-btn cm-btn-sm"
                              disabled={busy}
                              onClick={cancelEdit}
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {viewMode === 'detail' && (
        <details className="cm-deferred">
          <summary>XLSX 명단 자동 매칭/반영 (보류)</summary>
          <p>
            운영 중 실수 방지를 위해 자동 반영은 잠시 꺼 두었습니다.
            캐디 등록·조 이동·순번·재직/퇴사·추가 속성은 이 화면에서 직접 관리하세요.
          </p>
        </details>
      )}

      <style>{`
        .caddy-manage {
          max-width: 1280px;
          margin: 0 auto;
        }
        .cm-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 10px;
          margin-bottom: 10px;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--vh-gold-line);
          flex-wrap: wrap;
        }
        .cm-header-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .cm-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.65rem;
          font-weight: 700;
          color: var(--vh-green-900);
          line-height: 1.12;
          letter-spacing: 0.01em;
        }
        .cm-tabs {
          display: inline-flex;
          gap: 0;
          margin-bottom: 12px;
          border-bottom: 1px solid var(--vh-border);
          width: 100%;
        }
        .cm-tabs button {
          border: 0;
          background: transparent;
          padding: 8px 14px;
          font-size: 0.82rem;
          font-weight: 600;
          color: var(--vh-muted);
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          font-family: var(--font-sans);
          letter-spacing: 0.01em;
        }
        .cm-tabs button.is-active {
          color: var(--vh-green-900);
          border-bottom-color: var(--vh-gold);
        }
        .cm-banner {
          background: var(--vh-ok-bg);
          border: 1px solid #b7dfc8;
          color: var(--vh-ok);
          padding: 6px 10px;
          border-radius: 8px;
          margin-bottom: 10px;
          font-size: 0.82rem;
        }
        .cm-card,
        .cm-item {
          background: var(--vh-paper);
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          padding: 12px;
          margin-bottom: 8px;
          box-shadow: var(--vh-shadow-sm);
        }
        .cm-create h3 {
          margin: 0 0 8px;
          font-family: var(--font-display);
          font-size: 1.05rem;
          color: var(--vh-green-900);
        }
        .cm-filter-bar {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 4px;
          margin: 4px 0 8px;
          padding: 8px;
          background: var(--vh-paper);
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
        }
        .cm-filter-btn {
          padding: 7px 6px;
          border: 1px solid var(--vh-border);
          border-radius: 8px;
          background: #fff;
          color: var(--vh-ink-soft);
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
        }
        .cm-filter-btn.is-active {
          background: var(--vh-green-900);
          border-color: var(--vh-green-900);
          color: #fff;
        }
        .cm-filter-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .cm-toolbar {
          display: grid;
          grid-template-columns: 1fr;
          gap: 6px;
          margin: 8px 0;
        }
        .cm-search,
        .cm-toolbar select,
        .cm-form-grid input,
        .cm-form-grid select {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid var(--vh-border-strong);
          border-radius: 8px;
          font-size: 16px;
          background: #fff;
        }
        .cm-stats {
          color: var(--vh-muted);
          font-size: 0.76rem;
          margin-bottom: 8px;
          font-weight: 500;
        }
        .cm-stats-hint {
          color: var(--vh-warn);
        }
        .cm-summary-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        @media (min-width: 960px) {
          .cm-summary-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
          }
          .cm-title { font-size: 1.8rem; }
        }
        .cm-team-card {
          text-align: left;
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: linear-gradient(180deg, #fffcf7 0%, #f7f4ec 100%);
          padding: 10px 11px 8px;
          cursor: pointer;
          font-family: var(--font-sans);
          color: inherit;
          min-height: 0;
          box-shadow: var(--vh-shadow-sm);
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .cm-team-card:hover {
          border-color: var(--vh-gold);
          box-shadow: var(--vh-shadow);
        }
        .cm-team-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
          padding-bottom: 5px;
          border-bottom: 1px solid rgba(230, 224, 212, 0.9);
        }
        .cm-team-name {
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--vh-green-900);
          letter-spacing: 0.01em;
        }
        .cm-team-chevron {
          color: var(--vh-gold-deep);
          font-size: 1.05rem;
          line-height: 1;
          opacity: 0.8;
        }
        .cm-team-status {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 3px;
          font-size: 0.72rem;
          color: var(--vh-muted);
          font-weight: 500;
        }
        .cm-team-status li {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .cm-team-status strong {
          margin-left: auto;
          font-variant-numeric: tabular-nums;
          color: var(--vh-green-900);
          font-weight: 700;
          font-size: 0.8rem;
        }
        .cm-team-status .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 0 1.5px rgba(0,0,0,0.04);
        }
        .cm-team-status .dot.active { background: #2f8f5b; }
        .cm-team-status .dot.leave { background: #c9a227; }
        .cm-team-status .dot.retired { background: #c44b4b; }
        .cm-team-status .dot.other { background: #9aa39c; }
        .cm-team-foot {
          margin-top: 7px;
          padding-top: 6px;
          border-top: 1px solid var(--vh-border);
          text-align: center;
          font-size: 0.74rem;
          font-weight: 700;
          color: var(--vh-green-800);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
        }
        @media (max-width: 959px) {
          .cm-title { font-size: 1.4rem; }
          .cm-team-card {
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            column-gap: 6px;
            padding: 8px 9px;
            background: var(--vh-paper);
          }
          .cm-team-head {
            grid-column: 1;
            margin: 0;
            padding: 0;
            border: 0;
            flex-direction: column;
            align-items: flex-start;
            gap: 0;
          }
          .cm-team-chevron { display: none; }
          .cm-team-name { font-size: 0.84rem; }
          .cm-team-status {
            grid-column: 2;
            display: flex;
            flex-wrap: nowrap;
            gap: 5px;
            font-size: 0.62rem;
          }
          .cm-team-status li { gap: 2px; white-space: nowrap; }
          .cm-team-status .lbl { display: none; }
          .cm-team-status strong {
            margin-left: 0;
            font-size: 0.68rem;
          }
          .cm-team-foot {
            grid-column: 3;
            margin: 0;
            padding: 0;
            border: 0;
            font-size: 0.72rem;
            white-space: nowrap;
          }
        }
        .cm-detail-mobile { display: block; }
        .cm-detail-pc { display: none; }
        @media (min-width: 960px) {
          .cm-detail-mobile { display: none; }
          .cm-detail-pc { display: block; }
        }
        .cm-table-wrap {
          overflow: auto;
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: var(--vh-paper);
          box-shadow: var(--vh-shadow-sm);
        }
        .cm-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.8rem;
        }
        .cm-table th {
          text-align: left;
          padding: 7px 8px;
          background: var(--vh-green-50);
          color: var(--vh-green-800);
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.03em;
          border-bottom: 1px solid var(--vh-border);
          white-space: nowrap;
        }
        .cm-table td {
          padding: 6px 8px;
          border-top: 1px solid var(--vh-border);
          vertical-align: middle;
          color: var(--vh-ink);
        }
        .cm-table tr:hover td { background: rgba(243, 247, 244, 0.55); }
        .cm-table tr.is-retired td { opacity: 0.62; }
        .cm-name { color: var(--vh-green-900); font-weight: 700; }
        .cm-id-inline {
          margin-left: 6px;
          color: var(--vh-muted);
          font-size: 0.68rem;
          font-weight: 500;
        }
        .cm-num {
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          color: var(--vh-green-800);
        }
        .cm-phone, .cm-flags-cell {
          color: var(--vh-muted);
          font-size: 0.74rem;
          white-space: nowrap;
        }
        .cm-status {
          display: inline-flex;
          padding: 1px 7px;
          border-radius: 999px;
          font-size: 0.68rem;
          font-weight: 700;
          background: var(--vh-ivory-deep);
          color: var(--vh-muted);
        }
        .cm-status.ok { background: var(--vh-ok-bg); color: var(--vh-ok); }
        .cm-status.leave { background: var(--vh-warn-bg); color: var(--vh-warn); }
        .cm-status.out { background: var(--vh-danger-bg); color: var(--vh-danger); }
        .cm-row-actions {
          display: flex;
          flex-wrap: nowrap;
          gap: 4px;
        }
        .cm-edit-cell { background: var(--vh-ivory); }
        .cm-dense-list {
          list-style: none;
          margin: 0;
          padding: 0;
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: var(--vh-paper);
          overflow: hidden;
        }
        .cm-dense-row {
          border-top: 1px solid var(--vh-border);
        }
        .cm-dense-row:first-child { border-top: 0; }
        .cm-dense-row.is-retired { opacity: 0.65; }
        .cm-dense-main {
          width: 100%;
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) auto 32px auto 22px;
          align-items: center;
          gap: 6px;
          padding: 7px 8px;
          border: 0;
          background: transparent;
          text-align: left;
          cursor: pointer;
          font-family: var(--font-sans);
          color: inherit;
        }
        .cm-dense-main .cm-name {
          font-size: 0.84rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cm-dense-main .cm-meta {
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--vh-ink-soft);
        }
        .cm-dense-main .cm-num { font-size: 0.74rem; text-align: center; }
        .cm-more {
          color: var(--vh-gold-deep);
          font-size: 0.9rem;
          text-align: center;
        }
        .cm-dense-panel {
          padding: 0 8px 8px;
          background: var(--vh-ivory);
          border-top: 1px dashed var(--vh-border);
        }
        .cm-phone-line {
          margin: 6px 0 4px;
          font-size: 0.72rem;
          color: var(--vh-muted);
        }
        .cm-item-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 6px;
        }
        .cm-btn {
          min-height: 28px;
          padding: 4px 9px;
          border-radius: 7px;
          border: 1px solid var(--vh-border-strong);
          background: var(--vh-paper);
          cursor: pointer;
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--vh-ink);
          font-family: var(--font-sans);
        }
        .cm-btn-sm {
          min-height: 26px;
          padding: 3px 8px;
          font-size: 0.7rem;
        }
        .cm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .cm-btn-primary {
          background: var(--vh-green-900);
          border-color: var(--vh-green-900);
          color: #fff;
        }
        .cm-btn-danger {
          background: #fff;
          border-color: #e2b4ba;
          color: var(--vh-danger);
        }
        .cm-form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .cm-form-grid label {
          display: grid;
          gap: 3px;
          font-size: 0.72rem;
          color: var(--vh-ink-soft);
        }
        .cm-flags {
          border: 1px dashed var(--vh-border-strong);
          border-radius: var(--vh-radius-sm);
          padding: 6px 8px;
          margin: 8px 0 0;
        }
        .cm-flags legend {
          padding: 0 4px;
          font-size: 0.72rem;
          color: var(--vh-muted);
        }
        .cm-check {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 10px;
          margin-top: 3px;
          font-size: 0.78rem;
        }
        .cm-actions { margin-top: 10px; }
        .cm-muted { color: var(--vh-muted); font-size: 0.84rem; }
        .cm-deferred {
          margin-top: 14px;
          color: var(--vh-muted);
          font-size: 0.78rem;
        }
        .cm-deferred p { margin: 6px 0 0; }

        @media (min-width: 720px) {
          .cm-toolbar {
            grid-template-columns: 1.4fr 1fr auto;
            align-items: center;
          }
          .cm-form-grid {
            grid-template-columns: 1.2fr 1fr 0.7fr 0.8fr 1fr;
          }
        }
      `}</style>
    </div>
  );
}
