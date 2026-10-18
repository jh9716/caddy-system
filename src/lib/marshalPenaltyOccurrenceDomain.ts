/**
 * P2 벌당 발생 기록 → 다음 달 FULL_DAY 배정. DB I/O 없음.
 * generateMonthRotation / P1 FULL_DAY 점유 규칙을 재사용한다.
 */

import {
  MarshalRosterError,
  formatMarshalYmd,
  parseMarshalStartedOn,
} from "@/lib/marshalDomain";
import {
  penaltyShiftOccupancy,
  type DayPenaltyInput,
  type MarshalDayKind,
} from "@/lib/marshalRotationDomain";

export type PenaltyOccurrenceStatus = "OPEN" | "SCHEDULED" | "CANCELLED";

export type PenaltyOccurrenceRecord = {
  id: number;
  caddyId: number;
  profileId: number;
  occurredOn: string;
  targetYear: number;
  targetMonth: number;
  status: PenaltyOccurrenceStatus;
};

export type OccurrenceAssignment = {
  id: number;
  caddyId: number;
  profileId: number;
  date: string;
  pinned: boolean;
};

export type OccurrenceScheduleSource = "AUTO" | "MANUAL";

export type OccurrenceLeftover = {
  id: number;
  deferReason: string;
};

export function nextYearMonth(year: number, month: number): {
  year: number;
  month: number;
} {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

export function targetMonthFromOccurredOn(occurredOn: Date): {
  year: number;
  month: number;
} {
  const ymd = formatMarshalYmd(occurredOn);
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  return nextYearMonth(year, month);
}

export function parseOccurredOn(value: unknown): Date {
  try {
    return parseMarshalStartedOn(value);
  } catch {
    throw new MarshalRosterError(
      "발생일은 YYYY-MM-DD 이어야 합니다.",
      "invalid_occurred_on",
      400
    );
  }
}

export const POST_GENERATE_OPEN_DEFER_REASON =
  "월표 생성 이후 등록되어 재생성이 필요합니다.";

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeOccurrenceReason(value: unknown): string {
  const reason = String(value ?? "").trim();
  if (!reason) {
    throw new MarshalRosterError("벌당 사유가 필요합니다.", "reason_required", 400);
  }
  return reason;
}

export function normalizeOccurrenceNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const note = String(value).trim();
  return note === "" ? null : note;
}

export function idempotencyPayloadMatches(input: {
  existing: {
    caddyId: number;
    occurredOn: string;
    reason: string;
    note: string | null;
  };
  caddyId: number;
  occurredOn: string;
  reason: string;
  note: string | null;
}): boolean {
  return (
    input.existing.caddyId === input.caddyId &&
    input.existing.occurredOn === input.occurredOn &&
    input.existing.reason === input.reason &&
    (input.existing.note ?? null) === (input.note ?? null)
  );
}

export function assertIdempotencyReplay(input: {
  existing: {
    caddyId: number;
    occurredOn: string;
    reason: string;
    note: string | null;
  };
  caddyId: number;
  occurredOn: string;
  reason: string;
  note: string | null;
}): void {
  if (!idempotencyPayloadMatches(input)) {
    throw new MarshalRosterError(
      "같은 idempotencyKey가 다른 벌당에 사용되었습니다.",
      "idempotency_conflict",
      409
    );
  }
}

/** 생략/빈값 = 별건 발생. 같은 키 재전송만 동일 건으로 본다. */
export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const key = String(value).trim();
  if (!key) return null;
  if (!IDEMPOTENCY_RE.test(key)) {
    throw new MarshalRosterError(
      "idempotencyKey 형식이 올바르지 않습니다.",
      "invalid_idempotency_key",
      400
    );
  }
  return key;
}

export function sortOccurrencesForSchedule<T extends { occurredOn: string; id: number }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((a, b) => {
    if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? -1 : 1;
    return a.id - b.id;
  });
}

export function occurrenceToFullDayPenalty(input: {
  caddyId: number;
  profileId: number;
}): DayPenaltyInput {
  return {
    caddyId: input.caddyId,
    profileId: input.profileId,
    shift: "AM",
    coverage: "FULL_DAY",
  };
}

function dayOccupancy(
  date: string,
  existingByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>
): { am: number; pm: number } {
  return penaltyShiftOccupancy(existingByDate.get(date) || []);
}

function dayTakenCaddies(
  date: string,
  existingByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>
): Set<number> {
  return new Set((existingByDate.get(date) || []).map((row) => row.caddyId));
}

function tryPlaceOccurrence(input: {
  date: string;
  occurrence: { id: number; caddyId: number; profileId: number };
  pinned: boolean;
  amSlots: number;
  pmSlots: number;
  occupancy: Map<string, { am: number; pm: number }>;
  taken: Map<string, Set<number>>;
  assignedDates: Set<string>;
  existingByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>;
  statusByDateCaddy: ReadonlyMap<string, { kind: MarshalDayKind; message: string | null }>;
}): { ok: true } | { ok: false; reason: string } {
  const status = input.statusByDateCaddy.get(
    `${input.date}:${input.occurrence.caddyId}`
  );
  if (status?.kind === "hard_skip") {
    return {
      ok: false,
      reason: status.message
        ? `${status.message} 날짜는 건너뜁니다.`
        : "병가/장기병가 날짜는 건너뜁니다.",
    };
  }
  if ((input.existingByDate.get(input.date) || []).length > 0) {
    return { ok: false, reason: "이미 수동 벌당이 있는 날입니다." };
  }
  if (input.assignedDates.has(input.date)) {
    return { ok: false, reason: "같은 날 이미 벌당이 있습니다." };
  }
  const cap = input.occupancy.get(input.date);
  const dayTaken = input.taken.get(input.date);
  if (!cap || !dayTaken) {
    return { ok: false, reason: "대상 월 범위를 벗어난 날짜입니다." };
  }
  if (dayTaken.has(input.occurrence.caddyId)) {
    return { ok: false, reason: "같은 날 이미 벌당이 있습니다." };
  }
  if (cap.am + 1 > input.amSlots || cap.pm + 1 > input.pmSlots) {
    return { ok: false, reason: "하루 벌당 정원을 초과합니다." };
  }
  cap.am += 1;
  cap.pm += 1;
  dayTaken.add(input.occurrence.caddyId);
  input.assignedDates.add(input.date);
  return { ok: true };
}

/**
 * 발생 순서대로 1일부터 FULL_DAY 배정. 하루 발생 벌당은 1명.
 * 후출 정원 2여도 A·B를 같은 날에 넣지 않는다.
 * 앞선 건이 병가로 밀리면 다음 건도 그 날짜 이후로만 본다(순서 보존).
 * 수동 PenaltyDuty가 있는 날은 건너뛴다.
 * pinnedOn(MANUAL)은 그 날짜에 먼저 고정한다.
 * autoHeldOn(최초 AUTO 배정일)은 leftover 여도 그 날짜를 유지하고 다른 날로 당기지 않는다.
 * pinnedOn이 없는 신규 OPEN만 빈 날을 채운다.
 * 못 넣은 건 삭제하지 않고 leftover + deferReason.
 */
export function scheduleOccurrencesForMonth(input: {
  dates: readonly string[];
  amSlots: number;
  pmSlots: number;
  occurrences: readonly {
    id: number;
    caddyId: number;
    profileId: number;
    occurredOn: string;
    pinnedOn?: string | null;
    /** 최초 AUTO 배정일. 재생성·leftover 뒤에도 다른 날로 당기지 않는다. */
    autoHeldOn?: string | null;
  }[];
  existingByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>;
  statusByDateCaddy: ReadonlyMap<string, { kind: MarshalDayKind; message: string | null }>;
}): {
  assignments: OccurrenceAssignment[];
  leftover: OccurrenceLeftover[];
} {
  const occupancy = new Map<string, { am: number; pm: number }>();
  const taken = new Map<string, Set<number>>();
  for (const date of input.dates) {
    occupancy.set(date, { ...dayOccupancy(date, input.existingByDate) });
    taken.set(date, dayTakenCaddies(date, input.existingByDate));
  }

  const assignments: OccurrenceAssignment[] = [];
  const leftover: OccurrenceLeftover[] = [];
  const assignedDates = new Set<string>();
  const placeCtx = {
    amSlots: input.amSlots,
    pmSlots: input.pmSlots,
    occupancy,
    taken,
    assignedDates,
    existingByDate: input.existingByDate,
    statusByDateCaddy: input.statusByDateCaddy,
  };

  const pinned = sortOccurrencesForSchedule(
    input.occurrences.filter((row) => Boolean(row.pinnedOn))
  );
  for (const occurrence of pinned) {
    const date = occurrence.pinnedOn as string;
    const placed = tryPlaceOccurrence({
      ...placeCtx,
      date,
      occurrence,
      pinned: true,
    });
    if (!placed.ok) {
      leftover.push({ id: occurrence.id, deferReason: placed.reason });
      continue;
    }
    assignments.push({
      id: occurrence.id,
      caddyId: occurrence.caddyId,
      profileId: occurrence.profileId,
      date,
      pinned: true,
    });
  }

  const held = sortOccurrencesForSchedule(
    input.occurrences.filter((row) => !row.pinnedOn && Boolean(row.autoHeldOn))
  );
  for (const occurrence of held) {
    const date = occurrence.autoHeldOn as string;
    const placed = tryPlaceOccurrence({
      ...placeCtx,
      date,
      occurrence,
      pinned: false,
    });
    if (!placed.ok) {
      leftover.push({ id: occurrence.id, deferReason: placed.reason });
      continue;
    }
    assignments.push({
      id: occurrence.id,
      caddyId: occurrence.caddyId,
      profileId: occurrence.profileId,
      date,
      pinned: false,
    });
  }

  const autos = sortOccurrencesForSchedule(
    input.occurrences.filter((row) => !row.pinnedOn && !row.autoHeldOn)
  );
  let startIndex = 0;
  for (const occurrence of autos) {
    let placed = false;
    let lastReason = "배정할 날짜가 없습니다.";
    for (let i = startIndex; i < input.dates.length; i += 1) {
      const date = input.dates[i];
      const result = tryPlaceOccurrence({
        ...placeCtx,
        date,
        occurrence,
        pinned: false,
      });
      if (!result.ok) {
        lastReason = result.reason;
        continue;
      }
      assignments.push({
        id: occurrence.id,
        caddyId: occurrence.caddyId,
        profileId: occurrence.profileId,
        date,
        pinned: false,
      });
      startIndex = i + 1;
      placed = true;
      break;
    }
    if (!placed) {
      leftover.push({ id: occurrence.id, deferReason: lastReason });
    }
  }

  return { assignments, leftover };
}

export function mergeAssignedOccurrences(
  existingByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>,
  assignments: readonly OccurrenceAssignment[]
): Map<string, DayPenaltyInput[]> {
  const out = new Map<string, DayPenaltyInput[]>();
  for (const [date, rows] of existingByDate) {
    out.set(date, [...rows]);
  }
  for (const row of assignments) {
    const list = out.get(row.date) || [];
    list.push(occurrenceToFullDayPenalty(row));
    out.set(row.date, list);
  }
  return out;
}

export function assertOccurrenceCancellable(input: {
  status: string;
  planStatus?: string | null;
}): void {
  if (input.status === "CANCELLED") {
    throw new MarshalRosterError(
      "이미 취소된 벌당입니다.",
      "occurrence_cancelled",
      409
    );
  }
  if (input.status === "SCHEDULED" && input.planStatus === "FINALIZED") {
    throw new MarshalRosterError(
      "FINALIZED 월표에 배정된 벌당은 취소할 수 없습니다.",
      "finalized_locked",
      409
    );
  }
}

export function assertOccurrenceTargetMutable(planStatus?: string | null): void {
  if (planStatus === "FINALIZED") {
    throw new MarshalRosterError(
      "FINALIZED 월에는 벌당 발생을 등록할 수 없습니다.",
      "finalized_locked",
      409
    );
  }
}

function regenerationRequired(message: string): never {
  throw new MarshalRosterError(message, "regeneration_required", 409);
}

/**
 * FINALIZE 직전: 취소된 발생 벌당 슬롯이 남아 있으면 확정하지 않는다.
 * 자동 재생성은 수동/대타를 지우므로, 재생성 필요 플래그 + 슬롯/발생 일치만 검사한다.
 */
export function assertPlanReadyToFinalize(input: {
  needsRegeneration: boolean;
  postGenerateOpenCount?: number;
  generatedAt: Date | string | null;
  slotCount: number;
  penaltySlots: readonly {
    date: string;
    caddyId: number;
    shift: string;
    source: string;
  }[];
  duties: readonly { date: string; caddyId: number }[];
  scheduledOccurrences: readonly {
    date: string;
    caddyId: number;
  }[];
}): void {
  if (!input.generatedAt || input.slotCount === 0) {
    throw new MarshalRosterError(
      "생성되지 않은 월표는 마감할 수 없습니다.",
      "not_generated",
      400
    );
  }
  if (input.needsRegeneration) {
    regenerationRequired("벌당이 변경되어 월표를 다시 생성해야 합니다.");
  }
  if ((input.postGenerateOpenCount ?? 0) > 0) {
    regenerationRequired(
      "월표 생성 이후 등록된 벌당이 있어 다시 생성해야 합니다."
    );
  }
  const dutyKeys = new Set(input.duties.map((row) => `${row.date}:${row.caddyId}`));
  const scheduledKeys = new Set(
    input.scheduledOccurrences.map((row) => `${row.date}:${row.caddyId}`)
  );
  const shiftsByKey = new Map<string, Set<string>>();
  for (const slot of input.penaltySlots) {
    if (slot.source !== "PENALTY") continue;
    const key = `${slot.date}:${slot.caddyId}`;
    const shifts = shiftsByKey.get(key) || new Set<string>();
    shifts.add(slot.shift);
    shiftsByKey.set(key, shifts);
  }
  for (const occ of input.scheduledOccurrences) {
    const shifts = shiftsByKey.get(`${occ.date}:${occ.caddyId}`);
    if (!shifts?.has("AM") || !shifts?.has("PM")) {
      regenerationRequired(
        "배정된 전일 벌당의 조출/후출 쌍이 월표와 일치하지 않습니다. 다시 생성하세요."
      );
    }
  }
  for (const [key, shifts] of shiftsByKey) {
    if (dutyKeys.has(key)) continue;
    if (scheduledKeys.has(key)) {
      if (!shifts.has("AM") || !shifts.has("PM")) {
        regenerationRequired(
          "배정된 전일 벌당의 조출/후출 쌍이 월표와 일치하지 않습니다. 다시 생성하세요."
        );
      }
      continue;
    }
    regenerationRequired(
      "취소된 벌당 슬롯이 월표에 남아 있습니다. 다시 생성하세요."
    );
  }
}
