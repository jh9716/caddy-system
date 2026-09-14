/**
 * 특수지원 v1 (순수 도메인, DB write 없음)
 * - 원래 자동가용에서 제외된 ACTIVE 캐디가 지정 부에만 추가 근무
 * - 해당 부 capacity 안에 반드시 포함. HOUSE 부족 시에만 붙는 overflow가 아님
 * - 지원 인원만큼 그 부의 뒤쪽 정상 HOUSE 소비를 줄인다. 앞 순번은 유지
 * - 찾근 특수근무와 무관. DailySpecialDuty 에 넣지 않음
 */

import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

export const SPECIAL_SUPPORT_SHIFTS = SHIFT_PARTS;
export type SpecialSupportShift = ShiftPart;

export const SPECIAL_SUPPORT_CHANGED_MESSAGE =
  "특수지원 설정이 변경되었습니다. 현재 작업본에 반영하려면 배치를 다시 맞춰 주세요.";

const HARD_EXCLUSION_PATTERNS = [
  /병가/,
  /장기병가/,
  /결근/,
  /미출근/,
  /휴직/,
  /퇴사/,
  /\bSICK\b/i,
  /\bLONG_SICK\b/i,
  /\bATTENDANCE/,
  /\bNOSHOW\b/i,
  /\bLEAVE\b/,
  /\bRETIRED\b/,
  /삭제/,
];

export type SpecialSupportUnavailable = {
  caddyId: number;
  reason?: string | null;
  effectiveFromShift?: string | null;
};

export type SpecialSupportCandidateRow = {
  id: number;
  name: string;
  team: string;
  teamOrder?: number;
  employmentStatus?: string | null;
  excludedReasons?: string[] | null;
  caddyType?: string | null;
  thirdBandSubgroup?: string | null;
  extraFlags?: string[] | null;
};

export type SpecialSupportRecord = {
  id?: number;
  date: string;
  caddyId: number;
  /** 단일부 호환값(1부/2부/3부) 또는 1·2부/54 저장용 문자열 */
  shift: string;
  kind?: DailySpecialSupportKind;
  workPattern?: DailySpecialSupportWorkPattern;
  sortOrder?: number;
  name?: string;
  team?: string;
  teamOrder?: number;
  excludedReasons?: string[];
  blocked?: boolean;
  blockedReason?: string | null;
};

export const DAILY_SPECIAL_SUPPORT_KINDS = [
  "CHAGEUN",
  "SPECIAL_SUPPORT",
  "OFF_SUPPORT",
  "MARSHAL_SUPPORT",
  "LEADER_SUPPORT",
  "FIFTY_FOUR_SUPPORT",
] as const;

export type DailySpecialSupportKind = (typeof DAILY_SPECIAL_SUPPORT_KINDS)[number];

export const DAILY_SPECIAL_SUPPORT_KIND_LABELS: Record<
  DailySpecialSupportKind,
  string
> = {
  CHAGEUN: "찾근",
  SPECIAL_SUPPORT: "특수지원",
  OFF_SUPPORT: "휴무지원",
  MARSHAL_SUPPORT: "마샬지원",
  LEADER_SUPPORT: "조장지원",
  FIFTY_FOUR_SUPPORT: "54지원",
};

/** 탭 칩용 짧은 이름 */
export const DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS: Record<
  DailySpecialSupportKind,
  string
> = {
  CHAGEUN: "찾근",
  SPECIAL_SUPPORT: "특수",
  OFF_SUPPORT: "휴무",
  MARSHAL_SUPPORT: "마샬",
  LEADER_SUPPORT: "조장",
  FIFTY_FOUR_SUPPORT: "54지원",
};

/** 배치표 compact badge */
export const DAILY_SPECIAL_SUPPORT_KIND_BADGES: Record<
  DailySpecialSupportKind,
  string
> = {
  CHAGEUN: "찾",
  SPECIAL_SUPPORT: "특",
  OFF_SUPPORT: "휴",
  MARSHAL_SUPPORT: "마",
  LEADER_SUPPORT: "조",
  FIFTY_FOUR_SUPPORT: "54지",
};

export const DAILY_SPECIAL_SUPPORT_WORK_PATTERNS = [
  "ONE_TWO",
  "SHIFT_1",
  "SHIFT_2",
  "SHIFT_3",
  "FIFTY_FOUR",
] as const;

export type DailySpecialSupportWorkPattern =
  (typeof DAILY_SPECIAL_SUPPORT_WORK_PATTERNS)[number];

export const DAILY_SPECIAL_SUPPORT_WORK_PATTERN_LABELS: Record<
  DailySpecialSupportWorkPattern,
  string
> = {
  ONE_TWO: "1·2부",
  SHIFT_1: "1부",
  SHIFT_2: "2부",
  SHIFT_3: "3부",
  FIFTY_FOUR: "54",
};

export const DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS: Record<
  DailySpecialSupportWorkPattern,
  string
> = {
  ONE_TWO: "1·2",
  SHIFT_1: "1",
  SHIFT_2: "2",
  SHIFT_3: "3",
  FIFTY_FOUR: "54",
};

export const DEFAULT_SPECIAL_SUPPORT_KIND: DailySpecialSupportKind =
  "SPECIAL_SUPPORT";

export function isDailySpecialSupportKind(
  value: unknown
): value is DailySpecialSupportKind {
  return DAILY_SPECIAL_SUPPORT_KINDS.includes(
    String(value) as DailySpecialSupportKind
  );
}

export function isDailySpecialSupportWorkPattern(
  value: unknown
): value is DailySpecialSupportWorkPattern {
  return DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.includes(
    String(value) as DailySpecialSupportWorkPattern
  );
}

export function workPatternFromShift(
  shift: ShiftPart
): DailySpecialSupportWorkPattern {
  if (shift === "1부") return "SHIFT_1";
  if (shift === "2부") return "SHIFT_2";
  return "SHIFT_3";
}

/** 단일부 패턴 → 기존 shift 컬럼 호환값. 1·2/54는 엔진 ShiftPart가 아님. */
export function shiftCompatFromWorkPattern(
  pattern: DailySpecialSupportWorkPattern
): string {
  if (pattern === "SHIFT_1") return "1부";
  if (pattern === "SHIFT_2") return "2부";
  if (pattern === "SHIFT_3") return "3부";
  if (pattern === "ONE_TWO") return "1·2부";
  return "54";
}

export function workPatternFromStoredShift(
  shift: unknown
): DailySpecialSupportWorkPattern | null {
  const raw = String(shift || "").trim();
  if (raw === "1부") return "SHIFT_1";
  if (raw === "2부") return "SHIFT_2";
  if (raw === "3부") return "SHIFT_3";
  if (raw === "1·2부" || raw === "1.2부" || raw === "ONE_TWO") return "ONE_TWO";
  if (raw === "54" || raw === "FIFTY_FOUR") return "FIFTY_FOUR";
  return null;
}

export function resolveSupportWorkPattern(row: {
  workPattern?: unknown;
  shift?: unknown;
}): DailySpecialSupportWorkPattern {
  if (isDailySpecialSupportWorkPattern(row.workPattern)) return row.workPattern;
  const fromShift = workPatternFromStoredShift(row.shift);
  if (fromShift) return fromShift;
  return "SHIFT_1";
}

export function resolveSupportKind(row: {
  kind?: unknown;
}): DailySpecialSupportKind {
  if (isDailySpecialSupportKind(row.kind)) return row.kind;
  return DEFAULT_SPECIAL_SUPPORT_KIND;
}

/**
 * 기존 shift 기반 엔진에 넣는 행만.
 * SPECIAL_SUPPORT + 단일부(SHIFT_1/2/3)만 기존 꼬리 배치 큐로 전달한다.
 * 1·2/54 및 다른 유형은 저장만 하고 이번 PR에서 배치하지 않는다.
 */
export function isEngineEligibleSupportRecord(row: {
  kind?: unknown;
  workPattern?: unknown;
  shift?: unknown;
}): boolean {
  if (resolveSupportKind(row) !== DEFAULT_SPECIAL_SUPPORT_KIND) return false;
  const pattern = resolveSupportWorkPattern(row);
  if (pattern !== "SHIFT_1" && pattern !== "SHIFT_2" && pattern !== "SHIFT_3") {
    return false;
  }
  return isSpecialSupportShift(shiftCompatFromWorkPattern(pattern));
}

export function supportBoardBadgeLabels(
  kind?: unknown,
  workPattern?: unknown
): { kind: string; pattern: string } {
  const resolvedKind = resolveSupportKind({ kind });
  const resolvedPattern = isDailySpecialSupportWorkPattern(workPattern)
    ? workPattern
    : resolveSupportWorkPattern({ workPattern, shift: workPattern });
  return {
    kind: DAILY_SPECIAL_SUPPORT_KIND_BADGES[resolvedKind],
    pattern: DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS[resolvedPattern],
  };
}

export function groupSupportRecordsByKindPattern(
  rows: readonly SpecialSupportRecord[]
): Record<
  DailySpecialSupportKind,
  Record<DailySpecialSupportWorkPattern, SpecialSupportRecord[]>
> {
  const out = {} as Record<
    DailySpecialSupportKind,
    Record<DailySpecialSupportWorkPattern, SpecialSupportRecord[]>
  >;
  for (const kind of DAILY_SPECIAL_SUPPORT_KINDS) {
    out[kind] = {
      ONE_TWO: [],
      SHIFT_1: [],
      SHIFT_2: [],
      SHIFT_3: [],
      FIFTY_FOUR: [],
    };
  }
  for (const row of rows) {
    const kind = resolveSupportKind(row);
    const pattern = resolveSupportWorkPattern(row);
    out[kind][pattern].push(row);
  }
  for (const kind of DAILY_SPECIAL_SUPPORT_KINDS) {
    for (const pattern of DAILY_SPECIAL_SUPPORT_WORK_PATTERNS) {
      out[kind][pattern].sort(
        (a, b) =>
          (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
          (a.id || 0) - (b.id || 0)
      );
    }
  }
  return out;
}

export function sameSupportGroup(
  a: Pick<SpecialSupportRecord, "kind" | "workPattern" | "shift">,
  b: Pick<SpecialSupportRecord, "kind" | "workPattern" | "shift">
): boolean {
  return (
    resolveSupportKind(a) === resolveSupportKind(b) &&
    resolveSupportWorkPattern(a) === resolveSupportWorkPattern(b)
  );
}

export function compareSupportRecordsForDisplay(
  a: SpecialSupportRecord,
  b: SpecialSupportRecord
): number {
  const kindA = DAILY_SPECIAL_SUPPORT_KINDS.indexOf(resolveSupportKind(a));
  const kindB = DAILY_SPECIAL_SUPPORT_KINDS.indexOf(resolveSupportKind(b));
  if (kindA !== kindB) return kindA - kindB;
  const patternA = DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.indexOf(
    resolveSupportWorkPattern(a)
  );
  const patternB = DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.indexOf(
    resolveSupportWorkPattern(b)
  );
  if (patternA !== patternB) return patternA - patternB;
  return (
    (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
    (a.id || 0) - (b.id || 0)
  );
}

export function displaySupportRecords(
  rows: readonly SpecialSupportRecord[],
  kind?: DailySpecialSupportKind | "ALL" | null
): SpecialSupportRecord[] {
  const filtered =
    !kind || kind === "ALL"
      ? [...rows]
      : rows.filter((row) => resolveSupportKind(row) === kind);
  return filtered.sort(compareSupportRecordsForDisplay);
}

export function countSupportByKind(
  rows: readonly SpecialSupportRecord[]
): Record<DailySpecialSupportKind, number> {
  const out = {} as Record<DailySpecialSupportKind, number>;
  for (const kind of DAILY_SPECIAL_SUPPORT_KINDS) out[kind] = 0;
  for (const row of rows) out[resolveSupportKind(row)] += 1;
  return out;
}

export function isSpecialSupportShift(value: unknown): value is ShiftPart {
  return SHIFT_PARTS.includes(String(value) as ShiftPart);
}

export function emptySpecialSupportByShift(): Record<ShiftPart, AutoAssignCaddy[]> {
  return { "1부": [], "2부": [], "3부": [] };
}

/** 부에 상관없이 특수지원으로 등록된 caddyId. regular HOUSE/THIRD 후보에서 뺀다. */
export function specialSupportCaddyIds(
  byShift?: Record<ShiftPart, AutoAssignCaddy[]> | null
): Set<number> {
  const ids = new Set<number>();
  if (!byShift) return ids;
  for (const shift of SHIFT_PARTS) {
    for (const caddy of byShift[shift] || []) {
      const id = Number(caddy?.id);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return ids;
}

export function isInactiveEmployment(status: unknown): boolean {
  const raw = String(status ?? "").trim().toUpperCase();
  if (!raw) return false;
  if (raw === "ACTIVE" || raw === "재직") return false;
  return (
    raw === "LEAVE" ||
    raw === "RETIRED" ||
    raw === "DELETED" ||
    raw === "휴직" ||
    raw === "퇴사" ||
    raw === "삭제" ||
    raw === "삭제됨" ||
    raw.includes("LEAVE") ||
    raw.includes("RETIRED") ||
    raw.includes("DELETED")
  );
}

export function hasHardExclusionReason(
  reasons: readonly string[] | null | undefined
): boolean {
  for (const reason of reasons || []) {
    const text = String(reason || "");
    if (!text.trim()) continue;
    if (HARD_EXCLUSION_PATTERNS.some((re) => re.test(text))) return true;
  }
  return false;
}

export function isHardExcludedSpecialSupport(row: {
  employmentStatus?: string | null;
  excludedReasons?: string[] | null;
}): boolean {
  if (isInactiveEmployment(row.employmentStatus)) return true;
  return hasHardExclusionReason(row.excludedReasons);
}

export function isEligibleSpecialSupportCandidate(row: SpecialSupportCandidateRow): boolean {
  if (!(row.id > 0) || !String(row.name || "").trim()) return false;
  if (isHardExcludedSpecialSupport(row)) return false;
  const reasons = (row.excludedReasons || []).map((r) => String(r).trim()).filter(Boolean);
  return reasons.length > 0;
}

export function exclusionLabel(reasons: readonly string[] | null | undefined): string {
  const cleaned = (reasons || []).map((r) => String(r).trim()).filter(Boolean);
  if (cleaned.length === 0) return "제외";
  return cleaned.join(" · ");
}

const SHIFT_RANK: Record<ShiftPart, number> = { "1부": 1, "2부": 2, "3부": 3 };

export function supportBlockedByUnavailable(
  row: SpecialSupportUnavailable | null | undefined,
  shift: ShiftPart
): boolean {
  if (!row) return false;
  const reason = String(row.reason || "").toUpperCase();
  if (reason === "ATTENDANCE_NOSHOW" || /결근|미출근/.test(String(row.reason || ""))) {
    return true;
  }
  const from = isSpecialSupportShift(row.effectiveFromShift)
    ? row.effectiveFromShift
    : "1부";
  return SHIFT_RANK[shift] >= SHIFT_RANK[from];
}

export function filterSupportQueueForShift(input: {
  queue: readonly AutoAssignCaddy[];
  shift: ShiftPart;
  /** 호출 호환용. regular pool 소속만으로 지원 큐에서 제거하지 않는다. */
  normalIds?: Iterable<number>;
  usedInShift: Iterable<number>;
  unavailable?: readonly SpecialSupportUnavailable[];
}): AutoAssignCaddy[] {
  const used = new Set([...input.usedInShift].map(Number));
  const unavailableById = new Map(
    (input.unavailable || []).map((row) => [row.caddyId, row])
  );
  const out: AutoAssignCaddy[] = [];
  const seen = new Set<number>();
  for (const caddy of input.queue) {
    if (!(caddy.id > 0) || seen.has(caddy.id)) continue;
    if (used.has(caddy.id)) continue;
    if (isHardExcludedSpecialSupport(caddy)) continue;
    if (supportBlockedByUnavailable(unavailableById.get(caddy.id), input.shift)) {
      continue;
    }
    seen.add(caddy.id);
    out.push(caddy);
  }
  return out;
}

export function pickNextSpecialSupport(
  queue: readonly AutoAssignCaddy[],
  usedInShift: Iterable<number>
): AutoAssignCaddy | null {
  const used = new Set([...usedInShift].map(Number));
  return queue.find((caddy) => !used.has(caddy.id)) ?? null;
}

export function unusedSupportCount(
  queue: readonly AutoAssignCaddy[],
  usedInShift: Iterable<number>
): number {
  const used = new Set([...usedInShift].map(Number));
  let n = 0;
  for (const caddy of queue) {
    if (!(caddy.id > 0) || used.has(caddy.id)) continue;
    n += 1;
  }
  return n;
}

/**
 * Remaining reservations including the current slot are reserved for support
 * when they fit in the unused support queue. Regular HOUSE is not consumed
 * on those tail slots.
 */
export function isReservedSupportTailSlot(input: {
  remainingIncludingCurrent: number;
  supportLeft: number;
}): boolean {
  const remaining = Number(input.remainingIncludingCurrent);
  const supportLeft = Number(input.supportLeft);
  return remaining > 0 && supportLeft > 0 && remaining <= supportLeft;
}

export function groupSupportRecordsByShift(
  rows: readonly SpecialSupportRecord[]
): Record<ShiftPart, SpecialSupportRecord[]> {
  const out: Record<ShiftPart, SpecialSupportRecord[]> = {
    "1부": [],
    "2부": [],
    "3부": [],
  };
  for (const row of rows) {
    if (!isEngineEligibleSupportRecord(row)) continue;
    if (!isSpecialSupportShift(row.shift)) continue;
    out[row.shift].push(row);
  }
  for (const shift of SHIFT_PARTS) {
    out[shift].sort(
      (a, b) =>
        (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
        (a.id || 0) - (b.id || 0)
    );
  }
  return out;
}

/** UI byShift 레코드를 엔진 보충 큐로 변환. blocked 행은 제외. */
export function engineQueuesFromSupportRecords(
  byShift:
    | Partial<Record<ShiftPart, readonly SpecialSupportRecord[]>>
    | null
    | undefined
): Record<ShiftPart, AutoAssignCaddy[]> {
  // 기존 SPECIAL_SUPPORT + 단일부만. 새 유형/1·2/54는 엔진에 넣지 않는다.
  const next = emptySpecialSupportByShift();
  for (const part of SHIFT_PARTS) {
    next[part] = (byShift?.[part] || [])
      .filter((row) => !row.blocked && isEngineEligibleSupportRecord(row))
      .map((row) => ({
        id: row.caddyId,
        name: row.name || "",
        team: row.team || "",
        teamOrder: Number(row.teamOrder) || 0,
        inputOrder: Number(row.sortOrder) || 0,
        supportKind: resolveSupportKind(row),
        supportWorkPattern: resolveSupportWorkPattern(row),
      }));
  }
  return next;
}

export function uniqueCaddyIds(ids: readonly unknown[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type SpecialSupportShiftEntry = {
  caddyId: number;
  shift: ShiftPart;
};

export function specialSupportPlacementEntries(
  assignments:
    | ReadonlyArray<{ kind?: string; shift?: string; caddy?: { id?: number } }>
    | null
    | undefined
): SpecialSupportShiftEntry[] {
  const out: SpecialSupportShiftEntry[] = [];
  const seen = new Set<string>();
  for (const row of assignments || []) {
    if (row.kind !== "specialSupport") continue;
    if (!isSpecialSupportShift(row.shift)) continue;
    const caddyId = Number(row.caddy?.id);
    if (!Number.isInteger(caddyId) || caddyId < 1) continue;
    const key = `${caddyId}:${row.shift}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ caddyId, shift: row.shift });
  }
  return out.sort((a, b) =>
    a.shift === b.shift ? a.caddyId - b.caddyId : a.shift.localeCompare(b.shift)
  );
}

export function specialSupportQueueEntries(
  byShift:
    | Partial<Record<ShiftPart, ReadonlyArray<{ id?: number }>>>
    | null
    | undefined
): SpecialSupportShiftEntry[] {
  const out: SpecialSupportShiftEntry[] = [];
  const seen = new Set<string>();
  for (const shift of SHIFT_PARTS) {
    for (const caddy of byShift?.[shift] || []) {
      const caddyId = Number(caddy?.id);
      if (!Number.isInteger(caddyId) || caddyId < 1) continue;
      const key = `${caddyId}:${shift}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ caddyId, shift });
    }
  }
  return out.sort((a, b) =>
    a.shift === b.shift ? a.caddyId - b.caddyId : a.shift.localeCompare(b.shift)
  );
}

function supportEntryKey(row: SpecialSupportShiftEntry): string {
  return `${row.caddyId}:${row.shift}`;
}

export function isSpecialSupportDraftStale(
  queues:
    | Partial<Record<ShiftPart, ReadonlyArray<{ id?: number }>>>
    | null
    | undefined,
  assignments:
    | ReadonlyArray<{ kind?: string; shift?: string; caddy?: { id?: number } }>
    | null
    | undefined
): boolean {
  const settings = specialSupportQueueEntries(queues)
    .map(supportEntryKey)
    .join("|");
  const placed = specialSupportPlacementEntries(assignments)
    .map(supportEntryKey)
    .join("|");
  return settings !== placed;
}

export function isSpecialSupportStalePipelineBlock(
  type: string | undefined | null
): boolean {
  return type === "CADDY_SICK" || type === "MOVE_RESERVATION";
}
