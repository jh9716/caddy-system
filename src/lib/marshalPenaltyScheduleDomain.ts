/**
 * P3 벌당 근무일 수동 지정 — 순수 규칙 (DB I/O 없음).
 * 월 전체 순번 재계산 없이 from/to 이틀만 고친다.
 */

import { createHash } from "node:crypto";
import {
  MarshalRosterError,
  formatMarshalYmd,
  parseMarshalStartedOn,
} from "@/lib/marshalDomain";
import {
  isYmdInMonth,
  type MarshalDayKind,
  type RotationMember,
} from "@/lib/marshalRotationDomain";
import { parseOccurredOn } from "@/lib/marshalPenaltyOccurrenceDomain";

export type ScheduleSlotSnapshot = {
  id: number;
  date: string;
  shift: "AM" | "PM";
  slotIndex: number;
  caddyId: number;
  profileId: number;
  source: string;
  originalCaddyId: number | null;
  note: string | null;
};

export type ScheduleSlotPatch = {
  id: number;
  caddyId: number;
  profileId: number;
  source: "ROTATION" | "PENALTY";
  originalCaddyId: number | null;
  note: string | null;
};

export function parsePinnedOn(value: unknown): string {
  try {
    return formatMarshalYmd(parseMarshalStartedOn(value));
  } catch {
    try {
      return formatMarshalYmd(parseOccurredOn(value));
    } catch {
      throw new MarshalRosterError(
        "지정일은 YYYY-MM-DD 이어야 합니다.",
        "invalid_pinned_on",
        400
      );
    }
  }
}

export function scheduleSourceOf(pinnedOn: string | Date | null | undefined): "AUTO" | "MANUAL" {
  return pinnedOn ? "MANUAL" : "AUTO";
}

export function assertPinnedDateInTargetMonth(input: {
  date: string;
  year: number;
  month: number;
}): void {
  if (!isYmdInMonth(input.date, input.year, input.month)) {
    throw new MarshalRosterError(
      "지정일이 대상 월 범위를 벗어납니다.",
      "date_out_of_month",
      400
    );
  }
}

export function assertScheduleTargetMutable(planStatus?: string | null): void {
  if (planStatus === "FINALIZED") {
    throw new MarshalRosterError(
      "FINALIZED 월표의 벌당 날짜는 변경할 수 없습니다.",
      "finalized_locked",
      409
    );
  }
}

export function assertPinnedDateStatus(input: {
  kind?: MarshalDayKind | null;
  message?: string | null;
  confirmOff?: boolean;
}): { offWarning: boolean } {
  if (input.kind === "hard_skip") {
    throw new MarshalRosterError(
      input.message
        ? `${input.message} 날짜는 지정할 수 없습니다.`
        : "병가/장기병가 날짜는 지정할 수 없습니다.",
      "sick_date",
      409
    );
  }
  if (input.kind === "off_conflict") {
    if (!input.confirmOff) {
      throw new MarshalRosterError(
        "휴무일입니다. confirmOff=true 로 승인해야 합니다.",
        "off_confirm_required",
        409
      );
    }
    return { offWarning: true };
  }
  return { offWarning: false };
}

export function assertOccurrenceDayFree(input: {
  date: string;
  movingId: number;
  occupied: readonly { id: number; date: string | null }[];
}): void {
  const clash = input.occupied.find(
    (row) => row.id !== input.movingId && row.date === input.date
  );
  if (clash) {
    throw new MarshalRosterError(
      "같은 날짜에 다른 벌당이 있습니다.",
      "date_taken",
      409
    );
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function makeSchedulePreviewToken(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(payload)))
    .digest("hex");
}

export function assertPreviewToken(expected: unknown, actual: string): void {
  const token = String(expected ?? "").trim();
  if (!token) {
    throw new MarshalRosterError(
      "previewToken이 필요합니다.",
      "preview_token_required",
      400
    );
  }
  if (token !== actual) {
    throw new MarshalRosterError(
      "월표가 미리보기 이후 변경되었습니다. 다시 미리보기하세요.",
      "stale_preview",
      409
    );
  }
}

function rotationLane(
  slots: readonly ScheduleSlotSnapshot[],
  shift: "AM" | "PM"
): ScheduleSlotSnapshot | undefined {
  return [...slots]
    .filter((slot) => slot.shift === shift && slot.source === "ROTATION")
    .sort((a, b) => a.slotIndex - b.slotIndex)[0];
}

function penaltyPair(
  slots: readonly ScheduleSlotSnapshot[],
  caddyId: number
): { am: ScheduleSlotSnapshot; pm: ScheduleSlotSnapshot } | null {
  const mine = slots.filter(
    (slot) => slot.caddyId === caddyId && slot.source === "PENALTY"
  );
  const am = mine.find((slot) => slot.shift === "AM");
  const pm = mine.find((slot) => slot.shift === "PM");
  if (!am || !pm) return null;
  return { am, pm };
}

function pickFillers(input: {
  members: readonly RotationMember[];
  busyCaddyIds: ReadonlySet<number>;
  monthCounts: ReadonlyMap<number, number>;
  count: number;
}): RotationMember[] {
  const pool = input.members
    .filter((row) => !input.busyCaddyIds.has(row.caddyId))
    .sort((a, b) => {
      const ca = input.monthCounts.get(a.caddyId) ?? 0;
      const cb = input.monthCounts.get(b.caddyId) ?? 0;
      if (ca !== cb) return ca - cb;
      if (a.rotationOrder !== b.rotationOrder) return a.rotationOrder - b.rotationOrder;
      return a.caddyId - b.caddyId;
    });
  if (pool.length < input.count) {
    throw new MarshalRosterError(
      "비운 날을 채울 마샬이 부족합니다.",
      "insufficient_marshals",
      409
    );
  }
  return pool.slice(0, input.count);
}

/**
 * from/to 이틀의 슬롯만 고친다. 다른 날·다른 벌당·MANUAL/SUBSTITUTE는 그대로.
 * 월 전체 generateMonthRotation 을 돌리지 않는다.
 */
export function planLocalFullDayMove(input: {
  fromDate: string | null;
  toDate: string;
  moving: { caddyId: number; profileId: number };
  fromSlots: readonly ScheduleSlotSnapshot[];
  toSlots: readonly ScheduleSlotSnapshot[];
  members: readonly RotationMember[];
  monthCounts: ReadonlyMap<number, number>;
  offWarning?: boolean;
}): {
  fromUpdates: ScheduleSlotPatch[];
  toUpdates: ScheduleSlotPatch[];
  displacedRotation: { caddyId: number; shift: string; slotIndex: number }[];
  fillers: { caddyId: number; shift: string; slotIndex: number }[];
} {
  if (input.fromDate === input.toDate) {
    return { fromUpdates: [], toUpdates: [], displacedRotation: [], fillers: [] };
  }
  if (input.toSlots.some((slot) => slot.source === "PENALTY")) {
    throw new MarshalRosterError(
      "같은 날짜에 다른 벌당이 있습니다.",
      "date_taken",
      409
    );
  }
  if (input.toSlots.some((slot) => slot.caddyId === input.moving.caddyId)) {
    throw new MarshalRosterError(
      "같은 날 이미 배정된 마샬입니다.",
      "same_day_duplicate",
      409
    );
  }
  const toAm = rotationLane(input.toSlots, "AM");
  const toPm = rotationLane(input.toSlots, "PM");
  if (!toAm || !toPm) {
    throw new MarshalRosterError(
      "대타/수동 슬롯을 지우지 않고는 그 날에 전일 벌당을 넣을 수 없습니다.",
      "override_conflict",
      409
    );
  }
  const note = input.offWarning ? "휴무 충돌" : null;
  const toUpdates: ScheduleSlotPatch[] = [toAm, toPm].map((slot) => ({
    id: slot.id,
    caddyId: input.moving.caddyId,
    profileId: input.moving.profileId,
    source: "PENALTY" as const,
    originalCaddyId: null,
    note,
  }));
  const displacedRotation = [toAm, toPm].map((slot) => ({
    caddyId: slot.caddyId,
    shift: slot.shift,
    slotIndex: slot.slotIndex,
  }));

  const fromUpdates: ScheduleSlotPatch[] = [];
  const fillers: { caddyId: number; shift: string; slotIndex: number }[] = [];
  if (input.fromDate) {
    const pair = penaltyPair(input.fromSlots, input.moving.caddyId);
    if (!pair) {
      throw new MarshalRosterError(
        "전일 벌당 조출/후출 쌍이 없어 날짜를 옮길 수 없습니다. 다시 생성하세요.",
        "regeneration_required",
        409
      );
    }
    const remainingBusy = new Set(
      input.fromSlots
        .filter((slot) => slot.id !== pair.am.id && slot.id !== pair.pm.id)
        .map((slot) => slot.caddyId)
    );
    remainingBusy.add(input.moving.caddyId);
    remainingBusy.add(toAm.caddyId);
    remainingBusy.add(toPm.caddyId);
    const picked = pickFillers({
      members: input.members,
      busyCaddyIds: remainingBusy,
      monthCounts: input.monthCounts,
      count: 2,
    });
    const fromPair = [pair.am, pair.pm];
    fromPair.forEach((slot, i) => {
      const filler = picked[i];
      fromUpdates.push({
        id: slot.id,
        caddyId: filler.caddyId,
        profileId: filler.profileId,
        source: "ROTATION",
        originalCaddyId: null,
        note: null,
      });
      fillers.push({
        caddyId: filler.caddyId,
        shift: slot.shift,
        slotIndex: slot.slotIndex,
      });
    });
  }

  return { fromUpdates, toUpdates, displacedRotation, fillers };
}
