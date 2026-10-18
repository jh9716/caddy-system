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

export type FillerPick = {
  member: RotationMember;
  warning: string | null;
};

function remainingRotationAnchor(
  slots: readonly ScheduleSlotSnapshot[],
  excludeIds: ReadonlySet<number>
): ScheduleSlotSnapshot | null {
  const remaining = slots
    .filter((slot) => !excludeIds.has(slot.id) && slot.source === "ROTATION")
    .sort((a, b) => {
      if (a.shift !== b.shift) return a.shift === "AM" ? -1 : 1;
      return a.slotIndex - b.slotIndex;
    });
  return remaining[remaining.length - 1] ?? null;
}

/**
 * 빠진 날에 남은 ROTATION 을 기준으로 순환 순번을 이어 간다.
 * 병가/장기병가는 건너뛴다. 휴무는 P1과 같이 넣고 경고만 단다.
 * 횟수 휴리스틱으로 임의 선정하지 않는다.
 */
export function pickRotationFillers(input: {
  date: string;
  members: readonly RotationMember[];
  busyCaddyIds: ReadonlySet<number>;
  statusByDateCaddy: ReadonlyMap<
    string,
    { kind: MarshalDayKind; message: string | null }
  >;
  anchor: { caddyId: number; profileId: number } | null;
  count: number;
}): FillerPick[] {
  if (!input.anchor) {
    throw new MarshalRosterError(
      "빠진 날의 순환 기준을 알 수 없어 대체자를 정하지 않습니다. 월표를 다시 생성하세요.",
      "rotation_unresolvable",
      409
    );
  }
  const ordered = [...input.members].sort((a, b) => {
    if (a.rotationOrder !== b.rotationOrder) return a.rotationOrder - b.rotationOrder;
    return a.caddyId - b.caddyId;
  });
  if (ordered.length === 0) {
    throw new MarshalRosterError(
      "비운 날을 채울 마샬이 부족합니다.",
      "insufficient_marshals",
      409
    );
  }
  let start = ordered.findIndex(
    (row) =>
      row.profileId === input.anchor!.profileId ||
      row.caddyId === input.anchor!.caddyId
  );
  if (start < 0) start = 0;
  const picked: FillerPick[] = [];
  const seen = new Set<number>();
  for (let step = 1; step <= ordered.length * 2 && picked.length < input.count; step += 1) {
    const member = ordered[(start + step) % ordered.length];
    if (seen.has(member.caddyId)) continue;
    seen.add(member.caddyId);
    if (input.busyCaddyIds.has(member.caddyId)) continue;
    const status = input.statusByDateCaddy.get(`${input.date}:${member.caddyId}`);
    if (status?.kind === "hard_skip") continue;
    picked.push({
      member,
      warning: status?.kind === "off_conflict" ? status.message || "휴무 충돌" : null,
    });
  }
  if (picked.length < input.count) {
    throw new MarshalRosterError(
      "병가/장기병가를 제외하면 비운 날을 채울 순환 마샬이 부족합니다.",
      "insufficient_marshals",
      409
    );
  }
  return picked;
}

export function overlaySlotPatches(
  slots: readonly ScheduleSlotSnapshot[],
  patches: readonly ScheduleSlotPatch[]
): ScheduleSlotSnapshot[] {
  const byId = new Map(patches.map((row) => [row.id, row]));
  return slots.map((slot) => {
    const patch = byId.get(slot.id);
    if (!patch) return slot;
    return {
      ...slot,
      caddyId: patch.caddyId,
      profileId: patch.profileId,
      source: patch.source,
      originalCaddyId: patch.originalCaddyId,
      note: patch.note,
    };
  });
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
  statusByDateCaddy?: ReadonlyMap<
    string,
    { kind: MarshalDayKind; message: string | null }
  >;
  offWarning?: boolean;
}): {
  fromUpdates: ScheduleSlotPatch[];
  toUpdates: ScheduleSlotPatch[];
  displacedRotation: { caddyId: number; shift: string; slotIndex: number }[];
  fillers: {
    caddyId: number;
    profileId: number;
    shift: string;
    slotIndex: number;
    warning: string | null;
  }[];
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
  const fillers: {
    caddyId: number;
    profileId: number;
    shift: string;
    slotIndex: number;
    warning: string | null;
  }[] = [];
  if (input.fromDate) {
    const pair = penaltyPair(input.fromSlots, input.moving.caddyId);
    if (!pair) {
      throw new MarshalRosterError(
        "전일 벌당 조출/후출 쌍이 없어 날짜를 옮길 수 없습니다. 다시 생성하세요.",
        "regeneration_required",
        409
      );
    }
    const exclude = new Set([pair.am.id, pair.pm.id]);
    const remainingBusy = new Set(
      input.fromSlots
        .filter((slot) => !exclude.has(slot.id))
        .map((slot) => slot.caddyId)
    );
    remainingBusy.add(input.moving.caddyId);
    const anchorSlot = remainingRotationAnchor(input.fromSlots, exclude);
    const anchorMember = anchorSlot
      ? input.members.find(
          (row) =>
            row.caddyId === anchorSlot.caddyId ||
            row.profileId === anchorSlot.profileId
        )
      : null;
    const picked = pickRotationFillers({
      date: input.fromDate,
      members: input.members,
      busyCaddyIds: remainingBusy,
      statusByDateCaddy: input.statusByDateCaddy || new Map(),
      anchor: anchorMember
        ? { caddyId: anchorMember.caddyId, profileId: anchorMember.profileId }
        : null,
      count: 2,
    });
    const fromPair = [pair.am, pair.pm];
    fromPair.forEach((slot, i) => {
      const filler = picked[i];
      fromUpdates.push({
        id: slot.id,
        caddyId: filler.member.caddyId,
        profileId: filler.member.profileId,
        source: "ROTATION",
        originalCaddyId: null,
        note: filler.warning,
      });
      fillers.push({
        caddyId: filler.member.caddyId,
        profileId: filler.member.profileId,
        shift: slot.shift,
        slotIndex: slot.slotIndex,
        warning: filler.warning,
      });
    });
  }

  return { fromUpdates, toUpdates, displacedRotation, fillers };
}
