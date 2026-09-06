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
  shift: ShiftPart;
  name?: string;
  team?: string;
  teamOrder?: number;
  excludedReasons?: string[];
  blocked?: boolean;
  blockedReason?: string | null;
};

export function isSpecialSupportShift(value: unknown): value is ShiftPart {
  return SHIFT_PARTS.includes(String(value) as ShiftPart);
}

export function emptySpecialSupportByShift(): Record<ShiftPart, AutoAssignCaddy[]> {
  return { "1부": [], "2부": [], "3부": [] };
}

export function isInactiveEmployment(status: unknown): boolean {
  const raw = String(status ?? "").trim().toUpperCase();
  if (!raw) return false;
  if (raw === "ACTIVE" || raw === "재직") return false;
  return (
    raw === "LEAVE" ||
    raw === "RETIRED" ||
    raw === "휴직" ||
    raw === "퇴사" ||
    raw.includes("LEAVE") ||
    raw.includes("RETIRED")
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
  normalIds: Iterable<number>;
  usedInShift: Iterable<number>;
  unavailable?: readonly SpecialSupportUnavailable[];
}): AutoAssignCaddy[] {
  const normal = new Set([...input.normalIds].map(Number));
  const used = new Set([...input.usedInShift].map(Number));
  const unavailableById = new Map(
    (input.unavailable || []).map((row) => [row.caddyId, row])
  );
  const out: AutoAssignCaddy[] = [];
  const seen = new Set<number>();
  for (const caddy of input.queue) {
    if (!(caddy.id > 0) || seen.has(caddy.id)) continue;
    if (used.has(caddy.id) || normal.has(caddy.id)) continue;
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
    if (!isSpecialSupportShift(row.shift)) continue;
    out[row.shift].push(row);
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
  const next = emptySpecialSupportByShift();
  for (const part of SHIFT_PARTS) {
    next[part] = (byShift?.[part] || [])
      .filter((row) => !row.blocked)
      .map((row) => ({
        id: row.caddyId,
        name: row.name || "",
        team: row.team || "",
        teamOrder: Number(row.teamOrder) || 0,
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
