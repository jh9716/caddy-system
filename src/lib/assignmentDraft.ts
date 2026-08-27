/**
 * 자동배치 운영 draft (클라이언트 메모리)
 * - DRAFT → EDITED → CONFIRMED → (운영 반영 API) APPLIED
 * - DRAFT/EDITED 는 DB 저장 금지 (confirm API가 거부)
 */

import {
  compareAssignmentOrder,
  compareReservationOrder,
  isPlacementLocked,
  isWeekendBandRow,
  MIN_54HOLE_GAP_MINUTES,
  MIN_ONE_THREE_GAP_MINUTES,
  MIN_ONE_TWO_GAP_MINUTES,
  minutesBetweenReservations,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
  type AssignmentKind,
  type SpareByShift,
  type UnassignedReservationRow,
} from "@/lib/autoAssignEngine";
import type { CourseCode, ShiftPart } from "@/lib/reservationParser";

export type DraftStatus = "DRAFT" | "EDITED" | "CONFIRMED" | "APPLIED";

export type AssignmentDraft = {
  date: string;
  status: DraftStatus;
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  closedCourseReservations: UnassignedReservationRow[];
  openCourses: CourseCode[];
  caddyPool: AutoAssignCaddy[];
  /** 부별 스페어 (대기 — confirm 저장 대상 아님) */
  sparesByShift: SpareByShift[];
  confirmedAt: string | null;
  appliedAt?: string | null;
  applyAuditId?: number | null;
};

export type DraftWarning = {
  level: "error" | "warn";
  code: string;
  message: string;
  reservationKey?: string;
  caddyId?: number;
};

export type DraftMutationResult = {
  draft: AssignmentDraft;
  warnings: DraftWarning[];
  specialEditWarned: boolean;
};

const SPECIAL_KINDS: AssignmentKind[] = [
  "fixed",
  "fiftyFourHole",
  "oneThree",
  "oneTwo",
  "oneMak",
  "driving",
];

export function isSpecialKind(kind: AssignmentKind): boolean {
  return SPECIAL_KINDS.includes(kind);
}

export function createDraftFromAutoResult(
  result: AutoAssignResultV1,
  caddyPool?: AutoAssignCaddy[]
): AssignmentDraft {
  const pool =
    caddyPool && caddyPool.length > 0
      ? caddyPool
      : dedupePool([
          ...result.assignments
            .filter((a) => a.kind !== "specialSupport")
            .map((a) => a.caddy),
          ...result.unusedCaddies,
          ...result.special,
          ...result.specialUnassigned.map((u) => u.caddy),
        ]);

  return {
    date: result.date,
    status: "DRAFT",
    assignments: result.assignments.map(cloneRow).sort(compareAssignmentOrder),
    unassignedReservations: result.unassignedReservations
      .map((u) => ({
        reservation: { ...u.reservation },
        reason: u.reason,
      }))
      .sort((a, b) => compareReservationOrder(a.reservation, b.reservation)),
    closedCourseReservations: (result.closedCourseReservations || [])
      .map((u) => ({
        reservation: { ...u.reservation },
        reason: u.reason,
      }))
      .sort((a, b) => compareReservationOrder(a.reservation, b.reservation)),
    openCourses: [...(result.openCourses || [])],
    caddyPool: pool,
    sparesByShift: (result.sparesByShift || []).map((s) => ({
      shift: s.shift,
      spare1: s.spare1 ? { ...s.spare1 } : null,
      spare2: s.spare2 ? { ...s.spare2 } : null,
    })),
    confirmedAt: null,
    appliedAt: null,
    applyAuditId: null,
  };
}

function cloneRow(row: AutoAssignmentRow): AutoAssignmentRow {
  return {
    ...row,
    reservation: { ...row.reservation },
    caddy: { ...row.caddy },
    locked: row.locked,
  };
}

function dedupePool(caddies: AutoAssignCaddy[]): AutoAssignCaddy[] {
  const map = new Map<number, AutoAssignCaddy>();
  for (const c of caddies) {
    if (!map.has(c.id)) map.set(c.id, c);
  }
  return [...map.values()];
}

function markEdited(draft: AssignmentDraft): AssignmentDraft {
  if (draft.status === "CONFIRMED" || draft.status === "APPLIED") {
    return {
      ...draft,
      status: "EDITED",
      confirmedAt: null,
      appliedAt: null,
      applyAuditId: null,
    };
  }
  return { ...draft, status: draft.status === "DRAFT" ? "EDITED" : draft.status };
}

export function confirmDraft(draft: AssignmentDraft): AssignmentDraft {
  return {
    ...draft,
    status: "CONFIRMED",
    confirmedAt: new Date().toISOString(),
    appliedAt: null,
    applyAuditId: null,
  };
}

/** 운영 반영 API 성공 후 클라이언트 상태 */
export function markDraftApplied(
  draft: AssignmentDraft,
  opts?: { auditId?: number | null }
): AssignmentDraft {
  if (draft.status !== "CONFIRMED" && draft.status !== "APPLIED") {
    return draft;
  }
  return {
    ...draft,
    status: "APPLIED",
    appliedAt: new Date().toISOString(),
    applyAuditId: opts?.auditId ?? draft.applyAuditId ?? null,
  };
}

export function usedCaddyIds(draft: AssignmentDraft): Set<number> {
  return new Set(draft.assignments.map((a) => a.caddy.id));
}

export function unusedCaddies(draft: AssignmentDraft): AutoAssignCaddy[] {
  const used = usedCaddyIds(draft);
  return draft.caddyPool.filter((c) => !used.has(c.id) && c.id > 0 && c.name);
}

export function assignmentsByShift(
  draft: AssignmentDraft,
  shift: ShiftPart
): AutoAssignmentRow[] {
  return draft.assignments
    .filter((a) => {
      // 표시/탭 분류: reservation.shift 우선 (teeTime 추정 금지)
      const s =
        a.reservation?.shift != null && String(a.reservation.shift).trim() !== ""
          ? String(a.reservation.shift)
          : String(a.shift || "");
      return s === shift;
    })
    .sort(compareAssignmentOrder);
}

/** 정상 다회근무(1+2 / 1+3 / 2+3 / special 정상 페어)는 오류로 치지 않음 */
export function detectDraftWarnings(draft: AssignmentDraft): DraftWarning[] {
  const warnings: DraftWarning[] = [];
  const byCaddy = new Map<number, AutoAssignmentRow[]>();

  for (const row of draft.assignments) {
    const list = byCaddy.get(row.caddy.id) || [];
    list.push(row);
    byCaddy.set(row.caddy.id, list);
  }

  for (const [caddyId, rows] of byCaddy.entries()) {
    if (rows.length <= 1) continue;

    const byShift = new Map<string, AutoAssignmentRow[]>();
    for (const row of rows) {
      const list = byShift.get(String(row.shift)) || [];
      list.push(row);
      byShift.set(String(row.shift), list);
    }
    for (const [shift, shiftRows] of byShift.entries()) {
      if (shiftRows.length < 2) continue;
      warnings.push({
        level: "error",
        code: "SAME_SHIFT_DUPLICATE",
        message: `캐디 #${caddyId}(${shiftRows[0].caddy.name})가 ${shift}에 ${shiftRows.length}개 예약 중복 배치`,
        caddyId,
        reservationKey: reservationKey(shiftRows[0].reservation),
      });
    }

    const sorted = [...rows].sort((a, b) =>
      a.reservation.teeTime.localeCompare(b.reservation.teeTime)
    );

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (String(a.shift) === String(b.shift)) continue;

        const gap = minutesBetweenReservations(a.reservation, b.reservation);
        if (!Number.isFinite(gap)) continue;

        const specialGap = requiredSpecialGapMinutes(a, b);
        if (specialGap != null && gap < specialGap) {
          warnings.push({
            level: "error",
            code: "SPECIAL_GAP_CONFLICT",
            message: `캐디 ${a.caddy.name}: ${a.kind}/${b.kind} 최소 ${specialGap}분 간격 위반 (${a.reservation.teeTime}↔${b.reservation.teeTime}, ${gap}분)`,
            caddyId,
            reservationKey: reservationKey(a.reservation),
          });
          continue;
        }

        // 실제 수행 불가: 동일 시각 또는 2시간 미만 (정상 다회근무 티는 보통 충분)
        if (gap < 2 * 60) {
          warnings.push({
            level: "error",
            code: "TIME_CONFLICT",
            message: `캐디 ${a.caddy.name}: ${a.reservation.teeTime} ↔ ${b.reservation.teeTime} 간격 ${gap}분 (수행 불가)`,
            caddyId,
            reservationKey: reservationKey(a.reservation),
          });
        }
      }
    }
  }

  return warnings;
}

function requiredSpecialGapMinutes(
  a: AutoAssignmentRow,
  b: AutoAssignmentRow
): number | null {
  const kinds = new Set([a.kind, b.kind]);
  if (kinds.has("fiftyFourHole")) return MIN_54HOLE_GAP_MINUTES;
  if (kinds.has("oneThree")) return MIN_ONE_THREE_GAP_MINUTES;
  if (kinds.has("oneTwo")) return MIN_ONE_TWO_GAP_MINUTES;
  return null;
}

function findAssignmentIndex(
  draft: AssignmentDraft,
  resKey: string
): number {
  return draft.assignments.findIndex(
    (a) => reservationKey(a.reservation) === resKey
  );
}

function findCaddy(
  draft: AssignmentDraft,
  caddyId: number
): AutoAssignCaddy | null {
  return (
    draft.caddyPool.find((c) => c.id === caddyId) ||
    draft.assignments.find((a) => a.caddy.id === caddyId)?.caddy ||
    null
  );
}

/** 예약에 배치된 캐디를 다른 캐디로 교체 */
export function replaceAssignmentCaddy(
  draft: AssignmentDraft,
  resKey: string,
  newCaddyId: number,
  options?: { allowSpecialEdit?: boolean }
): DraftMutationResult {
  const warnings: DraftWarning[] = [];
  const idx = findAssignmentIndex(draft, resKey);
  if (idx < 0) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "RESERVATION_NOT_FOUND",
          message: "배치 예약을 찾을 수 없습니다.",
          reservationKey: resKey,
        },
      ],
      specialEditWarned: false,
    };
  }

  const row = draft.assignments[idx];
  let specialEditWarned = false;
  if (isSpecialKind(row.kind) && !options?.allowSpecialEdit) {
    return {
      draft,
      warnings: [
        {
          level: "warn",
          code: "SPECIAL_EDIT_CONFIRM_REQUIRED",
          message: `special 배치(${row.kind}/${row.reason})를 수정하려면 확인이 필요합니다.`,
          reservationKey: resKey,
        },
      ],
      specialEditWarned: true,
    };
  }
  if (isSpecialKind(row.kind)) specialEditWarned = true;

  const newCaddy = findCaddy(draft, newCaddyId);
  if (!newCaddy) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "CADDY_NOT_FOUND",
          message: `캐디 #${newCaddyId}를 찾을 수 없습니다.`,
          caddyId: newCaddyId,
        },
      ],
      specialEditWarned,
    };
  }

  const sameShiftDup = draft.assignments.some(
    (a) =>
      a.caddy.id === newCaddyId &&
      String(a.shift) === String(row.shift) &&
      reservationKey(a.reservation) !== resKey
  );
  if (sameShiftDup) {
    warnings.push({
      level: "error",
      code: "SAME_SHIFT_DUPLICATE",
      message: `${newCaddy.name}은(는) 이미 같은 부 다른 예약에 배치되어 있습니다.`,
      caddyId: newCaddyId,
    });
  }

  const nextAssignments = draft.assignments.map((a, i) =>
    i === idx
      ? {
          ...cloneRow(a),
          caddy: { ...newCaddy },
          reason: `MANUAL_REPLACE(${a.reason})`,
        }
      : a
  );

  const next = markEdited({
    ...draft,
    assignments: nextAssignments,
  });
  warnings.push(...detectDraftWarnings(next));

  return { draft: next, warnings, specialEditWarned };
}

/** 두 예약의 캐디 swap */
export function swapAssignmentCaddies(
  draft: AssignmentDraft,
  resKeyA: string,
  resKeyB: string,
  options?: { allowSpecialEdit?: boolean }
): DraftMutationResult {
  const warnings: DraftWarning[] = [];
  const ia = findAssignmentIndex(draft, resKeyA);
  const ib = findAssignmentIndex(draft, resKeyB);
  if (ia < 0 || ib < 0) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "RESERVATION_NOT_FOUND",
          message: "swap 대상 예약을 찾을 수 없습니다.",
        },
      ],
      specialEditWarned: false,
    };
  }

  const a = draft.assignments[ia];
  const b = draft.assignments[ib];
  let specialEditWarned = false;
  if (
    (isSpecialKind(a.kind) || isSpecialKind(b.kind)) &&
    !options?.allowSpecialEdit
  ) {
    return {
      draft,
      warnings: [
        {
          level: "warn",
          code: "SPECIAL_EDIT_CONFIRM_REQUIRED",
          message: "special 배치가 포함된 swap은 확인이 필요합니다.",
        },
      ],
      specialEditWarned: true,
    };
  }
  if (isSpecialKind(a.kind) || isSpecialKind(b.kind)) specialEditWarned = true;

  const nextAssignments = draft.assignments.map((row, i) => {
    if (i === ia) {
      return {
        ...cloneRow(row),
        caddy: { ...b.caddy },
        reason: `MANUAL_SWAP(${row.reason})`,
      };
    }
    if (i === ib) {
      return {
        ...cloneRow(row),
        caddy: { ...a.caddy },
        reason: `MANUAL_SWAP(${row.reason})`,
      };
    }
    return row;
  });

  const next = markEdited({ ...draft, assignments: nextAssignments });
  warnings.push(...detectDraftWarnings(next));
  return { draft: next, warnings, specialEditWarned };
}

/** 미배치 예약에 캐디 직접 지정 */
export function assignCaddyToUnassigned(
  draft: AssignmentDraft,
  resKey: string,
  caddyId: number
): DraftMutationResult {
  const warnings: DraftWarning[] = [];
  const uidx = draft.unassignedReservations.findIndex(
    (u) => reservationKey(u.reservation) === resKey
  );
  if (uidx < 0) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "UNASSIGNED_NOT_FOUND",
          message: "미배치 예약을 찾을 수 없습니다.",
          reservationKey: resKey,
        },
      ],
      specialEditWarned: false,
    };
  }

  const caddy = findCaddy(draft, caddyId);
  if (!caddy) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "CADDY_NOT_FOUND",
          message: `캐디 #${caddyId}를 찾을 수 없습니다.`,
          caddyId,
        },
      ],
      specialEditWarned: false,
    };
  }

  const reservation = draft.unassignedReservations[uidx].reservation;
  const sameShiftDup = draft.assignments.some(
    (a) =>
      a.caddy.id === caddyId && String(a.shift) === String(reservation.shift)
  );
  if (sameShiftDup) {
    warnings.push({
      level: "error",
      code: "SAME_SHIFT_DUPLICATE",
      message: `${caddy.name}은(는) 이미 같은 부 다른 예약에 배치되어 있습니다.`,
      caddyId,
    });
  }
  const newRow: AutoAssignmentRow = {
    date: draft.date,
    shift: reservation.shift as ShiftPart,
    sequenceIndex: -1,
    reason: "MANUAL_ASSIGN",
    reservation: { ...reservation },
    caddy: { ...caddy },
    pairId: null,
    kind: "regular",
  };

  const nextUnassigned = draft.unassignedReservations.filter((_, i) => i !== uidx);
  const next = markEdited({
    ...draft,
    assignments: [...draft.assignments, newRow],
    unassignedReservations: nextUnassigned,
  });
  warnings.push(...detectDraftWarnings(next));
  return { draft: next, warnings, specialEditWarned: false };
}

/** 배치 해제 → 미배치로 */
export function unassignReservation(
  draft: AssignmentDraft,
  resKey: string,
  options?: { allowSpecialEdit?: boolean }
): DraftMutationResult {
  const idx = findAssignmentIndex(draft, resKey);
  if (idx < 0) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "RESERVATION_NOT_FOUND",
          message: "배치 예약을 찾을 수 없습니다.",
        },
      ],
      specialEditWarned: false,
    };
  }
  const row = draft.assignments[idx];
  if (isSpecialKind(row.kind) && !options?.allowSpecialEdit) {
    return {
      draft,
      warnings: [
        {
          level: "warn",
          code: "SPECIAL_EDIT_CONFIRM_REQUIRED",
          message: "special 배치 해제는 확인이 필요합니다.",
          reservationKey: resKey,
        },
      ],
      specialEditWarned: true,
    };
  }

  const next = markEdited({
    ...draft,
    assignments: draft.assignments.filter((_, i) => i !== idx),
    unassignedReservations: [
      ...draft.unassignedReservations,
      { reservation: { ...row.reservation }, reason: "MANUAL_UNASSIGN" },
    ],
  });
  return {
    draft: next,
    warnings: detectDraftWarnings(next),
    specialEditWarned: isSpecialKind(row.kind),
  };
}

export function reservationIdentity(r: AutoAssignReservation): string {
  return reservationKey(r);
}

export function setPlacementLock(
  draft: AssignmentDraft,
  resKey: string,
  locked: boolean
): DraftMutationResult {
  const idx = findAssignmentIndex(draft, resKey);
  if (idx < 0) {
    return {
      draft,
      warnings: [
        {
          level: "error",
          code: "RESERVATION_NOT_FOUND",
          message: "LOCK 대상 예약을 찾을 수 없습니다.",
          reservationKey: resKey,
        },
      ],
      specialEditWarned: false,
    };
  }
  const nextAssignments = draft.assignments.map((a, i) =>
    i === idx ? { ...cloneRow(a), locked } : a
  );
  return {
    draft: { ...draft, assignments: nextAssignments },
    warnings: detectDraftWarnings({ ...draft, assignments: nextAssignments }),
    specialEditWarned: false,
  };
}

export function autoResultFromDraft(
  draft: AssignmentDraft,
  base: AutoAssignResultV1 | null
): AutoAssignResultV1 {
  const assignments = draft.assignments.map(cloneRow);
  const weekendBandAssignments = assignments.filter(isWeekendBandRow);
  const regularAssignments = assignments.filter(
    (a) => a.kind === "regular" && !isWeekendBandRow(a)
  );
  const fallbackMeta = {
    availableCount: draft.caddyPool.length,
    reservationCount: assignments.length + draft.unassignedReservations.length,
    assignedCount: assignments.length,
    unassignedCount: draft.unassignedReservations.length,
    closedCourseCount: draft.closedCourseReservations.length,
    unusedCount: unusedCaddies(draft).length,
    specialCount: base?.meta.specialCount ?? 0,
    fixedAssignedCount: 0,
    fixedUnassignedCount: 0,
    fiftyFourHoleCandidateCount: 0,
    fiftyFourHoleAssignedCaddyCount: 0,
    fiftyFourHoleUnassignedCount: 0,
    oneThreeCandidateCount: 0,
    oneThreeAssignedCaddyCount: 0,
    oneThreeUnassignedCount: 0,
    oneTwoCandidateCount: 0,
    oneTwoAssignedCaddyCount: 0,
    oneTwoUnassignedCount: 0,
    oneMakCandidateCount: 0,
    oneMakAssignedCaddyCount: 0,
    oneMakUnassignedCount: 0,
    housePoolCount: 0,
    thirdPoolCount: 0,
    drivingPoolCount: 0,
    byShift: {
      "1부": { reservations: 0, assigned: 0, unassigned: 0 },
      "2부": { reservations: 0, assigned: 0, unassigned: 0 },
      "3부": { reservations: 0, assigned: 0, unassigned: 0 },
    },
    finalPointer: 0,
    thirdStartTeam: base?.meta.thirdStartTeam || "",
    thirdStartTeamAutomatic: base?.meta.thirdStartTeamAutomatic || "",
    ...(base?.meta.houseStartCaddyId != null
      ? { houseStartCaddyId: Number(base.meta.houseStartCaddyId) }
      : {}),
    ...(base?.meta.thirdStartCaddyId != null
      ? { thirdStartCaddyId: Number(base.meta.thirdStartCaddyId) }
      : {}),
  };
  return {
    date: draft.date,
    assignments,
    fixedAssignments: assignments.filter((a) => a.kind === "fixed"),
    fiftyFourHoleAssignments: assignments.filter((a) => a.kind === "fiftyFourHole"),
    oneThreeAssignments: assignments.filter((a) => a.kind === "oneThree"),
    oneTwoAssignments: assignments.filter((a) => a.kind === "oneTwo"),
    oneMakAssignments: assignments.filter((a) => a.kind === "oneMak"),
    weekendBandAssignments,
    regularAssignments,
    unassignedReservations: draft.unassignedReservations.map((u) => ({
      reservation: { ...u.reservation },
      reason: u.reason,
    })),
    closedCourseReservations: (draft.closedCourseReservations || []).map((u) => ({
      reservation: { ...u.reservation },
      reason: u.reason,
    })),
    unusedCaddies: unusedCaddies(draft),
    special: base?.special || [],
    specialUnassigned: base?.specialUnassigned || [],
    specialPlacement: base?.specialPlacement
      ? { ...base.specialPlacement }
      : undefined,
    specialSupportByShift: base?.specialSupportByShift,
    openCourses: [...(draft.openCourses || [])],
    sparesByShift: (draft.sparesByShift || []).map((s) => ({
      shift: s.shift,
      spare1: s.spare1 ? { ...s.spare1 } : null,
      spare2: s.spare2 ? { ...s.spare2 } : null,
    })),
    meta: { ...fallbackMeta, ...(base?.meta || {}), ...{
      assignedCount: assignments.length,
      unassignedCount: draft.unassignedReservations.length,
      closedCourseCount: draft.closedCourseReservations.length,
      unusedCount: unusedCaddies(draft).length,
    } },
  };
}

export function applyLiveResultToDraft(
  draft: AssignmentDraft,
  after: AutoAssignResultV1
): AssignmentDraft {
  const next = createDraftFromAutoResult(after, draft.caddyPool);
  const resetConfirm = draft.status === "CONFIRMED" || draft.status === "APPLIED";
  return {
    ...next,
    status: "EDITED",
    confirmedAt: resetConfirm ? null : draft.confirmedAt,
    appliedAt: null,
    applyAuditId: null,
  };
}

export { isPlacementLocked };
