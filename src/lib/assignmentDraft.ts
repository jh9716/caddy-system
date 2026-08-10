/**
 * 자동배치 운영 draft (클라이언트 메모리 전용)
 * - DB write 없음
 * - DRAFT → EDITED → CONFIRMED
 */

import {
  minutesBetweenReservations,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
  type AssignmentKind,
  type UnassignedReservationRow,
} from "@/lib/autoAssignEngine";
import type { ShiftPart } from "@/lib/reservationParser";

export type DraftStatus = "DRAFT" | "EDITED" | "CONFIRMED";

export type AssignmentDraft = {
  date: string;
  status: DraftStatus;
  assignments: AutoAssignmentRow[];
  unassignedReservations: UnassignedReservationRow[];
  caddyPool: AutoAssignCaddy[];
  confirmedAt: string | null;
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
          ...result.assignments.map((a) => a.caddy),
          ...result.unusedCaddies,
          ...result.special,
          ...result.specialUnassigned.map((u) => u.caddy),
        ]);

  return {
    date: result.date,
    status: "DRAFT",
    assignments: result.assignments.map(cloneRow),
    unassignedReservations: result.unassignedReservations.map((u) => ({
      reservation: { ...u.reservation },
      reason: u.reason,
    })),
    caddyPool: pool,
    confirmedAt: null,
  };
}

function cloneRow(row: AutoAssignmentRow): AutoAssignmentRow {
  return {
    ...row,
    reservation: { ...row.reservation },
    caddy: { ...row.caddy },
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
  if (draft.status === "CONFIRMED") {
    return { ...draft, status: "EDITED", confirmedAt: null };
  }
  return { ...draft, status: draft.status === "DRAFT" ? "EDITED" : draft.status };
}

export function confirmDraft(draft: AssignmentDraft): AssignmentDraft {
  return {
    ...draft,
    status: "CONFIRMED",
    confirmedAt: new Date().toISOString(),
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
    .filter((a) => a.shift === shift)
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
}

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
    warnings.push({
      level: "error",
      code: "DUPLICATE_CADDY",
      message: `캐디 #${caddyId}(${rows[0].caddy.name})가 ${rows.length}개 예약에 중복 배치됨`,
      caddyId,
    });

    const sorted = [...rows].sort((a, b) =>
      a.reservation.teeTime.localeCompare(b.reservation.teeTime)
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const gap = minutesBetweenReservations(
          sorted[i].reservation,
          sorted[j].reservation
        );
        // 같은 시각이거나 4시간 미만이면 경고 (운영 휴리스틱)
        if (Number.isFinite(gap) && gap < 4 * 60) {
          warnings.push({
            level: "error",
            code: "TIME_CONFLICT",
            message: `캐디 ${sorted[i].caddy.name}: ${sorted[i].reservation.teeTime} ↔ ${sorted[j].reservation.teeTime} 간격 ${gap}분 (충돌 가능)`,
            caddyId,
            reservationKey: reservationKey(sorted[i].reservation),
          });
        }
      }
    }
  }

  return warnings;
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

  const used = usedCaddyIds(draft);
  if (used.has(newCaddyId) && row.caddy.id !== newCaddyId) {
    warnings.push({
      level: "error",
      code: "DUPLICATE_CADDY",
      message: `${newCaddy.name}은(는) 이미 다른 예약에 배치되어 있습니다.`,
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

  if (usedCaddyIds(draft).has(caddyId)) {
    warnings.push({
      level: "error",
      code: "DUPLICATE_CADDY",
      message: `${caddy.name}은(는) 이미 배치되어 있습니다.`,
      caddyId,
    });
  }

  const reservation = draft.unassignedReservations[uidx].reservation;
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
