/**
 * 일자별 필요/가용 인원 V1 (표시 전용).
 * - 예약 팀 수와 필요 인원(unique caddyId)을 섞지 않는다.
 * - 현재 화면 배치가 있으면 엔진을 다시 돌리지 않는다.
 * - 배치가 없을 때만 computeAutoAssignmentsV1 dry-run (DB/draft write 없음).
 */

import { assignmentShiftOf } from "@/lib/assignmentBoardView";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
  type UnassignedReservationRow,
} from "@/lib/autoAssignEngine";
import { SHIFT_PARTS, type ShiftPart } from "@/lib/reservationParser";

export type StaffingShiftCounts = Record<ShiftPart, number>;

export type StaffingRequiredSource =
  | "current_board"
  | "engine_estimate"
  | "missing_reservations"
  | "estimate_unavailable";

export type StaffingGapKind =
  | "surplus"
  | "shortage"
  | "balanced"
  | "min_shortage"
  | "unknown";

export type DailyStaffingSummary = {
  date: string;
  reservation: {
    status: "ok" | "none";
    total: number | null;
    byShift: StaffingShiftCounts | null;
  };
  required: {
    source: StaffingRequiredSource;
    count: number | null;
    imprecise: boolean;
  };
  available: {
    status: "ok" | "none";
    count: number | null;
  };
  unassignedTeams: number;
  gap: {
    kind: StaffingGapKind;
    people: number | null;
  };
};

export type StaffingDryRunInput = {
  date: string;
  reservations: AutoAssignReservation[];
  available: AutoAssignCaddy[];
  special?: AutoAssignCaddy[];
  houseStartCaddyId?: number | null;
  thirdStartCaddyId?: number | null;
  thirdStartTeam?: string | null;
  openCourses?: readonly string[] | null;
  specialSupportByShift?: AutoAssignResultV1["specialSupportByShift"];
  oneTwoSupport?: AutoAssignCaddy[];
};

export type BuildDailyStaffingSummaryInput = {
  date: string;
  availableCount?: number | null;
  currentDraft?: AssignmentDraft | null;
  previewReservations?: readonly AutoAssignReservation[] | null;
  dryRunInput?: StaffingDryRunInput | null;
};

const SHIFT_SET = new Set<string>(SHIFT_PARTS);

export function emptyStaffingShiftCounts(): StaffingShiftCounts {
  return { "1부": 0, "2부": 0, "3부": 0 };
}

export function isStaffingShift(value: string): value is ShiftPart {
  return SHIFT_SET.has(value);
}

function isVacantStaffingCaddy(row: AutoAssignmentRow): boolean {
  const caddy = row.caddy;
  if (!caddy) return true;
  if (!Number.isInteger(caddy.id) || caddy.id <= 0) return true;
  return String(caddy.name || "").trim() === "";
}

export function hasCurrentBoardStaffingResult(
  draft: AssignmentDraft | null | undefined
): boolean {
  if (!draft) return false;
  return (
    (draft.assignments?.length || 0) > 0 ||
    (draft.unassignedReservations?.length || 0) > 0
  );
}

/** 배치 필요 = unique caddyId. 빈 칸·비정상 id는 세지 않는다. */
export function countUniqueRequiredCaddies(
  assignments: readonly AutoAssignmentRow[] | null | undefined
): number {
  const ids = new Set<number>();
  for (const row of assignments || []) {
    if (isVacantStaffingCaddy(row)) continue;
    const id = row.caddy?.id;
    if (!Number.isInteger(id) || (id as number) <= 0) continue;
    ids.add(id as number);
  }
  return ids.size;
}

export function countPlacementsByShift(
  assignments: readonly AutoAssignmentRow[] | null | undefined
): StaffingShiftCounts {
  const out = emptyStaffingShiftCounts();
  for (const row of assignments || []) {
    const shift = assignmentShiftOf(row);
    if (isStaffingShift(shift)) out[shift] += 1;
  }
  return out;
}

function addReservationShift(
  out: StaffingShiftCounts,
  shiftRaw: unknown
): void {
  const shift = String(shiftRaw || "");
  if (isStaffingShift(shift)) out[shift] += 1;
}

/** 운영 예약 팀 수 = 현재 화면 배정 행 + 미배치. 닫힌 코스는 제외. */
export function countReservationTeamsFromDraft(
  draft: Pick<AssignmentDraft, "assignments" | "unassignedReservations">
): { total: number; byShift: StaffingShiftCounts } {
  const byShift = countPlacementsByShift(draft.assignments);
  let unassigned = 0;
  for (const row of draft.unassignedReservations || []) {
    unassigned += 1;
    addReservationShift(byShift, row.reservation?.shift);
  }
  return {
    total: (draft.assignments?.length || 0) + unassigned,
    byShift,
  };
}

export function countReservationTeamsFromRows(
  reservations: readonly AutoAssignReservation[] | null | undefined
): { total: number; byShift: StaffingShiftCounts } {
  const byShift = emptyStaffingShiftCounts();
  let total = 0;
  for (const row of reservations || []) {
    total += 1;
    addReservationShift(byShift, row.shift);
  }
  return { total, byShift };
}

export function countVacantAssignmentTeams(
  assignments: readonly AutoAssignmentRow[] | null | undefined
): number {
  let n = 0;
  for (const row of assignments || []) {
    if (isVacantStaffingCaddy(row)) n += 1;
  }
  return n;
}

export function canonicalAvailableCount(input: {
  availableIds?: readonly number[] | null;
  availableCount?: number | null;
  opsDutyCaddyIds?: readonly number[] | null;
}): number | null {
  const duty = new Set<number>();
  for (const raw of input.opsDutyCaddyIds || []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) duty.add(id);
  }
  if (Array.isArray(input.availableIds)) {
    const seen = new Set<number>();
    let n = 0;
    for (const raw of input.availableIds) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0 || duty.has(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      n += 1;
    }
    return n;
  }
  if (
    typeof input.availableCount === "number" &&
    Number.isFinite(input.availableCount) &&
    input.availableCount >= 0
  ) {
    return Math.floor(input.availableCount);
  }
  return null;
}

function emptySummary(date: string): DailyStaffingSummary {
  return {
    date,
    reservation: { status: "none", total: null, byShift: null },
    required: {
      source: "missing_reservations",
      count: null,
      imprecise: false,
    },
    available: { status: "none", count: null },
    unassignedTeams: 0,
    gap: { kind: "unknown", people: null },
  };
}

function withAvailable(
  summary: DailyStaffingSummary,
  availableCount: number | null | undefined
): DailyStaffingSummary {
  if (
    typeof availableCount === "number" &&
    Number.isFinite(availableCount) &&
    availableCount >= 0
  ) {
    summary.available = {
      status: "ok",
      count: Math.floor(availableCount),
    };
  }
  return summary;
}

function applyGap(summary: DailyStaffingSummary): DailyStaffingSummary {
  const required = summary.required.count;
  const available = summary.available.count;
  if (required == null || available == null) {
    summary.gap = { kind: "unknown", people: null };
    return summary;
  }
  const raw = available - required;
  if (summary.unassignedTeams > 0) {
    if (raw < 0) {
      summary.gap = { kind: "min_shortage", people: Math.abs(raw) };
    } else {
      summary.gap = { kind: "unknown", people: null };
    }
    return summary;
  }
  if (raw > 0) summary.gap = { kind: "surplus", people: raw };
  else if (raw < 0) summary.gap = { kind: "shortage", people: Math.abs(raw) };
  else summary.gap = { kind: "balanced", people: 0 };
  return summary;
}

function fromPlacements(input: {
  date: string;
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  source: "current_board" | "engine_estimate";
  availableCount?: number | null;
}): DailyStaffingSummary {
  const summary = withAvailable(emptySummary(input.date), input.availableCount);
  const teams = countReservationTeamsFromDraft({
    assignments: input.assignments,
    unassignedReservations: input.unassignedReservations,
  });
  const vacant = countVacantAssignmentTeams(input.assignments);
  const unassignedTeams =
    (input.unassignedReservations?.length || 0) + vacant;
  if (teams.total <= 0) {
    summary.required = {
      source:
        input.source === "engine_estimate"
          ? "estimate_unavailable"
          : "missing_reservations",
      count: null,
      imprecise: false,
    };
    return applyGap(summary);
  }
  summary.reservation = {
    status: "ok",
    total: teams.total,
    byShift: teams.byShift,
  };
  summary.unassignedTeams = unassignedTeams;
  summary.required = {
    source: input.source,
    count: countUniqueRequiredCaddies(input.assignments),
    imprecise: unassignedTeams > 0,
  };
  return applyGap(summary);
}

export function staffingSummaryFromEngineResult(
  result: Pick<
    AutoAssignResultV1,
    "date" | "assignments" | "unassignedReservations"
  >,
  availableCount?: number | null
): DailyStaffingSummary {
  return fromPlacements({
    date: result.date,
    assignments: result.assignments || [],
    unassignedReservations: result.unassignedReservations || [],
    source: "engine_estimate",
    availableCount,
  });
}

export function tryStaffingDryRun(
  input: StaffingDryRunInput
): { ok: true; result: AutoAssignResultV1 } | { ok: false; reason: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || "")) {
    return { ok: false, reason: "date" };
  }
  if (!Array.isArray(input.reservations) || input.reservations.length === 0) {
    return { ok: false, reason: "reservations" };
  }
  if (!Array.isArray(input.available) || input.available.length === 0) {
    return { ok: false, reason: "available" };
  }
  const houseStart = input.houseStartCaddyId;
  if (
    houseStart == null ||
    !Number.isInteger(houseStart) ||
    houseStart < 1
  ) {
    return { ok: false, reason: "houseStart" };
  }
  try {
    const result = computeAutoAssignmentsV1({
      date: input.date,
      reservations: input.reservations,
      available: input.available,
      special: input.special,
      houseStartCaddyId: houseStart,
      thirdStartCaddyId: input.thirdStartCaddyId,
      thirdStartTeam: input.thirdStartTeam,
      openCourses: input.openCourses,
      specialSupportByShift: input.specialSupportByShift,
      oneTwoSupport: input.oneTwoSupport,
    });
    return { ok: true, result };
  } catch {
    return { ok: false, reason: "engine" };
  }
}

export function buildDailyStaffingSummary(
  input: BuildDailyStaffingSummaryInput
): DailyStaffingSummary {
  const date = String(input.date || "");
  const summaryBase = withAvailable(emptySummary(date), input.availableCount);

  if (hasCurrentBoardStaffingResult(input.currentDraft)) {
    return fromPlacements({
      date,
      assignments: input.currentDraft!.assignments || [],
      unassignedReservations: input.currentDraft!.unassignedReservations || [],
      source: "current_board",
      availableCount: input.availableCount,
    });
  }

  const preview = input.previewReservations || [];
  if (input.dryRunInput) {
    const dry = tryStaffingDryRun(input.dryRunInput);
    if (dry.ok) {
      return staffingSummaryFromEngineResult(dry.result, input.availableCount);
    }
  }

  if (preview.length > 0) {
    const teams = countReservationTeamsFromRows(preview);
    summaryBase.reservation = {
      status: "ok",
      total: teams.total,
      byShift: teams.byShift,
    };
    summaryBase.required = {
      source: "estimate_unavailable",
      count: null,
      imprecise: false,
    };
    return applyGap(summaryBase);
  }

  summaryBase.required = {
    source: "missing_reservations",
    count: null,
    imprecise: false,
  };
  return applyGap(summaryBase);
}

export type StaffingCardRow = {
  key: string;
  label: string;
  value: string;
  tone?: "danger" | "ok" | "muted" | "warn";
};

export type DailyStaffingCardModel = {
  title: string;
  shiftLine: string | null;
  rows: StaffingCardRow[];
  availableOnly: boolean;
};

export function formatShiftLine(
  byShift: StaffingShiftCounts | null | undefined
): string | null {
  if (!byShift) return null;
  return `1부 ${byShift["1부"]} · 2부 ${byShift["2부"]} · 3부 ${byShift["3부"]}`;
}

export function formatDailyStaffingCardModel(
  summary: DailyStaffingSummary
): DailyStaffingCardModel {
  const rows: StaffingCardRow[] = [];
  const hasReservation = summary.reservation.status === "ok";
  const hasAvailable = summary.available.status === "ok";
  const availableOnly =
    !hasReservation &&
    summary.required.count == null &&
    hasAvailable;

  if (hasReservation) {
    rows.push({
      key: "reservation",
      label: "예약",
      value: `${summary.reservation.total}팀`,
    });
  } else if (summary.required.source === "missing_reservations") {
    rows.push({
      key: "reservation",
      label: "예약",
      value: "데이터 없음",
      tone: "muted",
    });
  } else {
    rows.push({
      key: "reservation",
      label: "예약",
      value: "데이터 필요",
      tone: "muted",
    });
  }

  if (summary.required.source === "current_board" && summary.required.count != null) {
    rows.push({
      key: "required",
      label: "필요",
      value: `${summary.required.count}명 [현재 배치]`,
    });
  } else if (
    summary.required.source === "engine_estimate" &&
    summary.required.count != null
  ) {
    rows.push({
      key: "required",
      label: "예상 필요",
      value: `${summary.required.count}명 [예상]`,
    });
  } else if (summary.required.source === "estimate_unavailable") {
    rows.push({
      key: "required",
      label: "필요",
      value: "예상 계산 불가",
      tone: "muted",
    });
  }

  if (availableOnly) {
    rows.push({
      key: "available",
      label: "가용",
      value: `${summary.available.count}명만 표시`,
    });
  } else if (hasAvailable) {
    rows.push({
      key: "available",
      label: "가용",
      value: `${summary.available.count}명`,
    });
  }

  if (summary.unassignedTeams > 0) {
    rows.push({
      key: "unassigned",
      label: "미배치",
      value: `${summary.unassignedTeams}팀`,
      tone: "warn",
    });
  }

  if (summary.gap.kind === "surplus" && summary.gap.people != null) {
    rows.push({
      key: "gap",
      label: "여유",
      value: `${summary.gap.people}명`,
      tone: "ok",
    });
  } else if (summary.gap.kind === "shortage" && summary.gap.people != null) {
    rows.push({
      key: "gap",
      label: "부족",
      value: `${summary.gap.people}명`,
      tone: "danger",
    });
  } else if (summary.gap.kind === "min_shortage" && summary.gap.people != null) {
    rows.push({
      key: "gap",
      label: "최소 부족",
      value: `${summary.gap.people}명 이상`,
      tone: "danger",
    });
  } else if (summary.gap.kind === "balanced") {
    rows.push({
      key: "gap",
      label: "적정",
      value: "0명",
    });
  }

  return {
    title: "오늘 인력 현황",
    shiftLine: hasReservation ? formatShiftLine(summary.reservation.byShift) : null,
    rows,
    availableOnly,
  };
}
