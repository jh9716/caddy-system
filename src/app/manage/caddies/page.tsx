'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DRIVING_POOL_TEAM,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  EDITABLE_EXTRA_FLAG_OPTIONS,
  PRIMARY_TEAMS,
  THIRD_BAND_SUBGROUP_LABELS,
  employmentStatusLabel,
  isDrivingCaddyType,
  isThirdBandTeam,
  normalizeEmploymentStatus,
  thirdBandSubgroupCsvLabel,
  type ExtraFlagOption,
  type EmploymentStatus,
  type ThirdBandSubgroup,
} from '@/lib/caddyManage';
import { maskKrMobile } from '@/lib/caddyPhone';
import {
  listSelectableEmptySlots,
  type SlotOccupant,
} from '@/lib/caddySlot';
import {
  ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE,
  rosterImportApplySuccessMessage,
} from '@/lib/caddyRosterImportApplyConfig';

/** 한눈에 보기: 1~12조 */
const GLANCE_TEAMS = PRIMARY_TEAMS;

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
  /** 9~12조만. null=일반 3부반 */
  thirdBandSubgroup?: ThirdBandSubgroup | null;
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
  /** null = 일반 (또는 1~8조) */
  thirdBandSubgroup: ThirdBandSubgroup | null;
};

const emptyDraft = (): Draft => ({
  name: '',
  team: '1조',
  teamOrder: 0,
  employmentStatus: 'ACTIVE',
  extraFlags: [],
  phone: '',
  thirdBandSubgroup: null,
});

function toDraft(c: Caddy): Draft {
  const subgroup =
    c.thirdBandSubgroup === 'WEEKDAY' || c.thirdBandSubgroup === 'WEEKEND'
      ? c.thirdBandSubgroup
      : null;
  return {
    name: c.name,
    team: c.team,
    teamOrder: c.teamOrder ?? 0,
    employmentStatus: normalizeEmploymentStatus(c.employmentStatus),
    extraFlags: (c.extraFlags ?? []).filter((f): f is ExtraFlagOption =>
      (EDITABLE_EXTRA_FLAG_OPTIONS as readonly string[]).includes(f)
    ),
    phone: c.phoneNormalized ?? '',
    thirdBandSubgroup: isThirdBandTeam(c.team) ? subgroup : null,
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
    EmploymentStatus | 'all' | 'missing'
  >('ACTIVE');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<'regular' | 'driving'>('regular');
  const [createDraft, setCreateDraft] = useState<Draft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** UI only — 한눈에(조별 요약) / 상세(목록·편집) */
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  /** 모바일 상세: 액션 펼침 */
  const [expandedId, setExpandedId] = useState<number | null>(null);

  /** 명단 Import v2 Preview */
  type ImportPreviewLine = {
    action: 'update' | 'create' | 'unchanged' | 'needsReview' | 'missingInImport';
    id: number | null;
    name: string;
    currentTeam: string | null;
    nextTeam: string | null;
    currentTeamOrder: number | null;
    nextTeamOrder: number | null;
    currentEmploymentStatus: string | null;
    nextEmploymentStatus: string | null;
    phoneChanged: boolean;
    currentMaskedPhone: string | null;
    nextMaskedPhone: string | null;
    currentThirdBandSubgroup?: ThirdBandSubgroup | null;
    nextThirdBandSubgroup?: ThirdBandSubgroup | null;
    reason?: string;
  };
  type ImportPreview = {
    format?: string;
    summary: {
      inputPeople: number;
      update: number;
      create: number;
      unchanged: number;
      needsReview: number;
      missingInImport: number;
      phoneIssues: number;
      teamOrderConflicts: number;
      applyBlocked: boolean;
      phoneColumnPresent?: boolean;
    };
    lines: ImportPreviewLine[];
    phoneIssues?: Array<{ kind: string; name: string; message: string; maskedPhone?: string | null }>;
    teamOrderConflicts?: Array<{
      team: string;
      teamOrder: number;
      names: string[];
      ids: Array<number | null>;
    }>;
    applyPayload?: {
      updates: unknown[];
      creates: unknown[];
      matchedExistingIds?: number[];
    };
    error?: string;
  };
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  /** Apply 실패 시 Preview와 구분 — 반영되지 않음 */
  const [importApplyFailed, setImportApplyFailed] = useState(false);
  /** 슬롯 점유 계산용 — ACTIVE+LEAVE+RETIRED 전체 */
  const [slotPeers, setSlotPeers] = useState<SlotOccupant[]>([]);

  const refreshSlotPeers = useCallback(async () => {
    try {
      const res = await fetch('/api/caddies?employment=all', {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setSlotPeers(
        data.map((c: Caddy) => ({
          id: c.id,
          name: c.name,
          team: c.team,
          teamOrder: c.teamOrder,
          employmentStatus: String(c.employmentStatus),
          caddyType: c.caddyType ?? null,
        }))
      );
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(
    async (employmentOverride?: EmploymentStatus | 'all') => {
      // 한눈에 보기: 재직/휴직/퇴사 집계를 위해 전체 로드
      const employment =
        employmentOverride ??
        (viewMode === 'summary' || employmentFilter === 'missing'
          ? 'all'
          : employmentFilter);
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
        if (employment === 'all' && Array.isArray(data)) {
          setSlotPeers(
            data.map((c: Caddy) => ({
              id: c.id,
              name: c.name,
              team: c.team,
              teamOrder: c.teamOrder,
              employmentStatus: String(c.employmentStatus),
              caddyType: c.caddyType ?? null,
            }))
          );
        } else {
          void refreshSlotPeers();
        }
      } finally {
        setLoading(false);
      }
    },
    [employmentFilter, viewMode, refreshSlotPeers]
  );

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const query = q.trim();
    return rows.filter((r) => {
      if (viewMode === 'detail') {
        if (employmentFilter === 'missing') {
          if (!r.missingFromImport) return false;
        } else if (employmentFilter !== 'all') {
          if (normalizeEmploymentStatus(r.employmentStatus) !== employmentFilter) {
            return false;
          }
        }
      }
      if (teamFilter === DRIVING_POOL_TEAM) {
        if (!isDrivingCaddyType(r.caddyType) && r.team !== DRIVING_POOL_TEAM) {
          return false;
        }
      } else if (teamFilter !== 'all' && r.team !== teamFilter) {
        return false;
      }
      if (!query) return true;
      return r.name.includes(query) || String(r.id).includes(query);
    });
  }, [rows, teamFilter, q, viewMode, employmentFilter]);

  const rosterCounts = useMemo(() => {
    const regular = rows.filter(
      (r) => !isDrivingCaddyType(r.caddyType) && r.team !== DRIVING_POOL_TEAM
    );
    const driving = rows.filter(
      (r) => isDrivingCaddyType(r.caddyType) || r.team === DRIVING_POOL_TEAM
    );
    const activeRegular = regular.filter(
      (r) => normalizeEmploymentStatus(r.employmentStatus) === 'ACTIVE'
    ).length;
    const activeDriving = driving.filter(
      (r) => normalizeEmploymentStatus(r.employmentStatus) === 'ACTIVE'
    ).length;
    return {
      regular: regular.length,
      driving: driving.length,
      activeRegular,
      activeDriving,
    };
  }, [rows]);

  const drivingRows = useMemo(
    () =>
      rows.filter(
        (r) => isDrivingCaddyType(r.caddyType) || r.team === DRIVING_POOL_TEAM
      ),
    [rows]
  );

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
      if (isDrivingCaddyType(r.caddyType) || r.team === DRIVING_POOL_TEAM) continue;
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
    const original = rows.find((r) => r.id === id);
    const originalDriving = original
      ? isDrivingCaddyType(original.caddyType) ||
        original.team === DRIVING_POOL_TEAM
      : false;
    if (originalDriving) {
      if (!draft.name.trim()) {
        alert('이름은 필수입니다.');
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
            caddyType: 'DRIVING',
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
        setMessage(`#${id} 드라이빙 캐디 저장됨 (ID 유지)`);
      } finally {
        setSavingId(null);
      }
      return;
    }
    if (!draft.name.trim() || !draft.team.trim()) {
      alert('이름과 조는 필수입니다.');
      return;
    }
    const teamChanging = original && draft.team !== original.team;
    const slot = Number(draft.teamOrder) || 0;
    if (slot < 1) {
      alert('고정 슬롯(조내순번)은 1 이상이어야 합니다.');
      return;
    }
    if (teamChanging) {
      if (
        !confirm(
          `${original?.name}: ${original?.team} ${original?.teamOrder}번 → ${draft.team} ${slot}번으로 이동할까요?\n기존 슬롯은 빈자리가 됩니다.`
        )
      ) {
        return;
      }
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
          teamOrder: slot,
          employmentStatus: draft.employmentStatus,
          extraFlags: draft.extraFlags,
          thirdBandSubgroup: isThirdBandTeam(draft.team)
            ? draft.thirdBandSubgroup
            : null,
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

  async function convertToDriving(c: Caddy) {
    const slotNote =
      c.team && Number(c.teamOrder) >= 1
        ? `${c.team} ${c.teamOrder}번 고정 슬롯은 빈자리가 됩니다.`
        : '고정 슬롯에서 제외됩니다.';
    if (
      !confirm(
        `${c.name}을(를) 드라이빙 전담 캐디로 바꿀까요?\n${slotNote}\n기존 스케줄/계정 연결 기록은 유지되지만 이후 일반 자동배치·HOUSE/THIRD 순번에는 참여하지 않습니다.`
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
        body: JSON.stringify({ caddyType: 'DRIVING' }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || '변경 실패');
        return;
      }
      await load();
      setMessage(`${c.name}: 드라이빙 캐디로 변경 (슬롯 해제)`);
    } finally {
      setSavingId(null);
    }
  }

  async function moveOrder(c: Caddy, direction: -1 | 1) {
    if (isDrivingCaddyType(c.caddyType) || c.team === DRIVING_POOL_TEAM) return;
    const sameTeam = rows
      .filter((r) => r.team === c.team)
      .sort((a, b) => a.teamOrder - b.teamOrder || a.id - b.id);
    const idx = sameTeam.findIndex((r) => r.id === c.id);
    const swapWith = sameTeam[idx + direction];
    if (!swapWith) return;

    setSavingId(c.id);
    try {
      const res = await fetch(`/api/caddies/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ swapWithId: swapWith.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error || '순번 교환 실패');
        return;
      }
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
    if (createKind === 'driving') {
      if (!createDraft.name.trim()) {
        alert('이름은 필수입니다.');
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
            caddyType: 'DRIVING',
            employmentStatus: createDraft.employmentStatus,
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
        setCreateKind('regular');
        setCreateOpen(false);
        await load();
        setMessage(`드라이빙 캐디 등록: ${data.name} (id=${data.id}, 조/순번 없음)`);
      } finally {
        setCreating(false);
      }
      return;
    }
    if (!createDraft.name.trim() || !createDraft.team.trim()) {
      alert('이름과 조는 필수입니다.');
      return;
    }
    const slot = Number(createDraft.teamOrder) || 0;
    if (slot < 1) {
      alert('빈 슬롯(조내순번)을 선택해주세요.');
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
          teamOrder: slot,
          employmentStatus: createDraft.employmentStatus,
          extraFlags: createDraft.extraFlags,
          thirdBandSubgroup: isThirdBandTeam(createDraft.team)
            ? createDraft.thirdBandSubgroup
            : null,
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
      setMessage(
        `신규 등록: ${data.name} → ${data.team} ${data.teamOrder}번 (id=${data.id})`
      );
    } finally {
      setCreating(false);
    }
  }

  const createEmptySlots = useMemo(() => {
    return listSelectableEmptySlots(slotPeers, createDraft.team);
  }, [slotPeers, createDraft.team]);

  const editEmptySlots = useMemo(() => {
    if (editingId == null) return [] as number[];
    const draft = drafts[editingId];
    if (!draft) return [];
    const empty = listSelectableEmptySlots(slotPeers, draft.team, {
      excludeId: editingId,
    });
    const cur = Number(draft.teamOrder) || 0;
    // 현재 점유 슬롯 유지(편집 중 선택 가능). capacity 초과 기존 데이터도 삭제/재번호 없이 유지.
    if (cur >= 1 && !empty.includes(cur)) empty.push(cur);
    return empty.sort((a, b) => a - b);
  }, [editingId, drafts, slotPeers]);

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
              setCreateKind('regular');
              setCreateOpen(true);
            }}
          >
            신규 등록
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-sm"
            onClick={() => {
              setViewMode('detail');
              setCreateKind('driving');
              setCreateOpen(true);
            }}
          >
            드라이빙 추가
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-sm"
            onClick={() => {
              setViewMode('detail');
              setImportOpen(true);
              setImportApplyFailed(false);
            }}
          >
            명단 가져오기
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-sm"
            onClick={async () => {
              setMessage(null);
              try {
                const res = await fetch('/api/caddies/export', {
                  credentials: 'include',
                });
                if (res.status === 401 || res.status === 403) {
                  location.href = '/login?callbackUrl=/manage/caddies';
                  return;
                }
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}));
                  setMessage(data?.error || 'Export 실패');
                  return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download =
                  res.headers
                    .get('Content-Disposition')
                    ?.match(/filename="([^"]+)"/)?.[1] || 'caddy-roster.csv';
                a.click();
                URL.revokeObjectURL(url);
                setMessage('명단 CSV를 다운로드했습니다. (관리자 전용 · 휴대폰 원문 포함)');
              } catch {
                setMessage('Export 중 오류가 발생했습니다.');
              }
            }}
          >
            명단 Export
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

      {message && (
        <div
          className={`cm-banner${
            message === ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE ? ' is-error' : ''
          }`}
        >
          {message}
        </div>
      )}

      {createOpen && viewMode === 'detail' && (
        <section className="cm-card cm-create">
          <h3>
            {createKind === 'driving' ? '드라이빙 캐디 등록' : '신규 캐디 등록'}
          </h3>
          <div className="cm-kind-toggle" role="group" aria-label="등록 유형">
            <button
              type="button"
              className={createKind === 'regular' ? 'is-on' : ''}
              onClick={() => setCreateKind('regular')}
            >
              일반 (HOUSE/THIRD)
            </button>
            <button
              type="button"
              className={createKind === 'driving' ? 'is-on' : ''}
              onClick={() => setCreateKind('driving')}
            >
              드라이빙 전담
            </button>
          </div>
          {createKind === 'driving' ? (
            <p className="cm-muted">
              조/순번 없이 등록됩니다. 일반 자동배치·Spare에 들어가지 않고, 3부 드라이빙 지정 시에만 배치됩니다.
            </p>
          ) : null}
          <div className="cm-form-grid">
            <label>
              이름
              <input
                value={createDraft.name}
                onChange={(e) => setCreateDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="이름"
              />
            </label>
            {createKind === 'regular' ? (
              <>
            <label>
              조
              <select
                value={createDraft.team}
                onChange={(e) =>
                  setCreateDraft((d) => {
                    const team = e.target.value;
                    return {
                      ...d,
                      team,
                      teamOrder: 0,
                      thirdBandSubgroup: isThirdBandTeam(team)
                        ? d.thirdBandSubgroup
                        : null,
                    };
                  })
                }
              >
                {PRIMARY_TEAMS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              빈 슬롯
              <select
                value={createDraft.teamOrder || ''}
                onChange={(e) =>
                  setCreateDraft((d) => ({
                    ...d,
                    teamOrder: Number(e.target.value) || 0,
                  }))
                }
              >
                <option value="">선택…</option>
                {createEmptySlots.map((n) => (
                  <option key={n} value={n}>
                    {n}번
                  </option>
                ))}
              </select>
            </label>
              </>
            ) : null}
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
            {createKind === 'regular' && isThirdBandTeam(createDraft.team) && (
              <label>
                3부반 구분
                <select
                  value={createDraft.thirdBandSubgroup ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCreateDraft((d) => ({
                      ...d,
                      thirdBandSubgroup:
                        v === 'WEEKDAY' || v === 'WEEKEND' ? v : null,
                    }));
                  }}
                >
                  <option value="">일반</option>
                  <option value="WEEKDAY">{THIRD_BAND_SUBGROUP_LABELS.WEEKDAY}</option>
                  <option value="WEEKEND">{THIRD_BAND_SUBGROUP_LABELS.WEEKEND}</option>
                </select>
              </label>
            )}
          </div>
          {createKind === 'regular' && (
          <fieldset className="cm-flags">
            <legend>추가 속성</legend>
            {EDITABLE_EXTRA_FLAG_OPTIONS.map((flag) => (
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
          )}
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
                ['missing', '명단 누락'],
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
              <option value={DRIVING_POOL_TEAM}>드라이빙</option>
              {PRIMARY_TEAMS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </section>

          <div className="cm-stats">
            재직 일반캐디 {rosterCounts.activeRegular}명 · 드라이빙캐디{' '}
            {rosterCounts.activeDriving}명
            <span className="cm-stats-hint">
              {' '}
              · 표시 {stats.total}명
            </span>
            {employmentFilter === 'ACTIVE' && (
              <span className="cm-stats-hint"> · 퇴사자는 「퇴사」 필터에서 조회·복귀</span>
            )}
            {employmentFilter === 'missing' && (
              <span className="cm-stats-hint">
                {' '}
                · 명단 누락은 경고이며 퇴사가 아닙니다
              </span>
            )}
          </div>
        </>
      )}

      {loading ? (
        <p className="cm-muted">불러오는 중…</p>
      ) : viewMode === 'summary' ? (
        <div className="cm-summary-grid">
          <button
            type="button"
            className="cm-team-card cm-driving-card"
            onClick={() => {
              setTeamFilter(DRIVING_POOL_TEAM);
              setEmploymentFilter('all');
              setViewMode('detail');
            }}
          >
            <div className="cm-team-head">
              <span className="cm-team-name">드라이빙 캐디</span>
              <span className="cm-team-chevron" aria-hidden>›</span>
            </div>
            <ul className="cm-team-status">
              <li>
                <span className="dot active" />
                <span className="lbl">재직</span>{' '}
                <strong>
                  {
                    drivingRows.filter(
                      (r) =>
                        normalizeEmploymentStatus(r.employmentStatus) ===
                        'ACTIVE'
                    ).length
                  }
                </strong>
              </li>
              <li>
                <span className="dot leave" />
                <span className="lbl">휴직</span>{' '}
                <strong>
                  {
                    drivingRows.filter(
                      (r) =>
                        normalizeEmploymentStatus(r.employmentStatus) ===
                        'LEAVE'
                    ).length
                  }
                </strong>
              </li>
              <li>
                <span className="dot retired" />
                <span className="lbl">퇴사</span>{' '}
                <strong>
                  {
                    drivingRows.filter(
                      (r) =>
                        normalizeEmploymentStatus(r.employmentStatus) ===
                        'RETIRED'
                    ).length
                  }
                </strong>
              </li>
            </ul>
            <div className="cm-team-foot">총 {drivingRows.length}명 · 조/순번 없음</div>
          </button>
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
                  const isDriving =
                    isDrivingCaddyType(c.caddyType) ||
                    c.team === DRIVING_POOL_TEAM;
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
                            {!isDriving && (
                            <label>
                              조
                              <select
                                value={draft.team}
                                onChange={(e) => {
                                  const team = e.target.value;
                                  updateDraft(c.id, {
                                    team,
                                    teamOrder:
                                      team === c.team ? draft.teamOrder : 0,
                                    thirdBandSubgroup: isThirdBandTeam(team)
                                      ? draft.thirdBandSubgroup
                                      : null,
                                  });
                                }}
                              >
                                {!(PRIMARY_TEAMS as readonly string[]).includes(
                                  draft.team
                                ) && (
                                  <option value={draft.team}>{draft.team}</option>
                                )}
                                {PRIMARY_TEAMS.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </label>
                            )}
                            {!isDriving && (
                            <label>
                              슬롯
                              <select
                                value={draft.teamOrder || ''}
                                onChange={(e) =>
                                  updateDraft(c.id, {
                                    teamOrder: Number(e.target.value) || 0,
                                  })
                                }
                              >
                                <option value="">선택…</option>
                                {editEmptySlots.map((n) => (
                                  <option key={n} value={n}>
                                    {n}번
                                    {draft.team !== c.team ? ' (이동)' : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                            )}
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
                            {!isDriving && isThirdBandTeam(draft.team) && (
                              <label>
                                3부반 구분
                                <select
                                  value={draft.thirdBandSubgroup ?? ''}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraft(c.id, {
                                      thirdBandSubgroup:
                                        v === 'WEEKDAY' || v === 'WEEKEND'
                                          ? v
                                          : null,
                                    });
                                  }}
                                >
                                  <option value="">일반</option>
                                  <option value="WEEKDAY">
                                    {THIRD_BAND_SUBGROUP_LABELS.WEEKDAY}
                                  </option>
                                  <option value="WEEKEND">
                                    {THIRD_BAND_SUBGROUP_LABELS.WEEKEND}
                                  </option>
                                </select>
                              </label>
                            )}
                          </div>
                          {!isDriving && (
                          <fieldset className="cm-flags">
                            <legend>추가 속성</legend>
                            {EDITABLE_EXTRA_FLAG_OPTIONS.map((flag) => (
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
                          )}
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
                            {isDriving ? (
                              <span className="cm-drive-tag">드라이빙</span>
                            ) : null}
                            {c.missingFromImport ? (
                              <span
                                className="cm-missing-tag"
                                title="최신 전체 명단에 없음. 퇴사가 아닙니다."
                              >
                                명단 누락
                              </span>
                            ) : null}
                          </td>
                          <td>{isDriving ? '—' : c.team}</td>
                          <td className="cm-num">{isDriving ? '—' : c.teamOrder}</td>
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
                              {!isDriving && (
                                <>
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
                              <button
                                type="button"
                                className="cm-btn cm-btn-sm"
                                disabled={busy}
                                onClick={() => convertToDriving(c)}
                              >
                                드라이빙으로
                              </button>
                                </>
                              )}
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
              const isDriving =
                isDrivingCaddyType(c.caddyType) ||
                c.team === DRIVING_POOL_TEAM;
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
                    {c.missingFromImport ? (
                      <span className="cm-missing-tag">명단 누락</span>
                    ) : null}
                    <span className="cm-meta">
                      {isDriving ? '드라이빙' : c.team}
                    </span>
                    <span className="cm-num">{isDriving ? '—' : c.teamOrder}</span>
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
                          {!isDriving && (
                            <>
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
                          <button
                            type="button"
                            className="cm-btn cm-btn-sm"
                            disabled={busy}
                            onClick={() => convertToDriving(c)}
                          >
                            드라이빙으로
                          </button>
                            </>
                          )}
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
                            {!isDriving && (
                            <label>
                              조
                              <select
                                value={draft.team}
                                onChange={(e) => {
                                  const team = e.target.value;
                                  updateDraft(c.id, {
                                    team,
                                    teamOrder:
                                      team === c.team ? draft.teamOrder : 0,
                                    thirdBandSubgroup: isThirdBandTeam(team)
                                      ? draft.thirdBandSubgroup
                                      : null,
                                  });
                                }}
                              >
                                {!(PRIMARY_TEAMS as readonly string[]).includes(
                                  draft.team
                                ) && (
                                  <option value={draft.team}>{draft.team}</option>
                                )}
                                {PRIMARY_TEAMS.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                            </label>
                            )}
                            {!isDriving && (
                            <label>
                              슬롯
                              <select
                                value={draft.teamOrder || ''}
                                onChange={(e) =>
                                  updateDraft(c.id, {
                                    teamOrder: Number(e.target.value) || 0,
                                  })
                                }
                              >
                                <option value="">선택…</option>
                                {editEmptySlots.map((n) => (
                                  <option key={n} value={n}>
                                    {n}번
                                  </option>
                                ))}
                              </select>
                            </label>
                            )}
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
                            {!isDriving && isThirdBandTeam(draft.team) && (
                              <label>
                                3부반 구분
                                <select
                                  value={draft.thirdBandSubgroup ?? ''}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateDraft(c.id, {
                                      thirdBandSubgroup:
                                        v === 'WEEKDAY' || v === 'WEEKEND'
                                          ? v
                                          : null,
                                    });
                                  }}
                                >
                                  <option value="">일반</option>
                                  <option value="WEEKDAY">
                                    {THIRD_BAND_SUBGROUP_LABELS.WEEKDAY}
                                  </option>
                                  <option value="WEEKEND">
                                    {THIRD_BAND_SUBGROUP_LABELS.WEEKEND}
                                  </option>
                                </select>
                              </label>
                            )}
                          </div>
                          {!isDriving && (
                          <fieldset className="cm-flags">
                            <legend>추가 속성</legend>
                            {EDITABLE_EXTRA_FLAG_OPTIONS.map((flag) => (
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
                          )}
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

      {viewMode === 'detail' && importOpen && (
        <section className="cm-card cm-import" aria-label="명단 가져오기">
          <div className="cm-import-head">
            <h3>명단 가져오기 (CSV/Excel)</h3>
            <button
              type="button"
              className="cm-btn cm-btn-sm"
              onClick={() => {
                setImportOpen(false);
                setImportPreview(null);
                setImportFileName(null);
                setImportApplyFailed(false);
              }}
            >
              닫기
            </button>
          </div>
          <p className="cm-import-help">
            컬럼: <code>id,name,team,teamOrder,employmentStatus,phone[,thirdBandSubgroup]</code>
            · CSV 또는 표 형식 XLSX/XLS (첫 시트만, 시트 병합 없음) · id는 선택 · 빈 선택필드는 기존 유지 · 일반=3부구분 해제 · 삭제/재생성 없음 · extraFlags 미반영
            · 이 파일은 최신 전체 일반 캐디(1~12조) 명단으로 처리됩니다. 일부 조만 올리면 파일에 없는 다른 조 재직/휴직자가 명단 누락으로 표시됩니다. 드라이빙은 대상이 아닙니다.
          </p>
          <div className="cm-import-actions">
            <label className="cm-btn cm-btn-sm cm-file-label">
              파일 선택
              <input
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                disabled={importBusy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setImportBusy(true);
                  setImportPreview(null);
                  setImportFileName(file.name);
                  setImportApplyFailed(false);
                  setMessage(null);
                  try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const res = await fetch('/api/caddies/import/preview', {
                      method: 'POST',
                      body: fd,
                      credentials: 'include',
                    });
                    if (res.status === 401 || res.status === 403) {
                      location.href = '/login?callbackUrl=/manage/caddies';
                      return;
                    }
                    const data = await res.json();
                    if (!res.ok) {
                      setMessage(data?.error || 'Preview 실패');
                      return;
                    }
                    if (data.format && data.format !== 'csv-v2') {
                      setMessage(
                        '이 화면은 CSV/Excel v2 표 형식만 지원합니다. Export와 같은 컬럼으로 올려 주세요.'
                      );
                      return;
                    }
                    setImportPreview(data);
                  } catch {
                    setMessage('Preview 중 오류가 발생했습니다.');
                  } finally {
                    setImportBusy(false);
                  }
                }}
              />
            </label>
            {importFileName && (
              <span className="cm-muted">파일: {importFileName}</span>
            )}
            <button
              type="button"
              className="cm-btn cm-btn-primary cm-btn-sm"
              disabled={
                importBusy ||
                !importPreview?.applyPayload ||
                importPreview.summary.applyBlocked
              }
              onClick={async () => {
                if (!importPreview?.applyPayload) return;
                if (
                  !confirm(
                    `명단을 반영할까요?\n이 파일은 최신 전체 일반 캐디(1~12조) 명단으로 처리됩니다.\n갱신 ${importPreview.summary.update} · 신규 ${importPreview.summary.create}\n파일에 없는 재직/휴직자는 '명단 누락'으로 표시됩니다(자동 퇴사/삭제 없음).\n일부 조만 올리면 다른 조 재직자도 누락으로 표시됩니다.`
                  )
                ) {
                  return;
                }
                setImportBusy(true);
                setMessage(null);
                setImportApplyFailed(false);
                try {
                  const res = await fetch('/api/caddies/import/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                      applyPayload: importPreview.applyPayload,
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (res.status === 401 || res.status === 403) {
                    location.href = '/login?callbackUrl=/manage/caddies';
                    return;
                  }
                  if (!res.ok) {
                    setImportApplyFailed(true);
                    setMessage(ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE);
                    return;
                  }
                  setImportApplyFailed(false);
                  setMessage(
                    rosterImportApplySuccessMessage({
                      updated: Number(data.updated) || 0,
                      created: Number(data.created) || 0,
                      phoneUpdated: Number(data.phoneUpdated) || 0,
                    })
                  );
                  setImportPreview(null);
                  setImportFileName(null);
                  setImportOpen(false);
                  await load('all');
                } catch {
                  setImportApplyFailed(true);
                  setMessage(ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE);
                } finally {
                  setImportBusy(false);
                }
              }}
            >
              Apply 반영
            </button>
          </div>
          {importApplyFailed && (
            <p className="cm-import-apply-error" role="alert">
              {ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE}
            </p>
          )}

          {importPreview && (
            <>
              <div className="cm-import-summary">
                {importApplyFailed && (
                  <span className="is-warn">Preview 미반영</span>
                )}
                <span>입력 {importPreview.summary.inputPeople}</span>
                <span>갱신 {importPreview.summary.update}</span>
                <span>신규 {importPreview.summary.create}</span>
                <span>변경없음 {importPreview.summary.unchanged}</span>
                <span className={importPreview.summary.needsReview ? 'is-warn' : ''}>
                  검토필요 {importPreview.summary.needsReview}
                </span>
                <span className={importPreview.summary.missingInImport ? 'is-warn' : ''}>
                  누락경고 {importPreview.summary.missingInImport}
                </span>
                <span className={importPreview.summary.phoneIssues ? 'is-warn' : ''}>
                  전화문제 {importPreview.summary.phoneIssues}
                </span>
                <span
                  className={
                    importPreview.summary.teamOrderConflicts ? 'is-warn' : ''
                  }
                >
                  순번충돌 {importPreview.summary.teamOrderConflicts}
                </span>
              </div>
              {importPreview.summary.applyBlocked && (
                <p className="cm-import-block">
                  needsReview / 전화번호 문제 / 조·순번 충돌이 있어 Apply가
                  비활성화되었습니다. 수정 후 다시 Preview 하세요. 누락 경고만으로는
                  막지 않습니다(자동 퇴사 없음). Apply 후 누락자는 목록의 「명단 누락」
                  필터에서 확인합니다.
                </p>
              )}
              {(importPreview.phoneIssues?.length ?? 0) > 0 && (
                <ul className="cm-import-issues">
                  {importPreview.phoneIssues!.map((iss, i) => (
                    <li key={`p-${i}`}>
                      [전화:{iss.kind}] {iss.name} — {iss.message}
                      {iss.maskedPhone ? ` (${iss.maskedPhone})` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {(importPreview.teamOrderConflicts?.length ?? 0) > 0 && (
                <ul className="cm-import-issues">
                  {importPreview.teamOrderConflicts!.map((c, i) => (
                    <li key={`t-${i}`}>
                      [순번충돌] {c.team} 순번 {c.teamOrder}: {c.names.join(', ')}
                    </li>
                  ))}
                </ul>
              )}
              <div className="cm-import-table-wrap">
                <table className="cm-import-table">
                  <thead>
                    <tr>
                      <th>구분</th>
                      <th>id</th>
                      <th>이름</th>
                      <th>조</th>
                      <th>순번</th>
                      <th>상태</th>
                      <th>3부구분</th>
                      <th>휴대폰</th>
                      <th>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.lines.map((line, idx) => {
                      const actionLabel: Record<ImportPreviewLine['action'], string> = {
                        update: '수정',
                        create: '신규',
                        unchanged: '동일',
                        needsReview: '검토필요',
                        missingInImport: '누락경고',
                      };
                      const teamText =
                        line.action === 'missingInImport'
                          ? `${line.currentTeam ?? '—'} → (유지)`
                          : line.currentTeam == null
                            ? `${line.nextTeam ?? '—'}`
                            : line.currentTeam === line.nextTeam
                              ? String(line.nextTeam)
                              : `${line.currentTeam}→${line.nextTeam}`;
                      const orderText =
                        line.action === 'missingInImport'
                          ? `${line.currentTeamOrder ?? '—'} → (유지)`
                          : line.currentTeamOrder == null
                            ? `${line.nextTeamOrder ?? '—'}`
                            : line.currentTeamOrder === line.nextTeamOrder
                              ? String(line.nextTeamOrder)
                              : `${line.currentTeamOrder}→${line.nextTeamOrder}`;
                      const empText =
                        line.action === 'missingInImport'
                          ? `${line.currentEmploymentStatus ?? '—'} → (유지)`
                          : line.currentEmploymentStatus == null
                            ? `${line.nextEmploymentStatus ?? '—'}`
                            : line.currentEmploymentStatus ===
                                line.nextEmploymentStatus
                              ? String(line.nextEmploymentStatus)
                              : `${line.currentEmploymentStatus}→${line.nextEmploymentStatus}`;
                      const phoneText = line.phoneChanged
                        ? `${line.currentMaskedPhone ?? '—'}→${line.nextMaskedPhone ?? '—'}`
                        : line.currentMaskedPhone ??
                          line.nextMaskedPhone ??
                          '—';
                      const curBand = thirdBandSubgroupCsvLabel(
                        line.currentThirdBandSubgroup
                      );
                      const nextBand = thirdBandSubgroupCsvLabel(
                        line.nextThirdBandSubgroup
                      );
                      const bandText =
                        line.action === 'missingInImport'
                          ? `${curBand} → (유지)`
                          : curBand === nextBand
                            ? `3부구분: ${nextBand}`
                            : `3부구분: ${curBand} → ${nextBand}`;
                      return (
                        <tr
                          key={`${line.action}-${line.id}-${line.name}-${idx}`}
                          className={`is-${line.action}`}
                        >
                          <td>{actionLabel[line.action]}</td>
                          <td>{line.id ?? '—'}</td>
                          <td>{line.name}</td>
                          <td>{teamText}</td>
                          <td>{orderText}</td>
                          <td>{empText}</td>
                          <td>{bandText}</td>
                          <td>{phoneText}</td>
                          <td>{line.reason ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
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
        .cm-banner.is-error {
          background: var(--vh-danger-bg);
          border-color: #f0c4c9;
          color: var(--vh-danger);
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
        .cm-kind-toggle {
          display: flex;
          gap: 6px;
          margin-bottom: 10px;
        }
        .cm-kind-toggle button {
          flex: 1;
          min-height: 40px;
          border: 1px solid var(--vh-border);
          background: #fff;
          border-radius: 8px;
          font-size: 0.8rem;
          cursor: pointer;
        }
        .cm-kind-toggle button.is-on {
          border-color: var(--vh-gold);
          background: #fffbeb;
          font-weight: 700;
        }
        .cm-driving-card {
          border-color: #c4b5fd;
          background: #f5f3ff;
        }
        .cm-drive-tag {
          margin-left: 6px;
          font-size: 0.65rem;
          font-weight: 800;
          color: #6d28d9;
          background: #ede9fe;
          padding: 1px 5px;
          border-radius: 4px;
        }
        .cm-missing-tag {
          margin-left: 6px;
          font-size: 0.65rem;
          font-weight: 800;
          color: #b45309;
          background: #fef3c7;
          padding: 1px 5px;
          border-radius: 4px;
        }
          margin: 0 0 8px;
          font-family: var(--font-display);
          font-size: 1.05rem;
          color: var(--vh-green-900);
        }
        .cm-filter-bar {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
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
        .cm-import { margin-bottom: 14px; }
        .cm-import-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .cm-import-head h3 {
          margin: 0;
          font-size: 1rem;
          color: var(--vh-green-900);
        }
        .cm-import-help {
          margin: 0 0 10px;
          font-size: 0.78rem;
          color: var(--vh-muted);
          line-height: 1.45;
        }
        .cm-import-help code {
          font-size: 0.72rem;
          background: #f0ebe3;
          padding: 1px 4px;
          border-radius: 4px;
        }
        .cm-import-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          margin-bottom: 10px;
        }
        .cm-file-label { cursor: pointer; }
        .cm-import-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 8px;
        }
        .cm-import-summary span {
          font-size: 0.75rem;
          font-weight: 600;
          padding: 4px 8px;
          border-radius: 999px;
          background: #eef4ef;
          color: var(--vh-green-900);
        }
        .cm-import-summary span.is-warn {
          background: #fff1e8;
          color: #9a3412;
        }
        .cm-import-block {
          margin: 0 0 8px;
          padding: 8px 10px;
          border-radius: 8px;
          background: #fff1e8;
          color: #9a3412;
          font-size: 0.8rem;
        }
        .cm-import-apply-error {
          margin: 8px 0 0;
          padding: 8px 10px;
          border-radius: 8px;
          background: var(--vh-danger-bg);
          border: 1px solid #f0c4c9;
          color: var(--vh-danger);
          font-size: 0.82rem;
          font-weight: 600;
        }
        .cm-import-issues {
          margin: 0 0 8px;
          padding-left: 18px;
          font-size: 0.78rem;
          color: #9a3412;
        }
        .cm-import-table-wrap {
          overflow-x: auto;
          max-height: 420px;
          overflow-y: auto;
          border: 1px solid var(--vh-border);
          border-radius: 8px;
        }
        .cm-import-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.75rem;
          min-width: 720px;
        }
        .cm-import-table th,
        .cm-import-table td {
          padding: 6px 8px;
          border-bottom: 1px solid #eee8de;
          text-align: left;
          vertical-align: top;
        }
        .cm-import-table th {
          position: sticky;
          top: 0;
          background: #f7f3ec;
          z-index: 1;
        }
        .cm-import-table tr.is-needsReview { background: #fff7ed; }
        .cm-import-table tr.is-create { background: #f0fdf4; }
        .cm-import-table tr.is-missingInImport {
          background: #f8fafc;
          color: #64748b;
        }

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
