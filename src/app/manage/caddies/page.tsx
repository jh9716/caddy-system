'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DRIVING_POOL_TEAM,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_UI_LABELS,
  EDITABLE_EXTRA_FLAG_OPTIONS,
  HOUSE_TEAMS,
  PRIMARY_TEAMS,
  THIRD_BAND_SUBGROUP_LABELS,
  THIRD_BAND_TEAMS,
  countsTowardRosterHeadcount,
  employmentStatusUiLabel,
  isDrivingCaddyType,
  rosterHeadcount,
  isHouseTeam,
  isThirdBandTeam,
  normalizeEmploymentStatus,
  thirdBandSubgroupCsvLabel,
  type AffiliationKind,
  type ExtraFlagOption,
  type EmploymentStatus,
  type ThirdBandSubgroup,
} from '@/lib/caddyManage';
import { formatCaddyLabel } from '@/lib/caddyDisplay';
import { maskKrMobile } from '@/lib/caddyPhone';
import {
  listSelectableEmptySlots,
  type SlotOccupant,
} from '@/lib/caddySlot';
import {
  listV1ProjectedEmptySlots,
  mergeV1SafeResolutions,
  v1SafeApplyReady,
  type V1SafeDecisionRow,
  type V1SafeImportPerson,
  type V1SafeResolution,
} from '@/lib/caddyRosterImportV1SafeShared';
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
  affiliation: AffiliationKind;
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
  affiliation: 'HOUSE',
  team: '1조',
  teamOrder: 0,
  employmentStatus: 'ACTIVE',
  extraFlags: [],
  phone: '',
  thirdBandSubgroup: null,
});

function affiliationFromCaddy(c: {
  caddyType?: string | null;
  team?: string | null;
}): AffiliationKind {
  if (isDrivingCaddyType(c.caddyType) || c.team === DRIVING_POOL_TEAM) {
    return 'DRIVING';
  }
  if (isThirdBandTeam(String(c.team ?? ''))) return 'THIRD';
  return 'HOUSE';
}

function applyAffiliationChange(
  current: Draft,
  next: AffiliationKind
): Partial<Draft> {
  if (next === 'DRIVING') {
    return {
      affiliation: 'DRIVING',
      team: DRIVING_POOL_TEAM,
      teamOrder: 0,
      thirdBandSubgroup: null,
    };
  }
  if (next === 'HOUSE') {
    const keep = isHouseTeam(current.team);
    return {
      affiliation: 'HOUSE',
      team: keep ? current.team : '1조',
      teamOrder: keep ? current.teamOrder : 0,
      thirdBandSubgroup: null,
    };
  }
  const keep = isThirdBandTeam(current.team);
  return {
    affiliation: 'THIRD',
    team: keep ? current.team : '9조',
    teamOrder: keep ? current.teamOrder : 0,
    thirdBandSubgroup: keep ? current.thirdBandSubgroup : null,
  };
}

function toDraft(c: Caddy): Draft {
  const subgroup =
    c.thirdBandSubgroup === 'WEEKDAY' || c.thirdBandSubgroup === 'WEEKEND'
      ? c.thirdBandSubgroup
      : null;
  const affiliation = affiliationFromCaddy(c);
  return {
    name: c.name,
    affiliation,
    team: affiliation === 'DRIVING' ? DRIVING_POOL_TEAM : c.team,
    teamOrder: affiliation === 'DRIVING' ? 0 : c.teamOrder ?? 0,
    employmentStatus: normalizeEmploymentStatus(c.employmentStatus),
    extraFlags: (c.extraFlags ?? []).filter((f): f is ExtraFlagOption =>
      (EDITABLE_EXTRA_FLAG_OPTIONS as readonly string[]).includes(f)
    ),
    phone: c.phoneNormalized ?? '',
    thirdBandSubgroup:
      affiliation === 'THIRD' && isThirdBandTeam(c.team) ? subgroup : null,
  };
}

function formatPhoneDisplay(phoneNormalized: string | null | undefined): string {
  return maskKrMobile(phoneNormalized) ?? '—';
}

function isDrivingCaddy(c: { caddyType?: string | null; team?: string | null }): boolean {
  return isDrivingCaddyType(c.caddyType) || c.team === DRIVING_POOL_TEAM;
}

function AffiliationTeamFields({
  draft,
  original,
  emptySlots,
  slotLabel,
  onChange,
}: {
  draft: Draft;
  original: Caddy;
  emptySlots: number[];
  slotLabel: string;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const nextDriving = draft.affiliation === 'DRIVING';
  const teamOptions =
    draft.affiliation === 'THIRD' ? THIRD_BAND_TEAMS : HOUSE_TEAMS;
  return (
    <>
      <label>
        소속
        <select
          value={draft.affiliation}
          onChange={(e) => {
            const next = e.target.value as AffiliationKind;
            if (next === 'HOUSE' || next === 'THIRD' || next === 'DRIVING') {
              onChange(applyAffiliationChange(draft, next));
            }
          }}
        >
          <option value="HOUSE">HOUSE (1~8조)</option>
          <option value="THIRD">3부반 (9~12조)</option>
          <option value="DRIVING">드라이빙</option>
        </select>
      </label>
      {!nextDriving && (
        <label>
          조
          <select
            value={draft.team}
            onChange={(e) => {
              const team = e.target.value;
              onChange({
                team,
                teamOrder: team === original.team ? draft.teamOrder : 0,
                thirdBandSubgroup: isThirdBandTeam(team)
                  ? draft.thirdBandSubgroup
                  : null,
              });
            }}
          >
            {!(teamOptions as readonly string[]).includes(draft.team) && (
              <option value={draft.team}>{draft.team}</option>
            )}
            {teamOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      )}
      {!nextDriving && (
        <label>
          {slotLabel}
          <select
            value={draft.teamOrder || ''}
            onChange={(e) =>
              onChange({
                teamOrder: Number(e.target.value) || 0,
              })
            }
          >
            <option value="">선택…</option>
            {emptySlots.map((n) => (
              <option key={n} value={n}>
                {n}번
                {draft.team !== original.team ? ' (이동)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {!nextDriving && isThirdBandTeam(draft.team) && (
        <label>
          3부반 구분
          <select
            value={draft.thirdBandSubgroup ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onChange({
                thirdBandSubgroup:
                  v === 'WEEKDAY' || v === 'WEEKEND' ? v : null,
              });
            }}
          >
            <option value="">일반</option>
            <option value="WEEKDAY">{THIRD_BAND_SUBGROUP_LABELS.WEEKDAY}</option>
            <option value="WEEKEND">{THIRD_BAND_SUBGROUP_LABELS.WEEKEND}</option>
          </select>
        </label>
      )}
    </>
  );
}

/** 현장표 성명. 조 접두어는 열 헤더에 있으므로 이름만 쓴다. */
function rosterPersonName(c: { name?: string | null }): string {
  return String(c.name ?? '').trim() || '이름없음';
}

function rosterImportFormatLabel(format?: string | null): string {
  if (format === 'xlsx-v2') return 'XLSX v2';
  if (format === 'xlsx-v1') return 'XLSX v1';
  if (format === 'csv-v2') return 'CSV v2';
  return format ? String(format) : '미확인';
}

function isRosterImportV2ApplyFormat(
  format?: string | null
): format is 'csv-v2' | 'xlsx-v2' {
  return format === 'csv-v2' || format === 'xlsx-v2';
}

function isXlsxV1SafePreview(preview: {
  format?: string;
  rows?: unknown;
  importPeople?: unknown;
} | null | undefined): boolean {
  return (
    preview?.format === 'xlsx-v1' &&
    Array.isArray(preview.rows) &&
    Array.isArray(preview.importPeople)
  );
}

const V1_SAFE_KIND_LABEL: Record<string, string> = {
  keep: '변경없음',
  move: '조 이동',
  create: '신규',
  needsReview: '검토필요',
  missing: '누락',
  extraOnly: '안내',
  invalid: '무효',
};

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
  /** 현장표 이름 클릭 메뉴 */
  const [menuCaddyId, setMenuCaddyId] = useState<number | null>(null);

  /** 명단 Import v2 Preview */
  type ImportPreviewLine = {
    action:
      | 'update'
      | 'create'
      | 'unchanged'
      | 'needsReview'
      | 'missingInImport'
      | 'phoneOnlyUpdate'
      | string;
    id: number | null;
    name: string;
    currentTeam: string | null;
    nextTeam: string | null;
    currentTeamOrder?: number | null;
    nextTeamOrder?: number | null;
    currentEmploymentStatus?: string | null;
    nextEmploymentStatus?: string | null;
    phoneChanged?: boolean;
    currentMaskedPhone?: string | null;
    nextMaskedPhone?: string | null;
    maskedPhone?: string | null;
    currentThirdBandSubgroup?: ThirdBandSubgroup | null;
    nextThirdBandSubgroup?: ThirdBandSubgroup | null;
    reason?: string;
  };
  type ImportPreview = {
    format?: string;
    summary: {
      inputPeople?: number;
      uniqueImportPeople?: number;
      update?: number;
      create?: number;
      new?: number;
      unchanged?: number;
      needsReview: number;
      missingInImport: number;
      phoneIssues?: number;
      teamOrderConflicts?: number;
      applyBlocked?: boolean;
      applyBlockedByPhone?: boolean;
      phoneColumnPresent?: boolean;
      autoKeep?: number;
      move?: number;
      extraOnly?: number;
      applyReady?: boolean;
      applyBlockedReasons?: string[];
    };
    lines?: ImportPreviewLine[];
    rows?: V1SafeDecisionRow[];
    extraOnly?: Array<{ name: string; team: string }>;
    importPeople?: V1SafeImportPerson[];
    occupants?: SlotOccupant[];
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
  const [v1Resolutions, setV1Resolutions] = useState<
    Record<string, V1SafeResolution>
  >({});
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
      // 한눈에 보기: 재직/휴직/삭제됨 집계를 위해 전체 로드
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

  const v1DecisionRows = importPreview?.rows ?? [];
  const v1MergedRows = useMemo(
    () => mergeV1SafeResolutions(v1DecisionRows, v1Resolutions),
    [v1DecisionRows, v1Resolutions]
  );
  const v1Ready = useMemo(
    () => v1SafeApplyReady(v1MergedRows),
    [v1MergedRows]
  );
  const v1Occupants = importPreview?.occupants ?? slotPeers;

  const patchV1Resolution = useCallback(
    (name: string, patch: Partial<V1SafeResolution>) => {
      setV1Resolutions((prev) => {
        const cur = prev[name] ?? { name };
        return { ...prev, [name]: { ...cur, ...patch, name } };
      });
    },
    []
  );

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
      headcount: rosterHeadcount(rows),
      drivingHeadcount: rosterHeadcount(driving),
    };
  }, [rows]);

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
      const st = normalizeEmploymentStatus(r.employmentStatus);
      if (st === 'ACTIVE') cur.active += 1;
      else if (st === 'LEAVE') cur.leave += 1;
      else if (st === 'RETIRED') cur.retired += 1;
      else cur.other += 1;
      if (countsTowardRosterHeadcount(r.employmentStatus)) cur.total += 1;
    }
    return GLANCE_TEAMS.map((t) => map.get(t)!);
  }, [rows]);

  const menuCaddy = useMemo(
    () => rows.find((r) => r.id === menuCaddyId) ?? null,
    [rows, menuCaddyId]
  );

  const rosterColumns = useMemo(() => {
    const query = q.trim();
    const columns = GLANCE_TEAMS.map((team) => {
      const summary = teamSummaries.find((t) => t.team === team);
      const members = rows
        .filter(
          (r) =>
            !isDrivingCaddy(r) &&
            r.team === team &&
            normalizeEmploymentStatus(r.employmentStatus) !== 'RETIRED'
        )
        .filter((r) => !query || r.name.includes(query))
        .sort((a, b) => a.teamOrder - b.teamOrder || a.id - b.id);
      return {
        key: team,
        title: team,
        count: summary?.total ?? 0,
        driving: false,
        members,
      };
    });
    const drivingMembers = rows
      .filter(
        (r) =>
          isDrivingCaddy(r) &&
          normalizeEmploymentStatus(r.employmentStatus) !== 'RETIRED'
      )
      .filter((r) => !query || r.name.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id);
    columns.push({
      key: DRIVING_POOL_TEAM,
      title: '드라이빙',
      count: rosterCounts.drivingHeadcount,
      driving: true,
      members: drivingMembers,
    });
    return columns;
  }, [rows, q, teamSummaries, rosterCounts.drivingHeadcount]);

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
    const originalDriving = original ? isDrivingCaddy(original) : false;
    const nextDriving = draft.affiliation === 'DRIVING';

    if (nextDriving) {
      if (!draft.name.trim()) {
        alert('이름은 필수입니다.');
        return;
      }
      if (!originalDriving && original) {
        const slotNote =
          original.team && Number(original.teamOrder) >= 1
            ? `${original.team} ${original.teamOrder}번 고정 슬롯은 빈자리가 됩니다.`
            : '고정 슬롯에서 제외됩니다.';
        if (
          !confirm(
            `${formatCaddyLabel(original)}을(를) 드라이빙 전담 캐디로 바꿀까요?\n${slotNote}\n기존 ID/계정과 스케줄 기록은 유지됩니다.`
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
        setMenuCaddyId(null);
        await load();
        setMessage(`${formatCaddyLabel({ ...draft, caddyType: 'DRIVING' })} 저장됨`);
      } finally {
        setSavingId(null);
      }
      return;
    }

    if (!draft.name.trim() || !draft.team.trim()) {
      alert('이름과 조는 필수입니다.');
      return;
    }
    const slot = Number(draft.teamOrder) || 0;
    if (slot < 1) {
      alert('고정 슬롯(조내순번)은 1 이상이어야 합니다.');
      return;
    }
    const teamChanging =
      originalDriving || (original != null && draft.team !== original.team);
    if (teamChanging && original) {
      const from = originalDriving
        ? '드라이빙'
        : `${original.team} ${original.teamOrder}번`;
      if (
        !confirm(
          `${formatCaddyLabel(original)}: ${from} → ${draft.team} ${slot}번으로 소속/조를 바꿀까요?\n기존 ID/계정은 유지되고, 이전 슬롯은 빈자리가 됩니다.`
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
          caddyType: isThirdBandTeam(draft.team) ? 'THIRD' : 'HOUSE',
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
      setMenuCaddyId(null);
      await load();
      setMessage(`${formatCaddyLabel(draft)} 저장됨`);
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
        `${formatCaddyLabel(c)}을(를) 드라이빙 전담 캐디로 바꿀까요?\n${slotNote}\n기존 스케줄/계정 연결 기록은 유지되지만 이후 일반 자동배치·HOUSE/THIRD 순번에는 참여하지 않습니다.`
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
      setMenuCaddyId(null);
      setMessage(`${formatCaddyLabel({ ...c, caddyType: 'DRIVING' })}: 드라이빙 캐디로 변경 (슬롯 해제)`);
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
    const confirmText =
      status === 'RETIRED'
        ? '이 캐디를 명단에서 삭제하시겠습니까?\n삭제하면 현재 명단과 자동배치에서 제외됩니다. 과거 배치 기록은 보존됩니다.'
        : status === 'LEAVE'
          ? `${formatCaddyLabel(c)}을(를) 휴직 처리할까요?\n과거 배정 기록은 유지됩니다.`
          : `${formatCaddyLabel(c)}을(를) 복귀시킬까요?`;
    if (!confirm(confirmText)) {
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
      // 상세 관리에서는 해당 필터로 전환. 현장표는 전체 로드를 유지한다.
      if (viewMode === 'detail') {
        setEmploymentFilter(status);
        await load(status);
      } else {
        await load('all');
      }
      setMenuCaddyId(null);
      const toast =
        status === 'RETIRED' ? '삭제됨' : status === 'LEAVE' ? '휴직' : '복귀';
      setMessage(`${formatCaddyLabel(c)}: ${toast}`);
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
        setMessage(`드라이빙 캐디 등록: ${formatCaddyLabel({ ...data, caddyType: 'DRIVING' })}`);
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
        `신규 등록: ${formatCaddyLabel(data)}`
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
          <p className="cm-headcount">총원 {rosterCounts.headcount}명</p>
        </div>
        <div className="cm-header-actions">
          <button
            type="button"
            className="cm-btn cm-btn-primary cm-btn-sm"
            onClick={() => {
              setCreateKind('regular');
              setCreateOpen(true);
            }}
          >
            신규 등록
          </button>
          {viewMode === 'summary' ? (
            <input
              className="cm-search cm-header-search"
              placeholder="이름 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="이름 검색"
            />
          ) : null}
          <button
            type="button"
            className={`cm-btn cm-btn-sm ${viewMode === 'detail' ? 'cm-btn-primary' : ''}`}
            onClick={() =>
              setViewMode((mode) => (mode === 'detail' ? 'summary' : 'detail'))
            }
          >
            {viewMode === 'detail' ? '현장표' : '상세 관리'}
          </button>
        </div>
      </header>

      {message && (
        <div
          className={`cm-banner${
            message === ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE ? ' is-error' : ''
          }`}
        >
          {message}
        </div>
      )}

      {createOpen && (
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
                    {EMPLOYMENT_STATUS_UI_LABELS[s]}
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
          <section className="cm-detail-tools" aria-label="상세 관리 도구">
            <button
              type="button"
              className="cm-btn cm-btn-sm"
              onClick={() => {
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
          </section>

          <section className="cm-filter-bar" aria-label="재직상태 필터">
            {(
              [
                ['all', '전체'],
                ['ACTIVE', '재직'],
                ['LEAVE', '휴직'],
                ['RETIRED', '삭제됨'],
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
              placeholder="이름 검색"
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
            총원 {rosterCounts.headcount}명 · 재직 일반캐디{' '}
            {rosterCounts.activeRegular}명 · 드라이빙캐디{' '}
            {rosterCounts.activeDriving}명
            <span className="cm-stats-hint">
              {' '}
              · 표시 {stats.total}명
            </span>
            {employmentFilter === 'ACTIVE' && (
              <span className="cm-stats-hint"> · 삭제된 캐디는 「삭제됨」 필터에서 조회·복귀</span>
            )}
            {employmentFilter === 'missing' && (
              <span className="cm-stats-hint">
                {' '}
                · 명단 누락은 경고이며 삭제가 아닙니다
              </span>
            )}
          </div>
        </>
      )}

      {loading ? (
        <p className="cm-muted">불러오는 중…</p>
      ) : viewMode === 'summary' ? (
        <div className="cm-roster-scroll" aria-label="조별 현장표">
          <div className="cm-roster">
            {rosterColumns.map((col) => (
              <section
                key={col.key}
                className={`cm-roster-col ${col.driving ? 'is-driving' : ''}`}
              >
                <header className="cm-roster-col-head">
                  <span className="cm-roster-col-title">{col.title}</span>
                  <span className="cm-roster-col-count">{col.count}명</span>
                </header>
                <ul className="cm-roster-list">
                  {col.members.length === 0 ? (
                    <li className="cm-roster-empty">없음</li>
                  ) : (
                    col.members.map((c) => {
                      const st = normalizeEmploymentStatus(c.employmentStatus);
                      const leave = st === 'LEAVE';
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            className={`cm-roster-cell ${leave ? 'is-leave' : ''}`}
                            onClick={() => {
                              setEditingId(null);
                              setMenuCaddyId(c.id);
                            }}
                          >
                            {!col.driving ? (
                              <span className="cm-ord">{c.teamOrder}</span>
                            ) : null}
                            {!col.driving ? (
                              <span className="cm-ord-sep" aria-hidden>
                                |
                              </span>
                            ) : null}
                            <span className="cm-cell-name">
                              {rosterPersonName(c)}
                            </span>
                            {leave ? (
                              <span className="cm-leave-badge">휴직</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>
            ))}
          </div>
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
                            <AffiliationTeamFields
                              draft={draft}
                              original={c}
                              emptySlots={editEmptySlots}
                              slotLabel="슬롯"
                              onChange={(patch) => updateDraft(c.id, patch)}
                            />
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
                                    {EMPLOYMENT_STATUS_UI_LABELS[s]}
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
                          {draft.affiliation !== 'DRIVING' && (
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
                            <strong className="cm-name">{formatCaddyLabel(c)}</strong>
                            {c.missingFromImport ? (
                              <span
                                className="cm-missing-tag"
                                title="최신 전체 명단에 없음. 삭제가 아닙니다."
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
                              {employmentStatusUiLabel(c.employmentStatus)}
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
                              {st !== 'RETIRED' && !isDriving && (
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
                                    삭제
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
                    <strong className="cm-name">{formatCaddyLabel(c)}</strong>
                    {c.missingFromImport ? (
                      <span className="cm-missing-tag">명단 누락</span>
                    ) : null}
                    <span
                      className={`cm-status ${
                        st === 'ACTIVE' ? 'ok' : st === 'LEAVE' ? 'leave' : 'out'
                      }`}
                    >
                      {employmentStatusUiLabel(c.employmentStatus)}
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
                          {st !== 'RETIRED' && !isDriving && (
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
                                삭제
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
                            <AffiliationTeamFields
                              draft={draft}
                              original={c}
                              emptySlots={editEmptySlots}
                              slotLabel="슬롯"
                              onChange={(patch) => updateDraft(c.id, patch)}
                            />
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
                                    {EMPLOYMENT_STATUS_UI_LABELS[s]}
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
                          {draft.affiliation !== 'DRIVING' && (
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
                setV1Resolutions({});
              }}
            >
              닫기
            </button>
          </div>
          <p className="cm-import-help">
            컬럼: <code>id,name,team,teamOrder,employmentStatus,phone[,thirdBandSubgroup]</code>
            · CSV 또는 표 형식 XLSX/XLS (첫 시트만, 시트 병합 없음) · id는 선택 · 빈 선택필드는 기존 유지 · 일반=3부구분 해제 · 삭제/재생성 없음 · extraFlags 미반영
            · 표 형식 CSV/XLSX는 최신 전체 일반 캐디(1~12조) 명단으로 처리됩니다. 일부 조만 올리면 파일에 없는 다른 조 재직/휴직자가 명단 누락으로 표시됩니다. 드라이빙은 대상이 아닙니다.
            · 조 제목형 XLSX(v1)는 기존 순번을 유지하고, 조 이동/신규만 빈 슬롯을 선택한 뒤 Apply 합니다. 파일 이름 순서는 순번이 아닙니다.
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
                  setV1Resolutions({});
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
            {importPreview?.format && (
              <span className="cm-import-format">
                인식 형식: {rosterImportFormatLabel(importPreview.format)}
              </span>
            )}
            <button
              type="button"
              className="cm-btn cm-btn-primary cm-btn-sm"
              disabled={
                importBusy ||
                (isXlsxV1SafePreview(importPreview)
                  ? !v1Ready.ready
                  : !isRosterImportV2ApplyFormat(importPreview?.format) ||
                    !importPreview?.applyPayload ||
                    !!importPreview.summary.applyBlocked)
              }
              onClick={async () => {
                if (isXlsxV1SafePreview(importPreview)) {
                  if (!v1Ready.ready) return;
                  if (
                    !confirm(
                      `조 제목형 XLSX v1을 반영할까요?\n변경없음 ${v1Ready.autoKeep} · 조 이동 ${v1Ready.move} · 신규 ${v1Ready.create}\n기존 ID/순번은 가능한 한 유지됩니다. 파일 순서는 순번이 아닙니다.\n파일에 없는 재직/휴직자는 '명단 누락'으로 표시됩니다(자동 삭제 없음).`
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
                        format: 'xlsx-v1',
                        importPeople: importPreview.importPeople,
                        resolutions: Object.values(v1Resolutions),
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
                    setV1Resolutions({});
                    setImportFileName(null);
                    setImportOpen(false);
                    await load('all');
                  } catch {
                    setImportApplyFailed(true);
                    setMessage(ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE);
                  } finally {
                    setImportBusy(false);
                  }
                  return;
                }
                if (!importPreview?.applyPayload) return;
                if (!isRosterImportV2ApplyFormat(importPreview.format)) return;
                if (
                  !confirm(
                    `명단을 반영할까요?\n이 파일은 최신 전체 일반 캐디(1~12조) 명단으로 처리됩니다.\n갱신 ${importPreview.summary.update} · 신규 ${importPreview.summary.create ?? 0}\n파일에 없는 재직/휴직자는 '명단 누락'으로 표시됩니다(자동 삭제 없음).\n일부 조만 올리면 다른 조 재직자도 누락으로 표시됩니다.`
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
                      format: importPreview.format,
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
                  setV1Resolutions({});
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
                <span className="cm-import-format">
                  인식 형식: {rosterImportFormatLabel(importPreview.format)}
                </span>
                {isXlsxV1SafePreview(importPreview) ? (
                  <>
                    <span>자동 반영 가능 {v1Ready.autoKeep}</span>
                    <span className={v1Ready.unresolved ? 'is-warn' : ''}>
                      관리자 확인 필요 {v1Ready.unresolved}
                    </span>
                    <span>신규 {v1Ready.create}</span>
                    <span>조 이동 {v1Ready.move}</span>
                    <span
                      className={
                        v1Ready.missing ? 'is-warn' : ''
                      }
                    >
                      누락 {v1Ready.missing}
                    </span>
                    <span className={v1Ready.reasons.length ? 'is-warn' : ''}>
                      Apply 차단 사유 {v1Ready.reasons.length}
                    </span>
                  </>
                ) : (
                  <>
                    <span>입력 {importPreview.summary.inputPeople ?? 0}</span>
                    <span>갱신 {importPreview.summary.update}</span>
                    <span>신규 {importPreview.summary.create ?? 0}</span>
                    <span>변경없음 {importPreview.summary.unchanged}</span>
                    <span
                      className={
                        importPreview.summary.needsReview ? 'is-warn' : ''
                      }
                    >
                      검토필요 {importPreview.summary.needsReview}
                    </span>
                    <span
                      className={
                        importPreview.summary.missingInImport ? 'is-warn' : ''
                      }
                    >
                      누락경고 {importPreview.summary.missingInImport}
                    </span>
                    <span
                      className={
                        importPreview.summary.phoneIssues ? 'is-warn' : ''
                      }
                    >
                      전화문제 {importPreview.summary.phoneIssues ?? 0}
                    </span>
                    <span
                      className={
                        importPreview.summary.teamOrderConflicts ? 'is-warn' : ''
                      }
                    >
                      순번충돌 {importPreview.summary.teamOrderConflicts ?? 0}
                    </span>
                  </>
                )}
              </div>
              {isXlsxV1SafePreview(importPreview) && (
                <>
                  <p className="cm-import-block">
                    조 제목형 XLSX v1로 인식되었습니다. 기존 캐디의 ID/순번은
                    유지하고, 조 이동·신규만 빈 슬롯을 선택한 뒤 Apply 합니다.
                    파일 위→아래 이름 순서·카트 번호는 순번이 아닙니다. extra-only
                    (주중반/주말반/드라이빙)는 1~12조에 자동 등록하지 않습니다.
                  </p>
                  {v1Ready.reasons.length > 0 && (
                    <ul className="cm-import-issues">
                      {v1Ready.reasons.map((reason, i) => (
                        <li key={`v1-block-${i}`}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {isRosterImportV2ApplyFormat(importPreview.format) &&
                importPreview.summary.applyBlocked && (
                <p className="cm-import-block">
                  needsReview / 전화번호 문제 / 조·순번 충돌이 있어 Apply가
                  비활성화되었습니다. 수정 후 다시 Preview 하세요. 누락 경고만으로는
                  막지 않습니다(자동 삭제 없음). Apply 후 누락자는 목록의 「명단 누락」
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
              {isRosterImportV2ApplyFormat(importPreview.format) &&
                (importPreview.teamOrderConflicts?.length ?? 0) > 0 && (
                <ul className="cm-import-issues">
                  {importPreview.teamOrderConflicts!.map((c, i) => (
                    <li key={`t-${i}`}>
                      [순번충돌] {c.team} 순번 {c.teamOrder}: {c.names.join(', ')}
                    </li>
                  ))}
                </ul>
              )}
              <div className="cm-import-table-wrap">
                {isXlsxV1SafePreview(importPreview) ? (
                  <table className="cm-import-table">
                    <thead>
                      <tr>
                        <th>구분</th>
                        <th>id</th>
                        <th>이름</th>
                        <th>파일 조</th>
                        <th>현재</th>
                        <th>확인 / 순번</th>
                        <th>사유</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v1MergedRows.map((row, idx) => {
                        const selected = v1Resolutions[row.name];
                        const matchId = row.matchId ?? selected?.matchId ?? null;
                        const asCreate = row.asCreate ?? selected?.asCreate ?? false;
                        const chosenOrder = row.teamOrder ?? null;
                        const matched = row.candidates.find((c) => c.id === matchId);
                        const reviewMove =
                          row.kind === 'needsReview' &&
                          !asCreate &&
                          matched != null &&
                          row.fileTeam != null &&
                          matched.team !== row.fileTeam;
                        const needsSlot =
                          row.kind === 'move' ||
                          row.kind === 'create' ||
                          (row.kind === 'needsReview' && asCreate) ||
                          reviewMove;
                        const emptySlots =
                          needsSlot && row.fileTeam
                            ? listV1ProjectedEmptySlots(
                                v1Occupants,
                                v1MergedRows,
                                row.fileTeam,
                                row.name
                              )
                            : [];
                        const currentText =
                          row.kind === 'missing' || row.kind === 'keep' || row.kind === 'move'
                            ? `${row.currentTeam ?? '—'} ${row.currentTeamOrder ?? '—'}번`
                            : matched
                              ? `${matched.team} ${matched.teamOrder}번`
                              : '—';
                        const identitySelect =
                          row.kind === 'needsReview' ? (
                            <select
                              className="cm-v1-select"
                              value={
                                asCreate
                                  ? 'create'
                                  : matchId != null
                                    ? String(matchId)
                                    : ''
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === 'create') {
                                  patchV1Resolution(row.name, {
                                    asCreate: true,
                                    matchId: null,
                                    teamOrder: null,
                                  });
                                  return;
                                }
                                if (!v) {
                                  patchV1Resolution(row.name, {
                                    asCreate: false,
                                    matchId: null,
                                    teamOrder: null,
                                  });
                                  return;
                                }
                                patchV1Resolution(row.name, {
                                  asCreate: false,
                                  matchId: Number(v),
                                  teamOrder: null,
                                });
                              }}
                            >
                              <option value="">기존 캐디/신규 선택</option>
                              {row.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {formatCaddyLabel(c)}
                                </option>
                              ))}
                              <option value="create">정말 신규인 경우 신규로 등록</option>
                            </select>
                          ) : null;
                        const slotSelect = needsSlot ? (
                          <select
                            className="cm-v1-select"
                            value={chosenOrder ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              patchV1Resolution(row.name, {
                                teamOrder: v ? Number(v) : null,
                              });
                            }}
                          >
                            <option value="">빈 슬롯 선택</option>
                            {emptySlots.map((n) => (
                              <option key={n} value={n}>
                                {n}번
                              </option>
                            ))}
                          </select>
                        ) : row.kind === 'keep' ? (
                          <span>기존 {row.currentTeamOrder ?? '—'}번 유지</span>
                        ) : row.kind === 'needsReview' && matchId != null && !reviewMove ? (
                          <span>기존 {matched?.teamOrder ?? '—'}번 유지</span>
                        ) : null;
                        return (
                          <tr
                            key={`${row.kind}-${row.key}-${idx}`}
                            className={`is-${row.kind}`}
                          >
                            <td>{V1_SAFE_KIND_LABEL[row.kind] ?? row.kind}</td>
                            <td>
                              {row.kind === 'create' || asCreate
                                ? '신규'
                                : matchId ?? row.currentId ?? '—'}
                            </td>
                            <td>{row.name}</td>
                            <td>{row.fileTeam ?? '—'}</td>
                            <td>{currentText}</td>
                            <td>
                              <div className="cm-v1-actions">
                                {identitySelect}
                                {slotSelect}
                              </div>
                            </td>
                            <td>{row.reason ?? ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
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
                    {(importPreview.lines ?? []).map((line, idx) => {
                      const actionLabel: Record<string, string> = {
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
                          <td>{actionLabel[line.action] ?? line.action}</td>
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
                )}
              </div>
            </>
          )}
        </section>
      )}

      {menuCaddy && (
        <div
          className="cm-sheet-overlay"
          role="presentation"
          onClick={() => {
            setMenuCaddyId(null);
            if (editingId === menuCaddy.id) cancelEdit();
          }}
        >
          <div
            className="cm-sheet"
            role="dialog"
            aria-label={formatCaddyLabel(menuCaddy)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cm-sheet-head">
              <div className="cm-sheet-title">
                <strong>{formatCaddyLabel(menuCaddy)}</strong>
                {!isDrivingCaddy(menuCaddy) ? (
                  <span className="cm-sheet-sub">
                    {menuCaddy.teamOrder}번
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="cm-btn cm-btn-sm"
                onClick={() => {
                  setMenuCaddyId(null);
                  if (editingId === menuCaddy.id) cancelEdit();
                }}
              >
                닫기
              </button>
            </div>
            {editingId === menuCaddy.id ? (
              <div className="cm-sheet-edit">
                {(() => {
                  const c = menuCaddy;
                  const draft = drafts[c.id] ?? toDraft(c);
                  const busy = savingId === c.id;
                  return (
                    <>
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
                        <AffiliationTeamFields
                          draft={draft}
                          original={c}
                          emptySlots={editEmptySlots}
                          slotLabel="순번"
                          onChange={(patch) => updateDraft(c.id, patch)}
                        />
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
                                {EMPLOYMENT_STATUS_UI_LABELS[s]}
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
                      {draft.affiliation !== 'DRIVING' && (
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
                      <div className="cm-sheet-actions">
                        <button
                          type="button"
                          className="cm-btn cm-btn-primary"
                          disabled={busy}
                          onClick={() => saveEdit(c.id)}
                        >
                          {busy ? '저장 중…' : '저장'}
                        </button>
                        <button
                          type="button"
                          className="cm-btn"
                          disabled={busy}
                          onClick={cancelEdit}
                        >
                          취소
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="cm-sheet-actions">
                {(() => {
                  const c = menuCaddy;
                  const busy = savingId === c.id;
                  const st = normalizeEmploymentStatus(c.employmentStatus);
                  const isDriving = isDrivingCaddy(c);
                  const leave = st === 'LEAVE';
                  return (
                    <>
                      {leave ? (
                        <button
                          type="button"
                          className="cm-btn cm-btn-primary"
                          disabled={busy}
                          onClick={() => setEmployment(c, 'ACTIVE')}
                        >
                          복귀
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="cm-btn"
                        disabled={busy}
                        onClick={() => startEdit(c)}
                      >
                        수정
                      </button>
                      {!leave ? (
                        <button
                          type="button"
                          className="cm-btn"
                          disabled={busy}
                          onClick={() => startEdit(c)}
                        >
                          소속/조 변경
                        </button>
                      ) : null}
                      {!leave ? (
                        <button
                          type="button"
                          className="cm-btn"
                          disabled={busy}
                          onClick={() => setEmployment(c, 'LEAVE')}
                        >
                          휴직
                        </button>
                      ) : null}
                      {!isDriving && !leave ? (
                        <button
                          type="button"
                          className="cm-btn"
                          disabled={busy}
                          onClick={() => convertToDriving(c)}
                        >
                          드라이빙 전환
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="cm-btn cm-btn-danger"
                        disabled={busy}
                        onClick={() => setEmployment(c, 'RETIRED')}
                      >
                        삭제
                      </button>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .caddy-manage {
          max-width: 100%;
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
        .cm-header-search {
          min-width: min(220px, 100%);
          flex: 1 1 160px;
        }
        .cm-headcount {
          margin: 4px 0 0;
          font-size: 0.82rem;
          color: var(--vh-muted);
          font-weight: 600;
        }
        .cm-detail-tools {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 0 0 10px;
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
        .cm-roster-scroll {
          overflow-x: auto;
          overflow-y: auto;
          max-height: calc(100dvh - 170px);
          -webkit-overflow-scrolling: touch;
          border: 1px solid var(--vh-border);
          border-radius: var(--vh-radius-sm);
          background: var(--vh-paper);
        }
        .cm-roster {
          display: flex;
          align-items: flex-start;
          min-width: max-content;
        }
        .cm-roster-col {
          flex: 0 0 168px;
          min-width: 168px;
          border-right: 1px solid var(--vh-border);
        }
        .cm-roster-col:last-child {
          border-right: 0;
        }
        .cm-roster-col.is-driving {
          background: #faf8ff;
        }
        .cm-roster-col-head {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 6px;
          min-height: 44px;
          padding: 8px 10px;
          background: var(--vh-green-900);
          color: #fff;
          font-weight: 700;
        }
        .cm-roster-col.is-driving .cm-roster-col-head {
          background: #5b21b6;
        }
        .cm-roster-col-title {
          font-size: 0.92rem;
        }
        .cm-roster-col-count {
          font-size: 0.75rem;
          font-weight: 600;
          opacity: 0.9;
          white-space: nowrap;
        }
        .cm-roster-list {
          list-style: none;
          margin: 0;
          padding: 4px 0 8px;
        }
        .cm-roster-empty {
          padding: 12px 10px;
          color: var(--vh-muted);
          font-size: 0.8rem;
        }
        .cm-roster-cell {
          width: 100%;
          min-height: 44px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border: 0;
          background: transparent;
          text-align: left;
          font: inherit;
          cursor: pointer;
          color: inherit;
        }
        .cm-roster-cell:hover,
        .cm-roster-cell:focus-visible {
          background: #fff7e6;
        }
        .cm-roster-cell.is-leave {
          opacity: 0.72;
          color: #78716c;
        }
        .cm-ord {
          flex: 0 0 1.6em;
          font-variant-numeric: tabular-nums;
          font-weight: 800;
          font-size: 0.92rem;
          color: var(--vh-green-900);
          text-align: right;
        }
        .cm-ord-sep {
          color: #cbd5e1;
          font-weight: 600;
        }
        .cm-cell-name {
          flex: 1 1 auto;
          min-width: 0;
          font-size: 0.95rem;
          font-weight: 700;
          line-height: 1.25;
        }
        .cm-leave-badge {
          flex: 0 0 auto;
          font-size: 0.65rem;
          font-weight: 800;
          color: #92400e;
          background: #fef3c7;
          border-radius: 4px;
          padding: 1px 5px;
        }
        .cm-sheet-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          z-index: 80;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        .cm-sheet {
          width: 100%;
          max-width: 480px;
          background: #fff;
          border-radius: 16px 16px 0 0;
          padding: 12px 14px calc(20px + env(safe-area-inset-bottom, 0px));
          max-height: 85vh;
          overflow: auto;
          box-shadow: 0 -8px 24px rgba(15, 23, 42, 0.18);
        }
        .cm-sheet-head {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
          margin-bottom: 10px;
        }
        .cm-sheet-title {
          display: grid;
          gap: 2px;
        }
        .cm-sheet-title strong {
          font-size: 1.08rem;
        }
        .cm-sheet-sub {
          font-size: 0.82rem;
          color: var(--vh-muted);
        }
        .cm-sheet-actions {
          display: grid;
          gap: 8px;
        }
        .cm-sheet-actions .cm-btn {
          min-height: 48px;
          width: 100%;
          justify-content: flex-start;
          font-size: 1rem;
          font-weight: 700;
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
        .cm-import-format {
          font-size: 0.75rem;
          font-weight: 700;
          padding: 4px 8px;
          border-radius: 999px;
          background: #e8eef7;
          color: #1e3a5f;
        }
        .cm-import-summary span.cm-import-format {
          background: #e8eef7;
          color: #1e3a5f;
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
        .cm-import-table tr.is-move { background: #eff6ff; }
        .cm-import-table tr.is-keep { background: #f8fafc; }
        .cm-import-table tr.is-extraOnly,
        .cm-import-table tr.is-invalid { background: #f8fafc; color: #64748b; }
        .cm-import-table tr.is-phoneOnlyUpdate { background: #eff6ff; }
        .cm-import-table tr.is-missing,
        .cm-import-table tr.is-missingInImport {
          background: #f8fafc;
          color: #64748b;
        }
        .cm-v1-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }
        .cm-v1-select {
          max-width: 220px;
          font-size: 0.78rem;
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
