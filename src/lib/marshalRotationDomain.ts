/**
 * 마샬 월 순환 스케줄러 — 순수 함수 (DB I/O 없음).
 * fairness random 이 아니라 rotation cursor 를 이어서 돌린다.
 * DailyOpsDuty / autoAssignEngine 투영은 여기 없다.
 */

import { isInactiveEmploymentAvailability } from "@/lib/availabilityEngine";
import { resolveEffectiveOff } from "@/lib/offEffective";
import {
  DEFAULT_AM_SLOTS_PER_DAY,
  DEFAULT_PM_SLOTS_PER_DAY,
  MarshalRosterError,
  formatMarshalYmd,
  isMarshalYmd,
} from "@/lib/marshalDomain";

export const MARSHAL_HARD_SKIP_ASSIGNMENT_TYPES = [
  "SICK",
  "LONG_SICK",
] as const;

export type MarshalShiftKind = "AM" | "PM";
export type MarshalSlotSourceKind =
  | "ROTATION"
  | "MANUAL"
  | "SUBSTITUTE"
  | "PENALTY";

export type MarshalDayKind = "ok" | "off_conflict" | "hard_skip";

export type RotationMember = {
  profileId: number;
  caddyId: number;
  rotationOrder: number;
  name: string;
  employmentStatus: string;
};

export type DayPenaltyInput = {
  caddyId: number;
  profileId: number;
  shift: MarshalShiftKind;
};

export type OpenCredit = {
  id: number;
  profileId: number;
};

export type GeneratedSlot = {
  date: string;
  shift: MarshalShiftKind;
  slotIndex: number;
  caddyId: number;
  profileId: number;
  source: MarshalSlotSourceKind;
  warning: string | null;
};

export type ConsumedCredit = {
  creditId: number;
  profileId: number;
  date: string;
};

export type DayWarning = {
  date: string;
  caddyId: number;
  kind: "off_conflict" | "hard_skip";
  message: string;
};

export type MonthGenerateResult = {
  startRotationOrder: number;
  nextRotationOrder: number;
  slots: GeneratedSlot[];
  consumedCredits: ConsumedCredit[];
  warnings: DayWarning[];
};

export function parseYearMonth(year: unknown, month: unknown): {
  year: number;
  month: number;
} {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new MarshalRosterError("연도가 올바르지 않습니다.", "invalid_year", 400);
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new MarshalRosterError("월이 올바르지 않습니다.", "invalid_month", 400);
  }
  return { year: y, month: m };
}

export function parseSlotsPerDay(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 8) {
    throw new MarshalRosterError(
      `${field}는 0~8 정수여야 합니다.`,
      "invalid_slots_per_day",
      400
    );
  }
  return n;
}

export function parseMarshalShift(value: unknown): MarshalShiftKind {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === "AM" || v === "조출") return "AM";
  if (v === "PM" || v === "후출") return "PM";
  throw new MarshalRosterError("shift는 AM 또는 PM 이어야 합니다.", "invalid_shift", 400);
}

export function listMonthYmds(year: number, month: number): string[] {
  const last = new Date(year, month, 0).getDate();
  const out: string[] = [];
  for (let day = 1; day <= last; day++) {
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    out.push(`${year}-${mm}-${dd}`);
  }
  return out;
}

export function previousYearMonth(year: number, month: number): {
  year: number;
  month: number;
} {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

export function classifyMarshalDayStatus(input: {
  employmentStatus: string;
  overlappingTypes: readonly string[];
  isEffectiveOff: boolean;
}): { kind: MarshalDayKind; message: string | null } {
  if (isInactiveEmploymentAvailability({ employmentStatus: input.employmentStatus })) {
    return {
      kind: "hard_skip",
      message: `재직상태 ${input.employmentStatus}`,
    };
  }
  const types = input.overlappingTypes.map((t) => String(t).toUpperCase());
  if (types.includes("LONG_SICK")) {
    return { kind: "hard_skip", message: "장기병가" };
  }
  if (types.includes("SICK")) {
    return { kind: "hard_skip", message: "병가" };
  }
  if (input.isEffectiveOff || types.includes("OFF")) {
    return { kind: "off_conflict", message: "휴무 충돌" };
  }
  return { kind: "ok", message: null };
}

export function effectiveOffForDay(input: {
  offCaddyIds: readonly number[];
  overrides?: readonly { caddyId: number; action: string }[] | null;
}): Set<number> {
  const result = resolveEffectiveOff({
    baseOffCaddyIds: input.offCaddyIds,
    overrides: (input.overrides || [])
      .filter((row) => row.action === "FORCE_OFF" || row.action === "FORCE_AVAILABLE")
      .map((row) => ({
        caddyId: row.caddyId,
        action: row.action as "FORCE_OFF" | "FORCE_AVAILABLE",
      })),
  });
  return new Set(result.offCaddyIds);
}

export function orderedActiveMembers(
  rows: readonly RotationMember[]
): RotationMember[] {
  const missing = rows.filter((row) => !Number.isInteger(row.rotationOrder) || row.rotationOrder < 1);
  if (missing.length > 0) {
    throw new MarshalRosterError(
      "활성 마샬에 순번이 없습니다. 명단에서 순번을 지정하세요.",
      "rotation_order_required",
      400
    );
  }
  const seen = new Map<number, number>();
  for (const row of rows) {
    const prev = seen.get(row.rotationOrder);
    if (prev != null && prev !== row.profileId) {
      throw new MarshalRosterError(
        `활성 마샬 순번 ${row.rotationOrder}이(가) 중복됩니다.`,
        "duplicate_rotation_order",
        409
      );
    }
    seen.set(row.rotationOrder, row.profileId);
  }
  return [...rows].sort((a, b) => {
    if (a.rotationOrder !== b.rotationOrder) return a.rotationOrder - b.rotationOrder;
    return a.profileId - b.profileId;
  });
}

export function findStartIndex(
  members: readonly RotationMember[],
  startRotationOrder: number
): number {
  if (members.length === 0) {
    throw new MarshalRosterError(
      "순번이 있는 활성 마샬이 없습니다.",
      "no_active_marshals",
      400
    );
  }
  const exact = members.findIndex((m) => m.rotationOrder === startRotationOrder);
  if (exact >= 0) return exact;
  const next = members.findIndex((m) => m.rotationOrder > startRotationOrder);
  return next >= 0 ? next : 0;
}

export function nextCursorOrder(
  members: readonly RotationMember[],
  index: number
): number {
  if (members.length === 0) {
    throw new MarshalRosterError(
      "순번이 있는 활성 마샬이 없습니다.",
      "no_active_marshals",
      400
    );
  }
  const wrapped = ((index % members.length) + members.length) % members.length;
  return members[wrapped].rotationOrder;
}

type ShiftCounts = { am: number; pm: number };

function countKey(counts: Map<number, ShiftCounts>, caddyId: number): ShiftCounts {
  const cur = counts.get(caddyId);
  if (cur) return cur;
  const fresh = { am: 0, pm: 0 };
  counts.set(caddyId, fresh);
  return fresh;
}

export function balanceDayShifts(input: {
  date: string;
  amSlots: number;
  pmSlots: number;
  rotationPicks: readonly RotationMember[];
  penalties: readonly DayPenaltyInput[];
  dayKindByCaddy: ReadonlyMap<number, { kind: MarshalDayKind; message: string | null }>;
  counts: Map<number, ShiftCounts>;
}): GeneratedSlot[] {
  const amNeed = input.amSlots;
  const pmNeed = input.pmSlots;
  const taken = new Set<number>();
  const am: Array<GeneratedSlot | null> = Array.from({ length: amNeed }, () => null);
  const pm: Array<GeneratedSlot | null> = Array.from({ length: pmNeed }, () => null);

  const warningOf = (caddyId: number): string | null => {
    const status = input.dayKindByCaddy.get(caddyId);
    return status?.kind === "off_conflict" ? status.message : null;
  };

  for (const penalty of input.penalties) {
    if (taken.has(penalty.caddyId)) {
      throw new MarshalRosterError(
        `${input.date}: 같은 날 중복 배정 (${penalty.caddyId})`,
        "same_day_duplicate",
        400
      );
    }
    const row: GeneratedSlot = {
      date: input.date,
      shift: penalty.shift,
      slotIndex: 0,
      caddyId: penalty.caddyId,
      profileId: penalty.profileId,
      source: "PENALTY",
      warning: warningOf(penalty.caddyId),
    };
    const lane = penalty.shift === "AM" ? am : pm;
    const empty = lane.findIndex((slot) => slot == null);
    if (empty < 0) {
      throw new MarshalRosterError(
        `${input.date}: ${penalty.shift} 슬롯보다 벌당이 많습니다.`,
        "penalty_overflow",
        400
      );
    }
    row.slotIndex = empty;
    lane[empty] = row;
    taken.add(penalty.caddyId);
  }

  const remaining = input.rotationPicks.filter((m) => !taken.has(m.caddyId));
  const fill = (lane: Array<GeneratedSlot | null>, shift: MarshalShiftKind) => {
    const empties = lane
      .map((slot, idx) => (slot == null ? idx : -1))
      .filter((idx) => idx >= 0);
    if (empties.length === 0) return;
    const pool = remaining.filter((m) => !taken.has(m.caddyId));
    pool.sort((a, b) => {
      const ca = countKey(input.counts, a.caddyId);
      const cb = countKey(input.counts, b.caddyId);
      const aPrimary = shift === "AM" ? ca.am : ca.pm;
      const bPrimary = shift === "AM" ? cb.am : cb.pm;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      const aOther = shift === "AM" ? ca.pm : ca.am;
      const bOther = shift === "AM" ? cb.pm : cb.am;
      if (aOther !== bOther) return bOther - aOther;
      if (a.rotationOrder !== b.rotationOrder) return a.rotationOrder - b.rotationOrder;
      return a.caddyId - b.caddyId;
    });
    if (pool.length < empties.length) {
      throw new MarshalRosterError(
        `${input.date}: 배정 가능한 마샬이 부족합니다.`,
        "insufficient_marshals",
        400
      );
    }
    empties.forEach((slotIndex, i) => {
      const pick = pool[i];
      taken.add(pick.caddyId);
      lane[slotIndex] = {
        date: input.date,
        shift,
        slotIndex,
        caddyId: pick.caddyId,
        profileId: pick.profileId,
        source: "ROTATION",
        warning: warningOf(pick.caddyId),
      };
    });
  };

  fill(am, "AM");
  fill(pm, "PM");

  const slots = [...am, ...pm].filter((slot): slot is GeneratedSlot => slot != null);
  if (slots.length !== amNeed + pmNeed) {
    throw new MarshalRosterError(
      `${input.date}: 슬롯을 모두 채우지 못했습니다.`,
      "insufficient_marshals",
      400
    );
  }
  const ids = slots.map((s) => s.caddyId);
  if (new Set(ids).size !== ids.length) {
    throw new MarshalRosterError(
      `${input.date}: 같은 날 중복 배정`,
      "same_day_duplicate",
      400
    );
  }
  for (const slot of slots) {
    const cur = countKey(input.counts, slot.caddyId);
    if (slot.shift === "AM") cur.am += 1;
    else cur.pm += 1;
  }
  return slots.sort((a, b) => {
    if (a.shift !== b.shift) return a.shift === "AM" ? -1 : 1;
    return a.slotIndex - b.slotIndex;
  });
}

export function generateMonthRotation(input: {
  year: number;
  month: number;
  amSlotsPerDay?: number;
  pmSlotsPerDay?: number;
  startRotationOrder: number;
  members: readonly RotationMember[];
  penaltiesByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>;
  statusByDateCaddy: ReadonlyMap<string, { kind: MarshalDayKind; message: string | null }>;
  openCredits: readonly OpenCredit[];
  dates?: readonly string[];
}): MonthGenerateResult {
  const amSlots = input.amSlotsPerDay ?? DEFAULT_AM_SLOTS_PER_DAY;
  const pmSlots = input.pmSlotsPerDay ?? DEFAULT_PM_SLOTS_PER_DAY;
  if (amSlots + pmSlots < 1) {
    throw new MarshalRosterError(
      "하루 조출/후출 합이 1 이상이어야 합니다.",
      "invalid_slots_per_day",
      400
    );
  }
  const members = orderedActiveMembers(input.members);
  if (members.length === 0) {
    throw new MarshalRosterError(
      "순번이 있는 활성 마샬이 없습니다.",
      "no_active_marshals",
      400
    );
  }
  const byProfile = new Map(members.map((m) => [m.profileId, m]));
  const creditQueue = [...input.openCredits]
    .filter((c) => byProfile.has(c.profileId))
    .sort((a, b) => a.id - b.id);
  let cursor = findStartIndex(members, input.startRotationOrder);
  const pendingTurns: RotationMember[] = [];
  const counts = new Map<number, ShiftCounts>();
  const slots: GeneratedSlot[] = [];
  const consumedCredits: ConsumedCredit[] = [];
  const warnings: DayWarning[] = [];
  const ymds = input.dates ? [...input.dates] : listMonthYmds(input.year, input.month);

  for (const date of ymds) {
    const penalties = input.penaltiesByDate.get(date) || [];
    const penaltyIds = new Set(penalties.map((p) => p.caddyId));
    const total = amSlots + pmSlots;
    const rotationNeeded = total - penalties.length;
    if (rotationNeeded < 0) {
      throw new MarshalRosterError(
        `${date}: 벌당이 하루 슬롯 수보다 많습니다.`,
        "penalty_overflow",
        400
      );
    }
    const picks: RotationMember[] = [];
    const dayDeferred: RotationMember[] = [];
    let walked = 0;
    const maxWalk = Math.max(members.length * 4, rotationNeeded * members.length + 4);
    while (picks.length < rotationNeeded) {
      walked += 1;
      if (walked > maxWalk) {
        throw new MarshalRosterError(
          `${date}: 배정 가능한 마샬이 부족합니다.`,
          "insufficient_marshals",
          400
        );
      }
      const member = pendingTurns.length
        ? pendingTurns.shift()!
        : members[(cursor++) % members.length];
      if (penaltyIds.has(member.caddyId)) {
        dayDeferred.push(member);
        continue;
      }
      if (picks.some((p) => p.caddyId === member.caddyId)) {
        continue;
      }
      const status =
        input.statusByDateCaddy.get(`${date}:${member.caddyId}`) || {
          kind: "ok" as const,
          message: null,
        };
      if (status.kind === "hard_skip") {
        warnings.push({
          date,
          caddyId: member.caddyId,
          kind: "hard_skip",
          message: status.message || "근무불가",
        });
        continue;
      }
      const creditIdx = creditQueue.findIndex(
        (c) => c.profileId === member.profileId
      );
      if (creditIdx >= 0) {
        const credit = creditQueue.splice(creditIdx, 1)[0];
        consumedCredits.push({
          creditId: credit.id,
          profileId: member.profileId,
          date,
        });
        continue;
      }
      picks.push(member);
      if (status.kind === "off_conflict") {
        warnings.push({
          date,
          caddyId: member.caddyId,
          kind: "off_conflict",
          message: status.message || "휴무 충돌",
        });
      }
    }
    pendingTurns.push(...dayDeferred);

    const dayKindByCaddy = new Map<number, { kind: MarshalDayKind; message: string | null }>();
    for (const member of [...picks, ...penalties.map((p) => byProfile.get(p.profileId)).filter(Boolean)]) {
      if (!member) continue;
      dayKindByCaddy.set(
        member.caddyId,
        input.statusByDateCaddy.get(`${date}:${member.caddyId}`) || {
          kind: "ok",
          message: null,
        }
      );
    }
    const daySlots = balanceDayShifts({
      date,
      amSlots,
      pmSlots,
      rotationPicks: picks,
      penalties,
      dayKindByCaddy,
      counts,
    });
    slots.push(...daySlots);
  }

  return {
    startRotationOrder: input.startRotationOrder,
    nextRotationOrder: nextCursorOrder(members, cursor),
    slots,
    consumedCredits,
    warnings,
  };
}

export function sourceLabel(source: string): string {
  if (source === "PENALTY") return "벌당";
  if (source === "SUBSTITUTE") return "대타";
  if (source === "MANUAL") return "수동";
  return "정상";
}

export function shiftLabel(shift: string): string {
  return shift === "PM" ? "후출" : "조출";
}

export function assertReplaceConfirmed(replace: unknown, hasDraftSlots: boolean): void {
  if (!hasDraftSlots) return;
  if (replace === true || replace === "true") return;
  throw new MarshalRosterError(
    "기존 DRAFT가 있습니다. 덮어쓰려면 replace=true 가 필요합니다.",
    "draft_exists",
    409
  );
}

export function canonicalOriginalCaddyId(slot: {
  originalCaddyId?: number | null;
  caddyId: number;
}): number {
  return slot.originalCaddyId ?? slot.caddyId;
}

export function assertSubstituteChangesCaddy(
  fromCaddyId: number,
  toCaddyId: number
): void {
  if (fromCaddyId === toCaddyId) {
    throw new MarshalRosterError(
      "같은 마샬로 대타할 수 없습니다.",
      "substitute_unchanged",
      400
    );
  }
}

export function assertSlotMatchesPlan(
  slotPlanId: number,
  requestedPlanId: number
): void {
  if (slotPlanId !== requestedPlanId) {
    throw new MarshalRosterError(
      "슬롯이 해당 월표에 없습니다.",
      "slot_plan_mismatch",
      404
    );
  }
}

export function assertPlanMutable(status: string, action: string): void {
  if (status === "FINALIZED" && action === "generate") {
    throw new MarshalRosterError(
      "FINALIZED 월표는 재생성할 수 없습니다.",
      "finalized_locked",
      409
    );
  }
}

export function isYmdInMonth(ymd: string, year: number, month: number): boolean {
  if (!isMarshalYmd(ymd)) return false;
  const d = formatMarshalYmd(ymd);
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return d.startsWith(`${prefix}-`);
}
