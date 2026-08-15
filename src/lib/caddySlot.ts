/**
 * 고정 슬롯 (team + teamOrder) 점유 규칙 + 조별 capacity 중앙 관리.
 * - ACTIVE / LEAVE = 슬롯 보유
 * - RETIRED = 점유하지 않음 (빈자리로 취급)
 * - 렌더 범위 = max(configured capacity, observed max teamOrder)
 * - 신규/편집/이동 선택 범위 = configured capacity
 * DB unique migration 없이 앱 레벨 검증용.
 */

export const SLOT_HOLDING_STATUSES = ["ACTIVE", "LEAVE"] as const;
export type SlotHoldingStatus = (typeof SLOT_HOLDING_STATUSES)[number];

/** 기본 조별 슬롯 capacity (운영 기준). UI/API/Import는 이 값을 직접 하드코딩하지 말 것. */
export const DEFAULT_SLOT_CAPACITY = 24;

/**
 * 팀별 capacity override (필요 시만 사용).
 * 예: { "3조": 30 }
 */
export const TEAM_SLOT_CAPACITY_OVERRIDES: Readonly<Record<string, number>> =
  Object.freeze({});

export type SlotOccupant = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

export function empStatusLabel(status: string | null | undefined): string {
  const u = String(status ?? "").toUpperCase();
  if (u === "ACTIVE" || status === "재직") return "ACTIVE";
  if (u === "LEAVE" || status === "휴직") return "LEAVE";
  if (u === "RETIRED" || status === "퇴사") return "RETIRED";
  return String(status ?? "");
}

export function isSlotHoldingStatus(
  status: string | null | undefined
): boolean {
  const e = empStatusLabel(status);
  return e === "ACTIVE" || e === "LEAVE";
}

/** 해당 조의 설정된 capacity (기본값 또는 team override). */
export function getConfiguredSlotCapacity(team?: string | null): number {
  const t = String(team ?? "").trim();
  if (t && Object.prototype.hasOwnProperty.call(TEAM_SLOT_CAPACITY_OVERRIDES, t)) {
    const n = Number(TEAM_SLOT_CAPACITY_OVERRIDES[t]);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_SLOT_CAPACITY;
}

/** 조 내 관측된 최대 슬롯 번호 (1 미만은 무시). */
export function observedMaxTeamOrder(
  rows: Array<{ teamOrder: number | null | undefined }>,
  fallbackMin = 0
): number {
  let max = 0;
  for (const r of rows) {
    const n = Number(r.teamOrder) || 0;
    if (n > max) max = n;
  }
  return Math.max(fallbackMin, max);
}

/**
 * 화면 표시용 유효 슬롯 수.
 * max(설정된 capacity, 관측된 최대 teamOrder) — 초과 기존 데이터가 숨겨지지 않음.
 */
export function resolveEffectiveSlotCount(
  team: string | null | undefined,
  rows: Array<{ teamOrder: number | null | undefined }>
): number {
  const configured = getConfiguredSlotCapacity(team);
  const observed = observedMaxTeamOrder(rows, 0);
  return Math.max(configured, observed);
}

/**
 * 복수 조 그리드 공통 행 수 (조별 effective의 최댓값).
 * capacity보다 큰 기존 데이터가 있으면 그만큼 행이 늘어남.
 */
export function resolveGridSlotCount(
  teams: string[],
  occupants: Array<{ team: string; teamOrder: number | null | undefined }>
): number {
  let max = getConfiguredSlotCapacity(null);
  for (const team of teams) {
    const rows = occupants.filter((o) => o.team === team);
    max = Math.max(max, resolveEffectiveSlotCount(team, rows));
  }
  // 팀이 비어 있어도 기본 capacity는 유지
  if (occupants.length > 0) {
    for (const o of occupants) {
      const n = Number(o.teamOrder) || 0;
      if (n > max) max = n;
    }
  }
  return max;
}

/** 신규 등록 / 조 이동 / 편집에서 선택 가능한 정상 슬롯 상한 (= configured capacity). */
export function resolveSelectableSlotCount(team?: string | null): number {
  return getConfiguredSlotCapacity(team);
}

/** capacity 초과 기존 슬롯인지 (경고용, 삭제/재번호 금지). */
export function isOverCapacitySlot(
  team: string | null | undefined,
  teamOrder: number
): boolean {
  return (
    Number.isInteger(teamOrder) &&
    teamOrder > getConfiguredSlotCapacity(team)
  );
}

export class SlotOutOfRangeError extends Error {
  status = 400;
  code = "slot_out_of_range";
  constructor(message: string) {
    super(message);
    this.name = "SlotOutOfRangeError";
  }
}

/**
 * 신규/이동 대상 슬롯이 설정 capacity 이내인지 검증.
 * 기존 capacity 초과 점유를 유지한 채 자기 자신만 편집하는 경우는 excludeCurrentOrder로 허용.
 */
export function assertSlotWithinConfiguredCapacity(
  team: string,
  teamOrder: number,
  options?: { allowCurrentOverCapacity?: number | null }
): void {
  if (!Number.isInteger(teamOrder) || teamOrder < 1) {
    throw new SlotOutOfRangeError("슬롯(teamOrder)은 1 이상 정수여야 합니다.");
  }
  const cap = getConfiguredSlotCapacity(team);
  if (teamOrder <= cap) return;
  if (
    options?.allowCurrentOverCapacity != null &&
    teamOrder === options.allowCurrentOverCapacity
  ) {
    return;
  }
  throw new SlotOutOfRangeError(
    `${team} 슬롯은 1~${cap}만 선택 가능합니다. (요청: ${teamOrder})`
  );
}

/**
 * ACTIVE+LEAVE 기준 team#teamOrder 중복 목록.
 * RETIRED / teamOrder&lt;1 제외. excludeIds는 자기 자신(업데이트) 제외.
 */
export function findSlotHoldingConflicts(
  people: Array<{
    id: number | null;
    name: string;
    team: string;
    teamOrder: number;
    emp: string;
  }>,
  options?: { excludeIds?: number[] }
): Array<{
  team: string;
  teamOrder: number;
  names: string[];
  ids: Array<number | null>;
}> {
  const exclude = new Set(options?.excludeIds ?? []);
  const holders = people.filter((p) => {
    if (!isSlotHoldingStatus(p.emp)) return false;
    if (!p.teamOrder || p.teamOrder < 1) return false;
    if (p.id != null && exclude.has(p.id)) return false;
    return true;
  });

  const groups = new Map<string, typeof holders>();
  for (const p of holders) {
    const key = `${p.team}#${p.teamOrder}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const conflicts: Array<{
    team: string;
    teamOrder: number;
    names: string[];
    ids: Array<number | null>;
  }> = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    conflicts.push({
      team: list[0].team,
      teamOrder: list[0].teamOrder,
      names: list.map((x) => x.name),
      ids: list.map((x) => x.id),
    });
  }
  return conflicts;
}

/** 해당 조·슬롯을 점유한 ACTIVE/LEAVE 캐디 (없으면 null) */
export function findSlotOccupant(
  people: SlotOccupant[],
  team: string,
  teamOrder: number,
  excludeId?: number | null
): SlotOccupant | null {
  for (const p of people) {
    if (excludeId != null && p.id === excludeId) continue;
    if (!isSlotHoldingStatus(p.employmentStatus)) continue;
    if (p.team !== team) continue;
    if (Number(p.teamOrder) !== teamOrder) continue;
    return p;
  }
  return null;
}

/** 조 내 빈 슬롯 번호 목록 (1..maxSlot) */
export function listEmptySlots(
  people: SlotOccupant[],
  team: string,
  maxSlot: number,
  options?: { excludeId?: number | null }
): number[] {
  const occupied = new Set<number>();
  for (const p of people) {
    if (options?.excludeId != null && p.id === options.excludeId) continue;
    if (!isSlotHoldingStatus(p.employmentStatus)) continue;
    if (p.team !== team) continue;
    const n = Number(p.teamOrder) || 0;
    if (n >= 1) occupied.add(n);
  }
  const empty: number[] = [];
  for (let i = 1; i <= maxSlot; i++) {
    if (!occupied.has(i)) empty.push(i);
  }
  return empty;
}

/** 선택 가능한 빈 슬롯 (configured capacity 범위). */
export function listSelectableEmptySlots(
  people: SlotOccupant[],
  team: string,
  options?: { excludeId?: number | null }
): number[] {
  return listEmptySlots(
    people,
    team,
    resolveSelectableSlotCount(team),
    options
  );
}

export class SlotOccupiedError extends Error {
  status = 409;
  code = "slot_occupied";
  constructor(
    message: string,
    public occupant?: { id: number; name: string }
  ) {
    super(message);
    this.name = "SlotOccupiedError";
  }
}

export function assertSlotAvailable(
  people: SlotOccupant[],
  team: string,
  teamOrder: number,
  excludeId?: number | null
): void {
  if (!Number.isInteger(teamOrder) || teamOrder < 1) {
    throw new SlotOccupiedError("슬롯(teamOrder)은 1 이상 정수여야 합니다.");
  }
  const occ = findSlotOccupant(people, team, teamOrder, excludeId);
  if (occ) {
    throw new SlotOccupiedError(
      `${team} ${teamOrder}번 슬롯은 이미 ${occ.name}(id=${occ.id}, ${empStatusLabel(occ.employmentStatus)})이(가) 점유 중입니다.`,
      { id: occ.id, name: occ.name }
    );
  }
}
