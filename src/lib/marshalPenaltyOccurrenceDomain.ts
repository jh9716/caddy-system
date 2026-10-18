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
};

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

/**
 * 발생 순서대로 1일부터 FULL_DAY 배정.
 * 병가/장기병가는 건너뛰고, PM/AM 정원을 넘기지 않는다.
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
  const ordered = sortOccurrencesForSchedule(input.occurrences);

  for (const occurrence of ordered) {
    let placed = false;
    let lastReason = "배정할 날짜가 없습니다.";
    for (const date of input.dates) {
      const status = input.statusByDateCaddy.get(`${date}:${occurrence.caddyId}`);
      if (status?.kind === "hard_skip") {
        lastReason = status.message
          ? `${status.message} 날짜는 건너뜁니다.`
          : "병가/장기병가 날짜는 건너뜁니다.";
        continue;
      }
      const cap = occupancy.get(date)!;
      const dayTaken = taken.get(date)!;
      if (dayTaken.has(occurrence.caddyId)) {
        lastReason = "같은 날 이미 벌당이 있습니다.";
        continue;
      }
      if (cap.am + 1 > input.amSlots || cap.pm + 1 > input.pmSlots) {
        lastReason = "하루 벌당 정원을 초과합니다.";
        continue;
      }
      cap.am += 1;
      cap.pm += 1;
      dayTaken.add(occurrence.caddyId);
      assignments.push({
        id: occurrence.id,
        caddyId: occurrence.caddyId,
        profileId: occurrence.profileId,
        date,
      });
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
