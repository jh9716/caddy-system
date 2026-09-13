/**
 * 배치표 캐디 셀 직접편집 V1.
 * 전체 autoAssign/reflow를 호출하지 않는다.
 * 54홀·1·2·1·3·고정 등 특수 연결은 조용히 깨지 않고 차단한다.
 */

import {
  assignCaddyToUnassigned,
  isSpecialKind,
  replaceAssignmentCaddy,
  swapAssignmentCaddies,
  unusedCaddies,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  compareAssignmentOrder,
  compareReservationOrder,
  isPlacementLocked,
  reservationKey,
  resolveCourseCode,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignmentRow,
  type SpareByShift,
  type SpareCaddyInfo,
} from "@/lib/autoAssignEngine";
import {
  type BoardCell,
  type BoardTimeRow,
} from "@/lib/assignmentBoardView";
import { isOperationalEmploymentStatus } from "@/lib/operationalRoster";
import {
  COURSE_CODES,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const DIRECT_EDIT_PROTECTED_MESSAGE =
  "54홀·1·2·1·3·고정 등 특수 연결 배치는 직접편집할 수 없습니다. 기존 메뉴를 사용하세요.";

export const DIRECT_EDIT_SHIFT_BLOCKED_MESSAGE =
  "LOCK/특수 배치를 밀어야 해서 이 위치에 미배치 캐디를 넣을 수 없습니다.";

export const DIRECT_EDIT_NOT_OPERATIONAL_MESSAGE =
  "퇴사/삭제 캐디는 배치할 수 없습니다.";

export const DIRECT_EDIT_NOT_FOUND_MESSAGE = "배치 예약을 찾을 수 없습니다.";

export const DIRECT_EDIT_CADDY_NOT_FOUND_MESSAGE =
  "선택한 캐디를 현재 운영 roster에서 찾을 수 없습니다.";

export const VACANT_CADDY_PLACEHOLDER: AutoAssignCaddy = {
  id: 0,
  name: "",
  team: "",
  teamOrder: 0,
};

export type DirectEditCandidateGroup = "current" | "assigned" | "unassigned";

export type DirectEditCandidate = {
  caddy: AutoAssignCaddy;
  group: DirectEditCandidateGroup;
  reservationKey?: string;
  teeTime?: string;
  teamName?: string | null;
};

export type DirectCaddyEditResult =
  | {
      ok: true;
      action: "noop";
      draft: AssignmentDraft;
      toast: string;
      affectedKeys: string[];
    }
  | {
      ok: true;
      action: "swap";
      draft: AssignmentDraft;
      reservationKeyA: string;
      reservationKeyB: string;
      toast: string;
      affectedKeys: string[];
    }
  | {
      ok: true;
      action: "place" | "insert";
      draft: AssignmentDraft;
      toast: string;
      affectedKeys: string[];
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

const LINKED_SPECIAL_KINDS = new Set<AutoAssignmentRow["kind"]>([
  "fiftyFourHole",
  "oneThree",
  "oneTwo",
  "oneMak",
  "fixed",
  "driving",
  "specialSupport",
]);

function assignmentShift(row: AutoAssignmentRow): string {
  const fromRes = row.reservation?.shift;
  if (fromRes != null && String(fromRes).trim() !== "") {
    return String(fromRes);
  }
  return String(row.shift || "");
}

function hasPairId(row: AutoAssignmentRow): boolean {
  return String(row.pairId || "").trim() !== "";
}

export function isDirectEditVacantCaddy(
  caddy: Pick<AutoAssignCaddy, "id" | "name"> | null | undefined
): boolean {
  if (!caddy) return true;
  if (!Number.isInteger(caddy.id) || caddy.id <= 0) return true;
  return String(caddy.name || "").trim() === "";
}

export function isDirectEditVacant(row: AutoAssignmentRow): boolean {
  return isDirectEditVacantCaddy(row.caddy);
}

export function isDirectEditProtected(row: AutoAssignmentRow): boolean {
  if (LINKED_SPECIAL_KINDS.has(row.kind)) return true;
  if (isSpecialKind(row.kind) && row.kind !== "regular") return true;
  if (hasPairId(row)) return true;
  return false;
}

export function isDirectEditShiftable(row: AutoAssignmentRow): boolean {
  if (isDirectEditProtected(row)) return false;
  if (isDirectEditVacant(row)) return false;
  if (row.kind !== "regular") return false;
  if (isPlacementLocked(row)) return false;
  return true;
}

export function isDirectEditTargetAllowed(row: AutoAssignmentRow): boolean {
  if (isDirectEditProtected(row)) return false;
  if (isDirectEditVacant(row)) return true;
  return row.kind === "regular";
}

export function matchesDirectEditQuery(
  caddy: Pick<AutoAssignCaddy, "name" | "team">,
  query: string
): boolean {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const name = String(caddy.name || "").toLowerCase();
  const team = String(caddy.team || "").toLowerCase();
  return name.includes(q) || team.includes(q);
}

function cloneCaddy(caddy: AutoAssignCaddy): AutoAssignCaddy {
  return { ...caddy };
}

function cloneRow(row: AutoAssignmentRow): AutoAssignmentRow {
  return {
    ...row,
    reservation: { ...row.reservation },
    caddy: { ...row.caddy },
    locked: row.locked,
  };
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

function findCaddyInDraft(
  draft: AssignmentDraft,
  caddyId: number
): AutoAssignCaddy | null {
  if (!Number.isInteger(caddyId) || caddyId <= 0) return null;
  return (
    draft.caddyPool.find((c) => c.id === caddyId) ||
    draft.assignments.find((a) => a.caddy.id === caddyId)?.caddy ||
    spareCaddyFromDraft(draft, caddyId)
  );
}

function spareCaddyFromDraft(
  draft: AssignmentDraft,
  caddyId: number
): AutoAssignCaddy | null {
  for (const row of draft.sparesByShift || []) {
    for (const spare of [row.spare1, row.spare2]) {
      if (spare?.caddyId === caddyId) {
        return {
          id: spare.caddyId,
          name: spare.name,
          team: spare.team,
          teamOrder: spare.teamOrder,
        };
      }
    }
  }
  return null;
}

export function isOperationalPickerCaddy(
  caddy: Pick<AutoAssignCaddy, "id" | "name" | "employmentStatus"> | null | undefined
): boolean {
  if (!caddy || !Number.isInteger(caddy.id) || caddy.id <= 0) return false;
  if (!String(caddy.name || "").trim()) return false;
  return isOperationalEmploymentStatus(caddy.employmentStatus);
}

function sameShiftAssignedRow(
  draft: AssignmentDraft,
  shift: string,
  caddyId: number,
  exceptKey?: string
): AutoAssignmentRow | null {
  return (
    draft.assignments.find((row) => {
      if (row.caddy.id !== caddyId) return false;
      if (assignmentShift(row) !== shift) return false;
      if (exceptKey && reservationKey(row.reservation) === exceptKey) return false;
      return !isDirectEditVacant(row);
    }) || null
  );
}

export function listDirectEditCandidates(
  draft: AssignmentDraft,
  input: {
    shift: ShiftPart | string;
    currentCaddyId?: number | null;
    query?: string;
    unavailableCaddyIds?: Iterable<number>;
  }
): DirectEditCandidate[] {
  const shift = String(input.shift);
  const query = input.query || "";
  const unavailable = new Set(
    [...(input.unavailableCaddyIds || [])].map((id) => Number(id))
  );
  const assignedInShift = draft.assignments
    .filter(
      (row) =>
        assignmentShift(row) === shift &&
        !isDirectEditVacant(row) &&
        isOperationalPickerCaddy(row.caddy)
    )
    .sort(compareAssignmentOrder);

  const assignedIds = new Set(assignedInShift.map((row) => row.caddy.id));
  const currentId = Number(input.currentCaddyId) || 0;
  const out: DirectEditCandidate[] = [];
  const seen = new Set<number>();

  const push = (candidate: DirectEditCandidate) => {
    if (!isOperationalPickerCaddy(candidate.caddy)) return;
    if (!matchesDirectEditQuery(candidate.caddy, query)) return;
    if (seen.has(candidate.caddy.id)) return;
    seen.add(candidate.caddy.id);
    out.push(candidate);
  };

  if (currentId > 0) {
    const current =
      assignedInShift.find((row) => row.caddy.id === currentId) ||
      draft.assignments.find((row) => row.caddy.id === currentId) ||
      null;
    if (current && isOperationalPickerCaddy(current.caddy)) {
      push({
        caddy: cloneCaddy(current.caddy),
        group: "current",
        reservationKey: reservationKey(current.reservation),
        teeTime: current.reservation.teeTime,
        teamName: current.reservation.teamName,
      });
    }
  }

  for (const row of assignedInShift) {
    if (row.caddy.id === currentId) continue;
    push({
      caddy: cloneCaddy(row.caddy),
      group: "assigned",
      reservationKey: reservationKey(row.reservation),
      teeTime: row.reservation.teeTime,
      teamName: row.reservation.teamName,
    });
  }

  const unused = unusedCaddies(draft);
  const sparePeople: AutoAssignCaddy[] = [];
  for (const row of draft.sparesByShift || []) {
    for (const spare of [row.spare1, row.spare2]) {
      if (!spare?.caddyId) continue;
      const found = findCaddyInDraft(draft, spare.caddyId);
      if (found) sparePeople.push(found);
    }
  }

  const otherShiftAssigned = draft.assignments.filter(
    (row) =>
      assignmentShift(row) !== shift &&
      !isDirectEditVacant(row) &&
      isOperationalPickerCaddy(row.caddy) &&
      !assignedIds.has(row.caddy.id)
  );

  const unassignedPool: AutoAssignCaddy[] = [];
  for (const person of [...sparePeople, ...unused, ...otherShiftAssigned.map((r) => r.caddy)]) {
    if (assignedIds.has(person.id) && person.id !== currentId) continue;
    if (unavailable.has(person.id) && person.id !== currentId) continue;
    unassignedPool.push(person);
  }

  unassignedPool.sort((a, b) => {
    const team = String(a.team || "").localeCompare(String(b.team || ""), "ko");
    if (team !== 0) return team;
    return String(a.name || "").localeCompare(String(b.name || ""), "ko");
  });

  for (const person of unassignedPool) {
    if (person.id === currentId) continue;
    push({ caddy: cloneCaddy(person), group: "unassigned" });
  }

  return out;
}

function toSpareInfo(caddy: AutoAssignCaddy): SpareCaddyInfo {
  return {
    caddyId: caddy.id,
    name: caddy.name,
    team: caddy.team,
    teamOrder: caddy.teamOrder,
  };
}

function removeCaddyFromSpares(
  spares: SpareByShift[],
  caddyId: number
): SpareByShift[] {
  return (spares || []).map((row) => {
    const spare1 = row.spare1?.caddyId === caddyId ? null : row.spare1;
    const spare2 = row.spare2?.caddyId === caddyId ? null : row.spare2;
    if (spare1 == null && spare2 != null) {
      return { ...row, spare1: spare2, spare2: null };
    }
    return { ...row, spare1, spare2 };
  });
}

function offerSpare(
  spares: SpareByShift[],
  shift: ShiftPart | string,
  caddy: AutoAssignCaddy
): SpareByShift[] {
  if (!isOperationalPickerCaddy(caddy)) return spares;
  const info = toSpareInfo(caddy);
  const shiftKey = String(shift);
  let found = false;
  const next = (spares || []).map((row) => {
    if (String(row.shift) !== shiftKey) return row;
    found = true;
    if (row.spare1?.caddyId === caddy.id || row.spare2?.caddyId === caddy.id) {
      return row;
    }
    if (!row.spare1) return { ...row, spare1: info };
    if (!row.spare2) return { ...row, spare2: info };
    return row;
  });
  if (!found) {
    next.push({
      shift: shift as ShiftPart,
      spare1: info,
      spare2: null,
    });
  }
  return next;
}

function findTargetAssignment(
  draft: AssignmentDraft,
  resKey: string
): AutoAssignmentRow | null {
  return (
    draft.assignments.find((row) => reservationKey(row.reservation) === resKey) ||
    null
  );
}

function findUnassigned(
  draft: AssignmentDraft,
  resKey: string
): AutoAssignReservation | null {
  return (
    draft.unassignedReservations.find(
      (u) => reservationKey(u.reservation) === resKey
    )?.reservation || null
  );
}

function vacantRowFromReservation(
  draft: AssignmentDraft,
  reservation: AutoAssignReservation
): AutoAssignmentRow {
  return {
    date: draft.date,
    shift: reservation.shift as ShiftPart,
    sequenceIndex: -1,
    reason: "UNASSIGNED_VACANT",
    reservation: { ...reservation },
    caddy: { ...VACANT_CADDY_PLACEHOLDER },
    pairId: null,
    kind: "regular",
  };
}

export function unassignedReservationAtCell(
  draft: AssignmentDraft,
  input: { shift: ShiftPart | string; course: string; teeTime: string }
): AutoAssignReservation | null {
  const course = resolveCourseCode(input.course);
  const shift = String(input.shift);
  const teeTime = String(input.teeTime || "");
  const match = draft.unassignedReservations.find((u) => {
    if (String(u.reservation.shift) !== shift) return false;
    if (String(u.reservation.teeTime || "") !== teeTime) return false;
    return resolveCourseCode(u.reservation.course) === course;
  });
  return match ? { ...match.reservation } : null;
}

export function overlayUnassignedVacancies(input: {
  board: BoardTimeRow[];
  draft: AssignmentDraft;
  shift: ShiftPart;
  openCourses: readonly CourseCode[];
}): BoardTimeRow[] {
  const open = new Set(input.openCourses);
  const byTime = new Map<string, BoardTimeRow>();
  for (const row of input.board) {
    byTime.set(row.teeTime, {
      teeTime: row.teeTime,
      cells: { ...row.cells },
    });
  }

  const vacancies = input.draft.unassignedReservations
    .map((u) => u.reservation)
    .filter((reservation) => String(reservation.shift) === input.shift)
    .sort(compareReservationOrder);

  for (const reservation of vacancies) {
    const code = resolveCourseCode(reservation.course);
    if (!code || !open.has(code)) continue;
    const teeTime = reservation.teeTime || "";
    let timeRow = byTime.get(teeTime);
    if (!timeRow) {
      const cells = {} as Record<CourseCode, BoardCell>;
      for (const course of COURSE_CODES) {
        if (!open.has(course)) cells[course] = { kind: "closed" };
        else cells[course] = { kind: "empty" };
      }
      timeRow = { teeTime, cells };
      byTime.set(teeTime, timeRow);
    }
    const cell = timeRow.cells[code];
    if (cell.kind !== "empty") continue;
    timeRow.cells[code] = {
      kind: "assigned",
      rows: [vacantRowFromReservation(input.draft, reservation)],
    };
  }

  return [...byTime.values()].sort((a, b) => a.teeTime.localeCompare(b.teeTime));
}

function applySparesAfterTaking(
  draft: AssignmentDraft,
  shift: string,
  takenCaddy: AutoAssignCaddy,
  displaced: AutoAssignCaddy | null
): SpareByShift[] {
  let spares = removeCaddyFromSpares(draft.sparesByShift || [], takenCaddy.id);
  if (
    displaced &&
    !isDirectEditVacantCaddy(displaced) &&
    displaced.id !== takenCaddy.id
  ) {
    spares = offerSpare(spares, shift, displaced);
  }
  return spares;
}

function placeOnVacantAssignment(
  draft: AssignmentDraft,
  target: AutoAssignmentRow,
  caddy: AutoAssignCaddy
): DirectCaddyEditResult {
  const key = reservationKey(target.reservation);
  const result = replaceAssignmentCaddy(draft, key, caddy.id);
  if (result.warnings.some((w) => w.level === "error" && w.code !== "SAME_SHIFT_DUPLICATE")) {
    const blocking = result.warnings.find((w) => w.level === "error");
    return {
      ok: false,
      code: blocking?.code || "PLACE_FAILED",
      message: blocking?.message || "빈 칸에 배치하지 못했습니다.",
    };
  }
  const next = markEdited({
    ...result.draft,
    sparesByShift: applySparesAfterTaking(
      result.draft,
      assignmentShift(target),
      caddy,
      null
    ),
  });
  return {
    ok: true,
    action: "place",
    draft: next,
    toast: `${caddy.name} 배치`,
    affectedKeys: [key],
  };
}

function placeOnUnassigned(
  draft: AssignmentDraft,
  resKey: string,
  caddy: AutoAssignCaddy
): DirectCaddyEditResult {
  const result = assignCaddyToUnassigned(draft, resKey, caddy.id);
  if (result.warnings.some((w) => w.level === "error" && w.code !== "SAME_SHIFT_DUPLICATE")) {
    const blocking = result.warnings.find((w) => w.level === "error");
    return {
      ok: false,
      code: blocking?.code || "PLACE_FAILED",
      message: blocking?.message || "빈 칸에 배치하지 못했습니다.",
    };
  }
  const reservation = findUnassigned(draft, resKey);
  const next = markEdited({
    ...result.draft,
    sparesByShift: applySparesAfterTaking(
      result.draft,
      String(reservation?.shift || ""),
      caddy,
      null
    ),
  });
  return {
    ok: true,
    action: "place",
    draft: next,
    toast: `${caddy.name} 배치`,
    affectedKeys: [resKey],
  };
}

function insertSpareIntoRegularWindow(
  draft: AssignmentDraft,
  target: AutoAssignmentRow,
  caddy: AutoAssignCaddy
): DirectCaddyEditResult {
  if (isDirectEditProtected(target)) {
    return {
      ok: false,
      code: "DIRECT_EDIT_PROTECTED",
      message: DIRECT_EDIT_PROTECTED_MESSAGE,
    };
  }
  if (isPlacementLocked(target) || !isDirectEditShiftable(target)) {
    return {
      ok: false,
      code: "DIRECT_EDIT_SHIFT_BLOCKED",
      message: DIRECT_EDIT_SHIFT_BLOCKED_MESSAGE,
    };
  }

  const shift = assignmentShift(target);
  const targetKey = reservationKey(target.reservation);
  const ordered = draft.assignments
    .filter((row) => assignmentShift(row) === shift)
    .sort(compareAssignmentOrder);
  const start = ordered.findIndex(
    (row) => reservationKey(row.reservation) === targetKey
  );
  if (start < 0) {
    return {
      ok: false,
      code: "RESERVATION_NOT_FOUND",
      message: DIRECT_EDIT_NOT_FOUND_MESSAGE,
    };
  }

  const windowRows: AutoAssignmentRow[] = [];
  let absorb: AutoAssignmentRow | null = null;
  for (let i = start; i < ordered.length; i++) {
    const row = ordered[i];
    if (i === start) {
      windowRows.push(row);
      continue;
    }
    if (isDirectEditVacant(row) && !isDirectEditProtected(row)) {
      absorb = row;
      break;
    }
    if (isDirectEditShiftable(row)) {
      windowRows.push(row);
      continue;
    }
    break;
  }

  if (windowRows.length === 0) {
    return {
      ok: false,
      code: "DIRECT_EDIT_SHIFT_BLOCKED",
      message: DIRECT_EDIT_SHIFT_BLOCKED_MESSAGE,
    };
  }

  const oldCaddies = windowRows.map((row) => cloneCaddy(row.caddy));
  const displaced = oldCaddies[windowRows.length - 1];
  const nextByKey = new Map<string, AutoAssignCaddy>();
  nextByKey.set(reservationKey(windowRows[0].reservation), cloneCaddy(caddy));
  for (let i = 1; i < windowRows.length; i++) {
    nextByKey.set(reservationKey(windowRows[i].reservation), oldCaddies[i - 1]);
  }
  if (absorb) {
    nextByKey.set(reservationKey(absorb.reservation), displaced);
  }

  const affectedKeys = [
    ...windowRows.map((row) => reservationKey(row.reservation)),
    ...(absorb ? [reservationKey(absorb.reservation)] : []),
  ];

  const nextAssignments = draft.assignments.map((row) => {
    const key = reservationKey(row.reservation);
    const nextCaddy = nextByKey.get(key);
    if (!nextCaddy) return row;
    return {
      ...cloneRow(row),
      caddy: nextCaddy,
      reason: `DIRECT_EDIT_INSERT(${row.reason})`,
    };
  });

  const next = markEdited({
    ...draft,
    assignments: nextAssignments,
    sparesByShift: applySparesAfterTaking(
      draft,
      shift,
      caddy,
      absorb ? null : displaced
    ),
  });

  return {
    ok: true,
    action: "insert",
    draft: next,
    toast: `${caddy.name} 삽입`,
    affectedKeys,
  };
}

function swapDraft(
  draft: AssignmentDraft,
  keyA: string,
  keyB: string
): DirectCaddyEditResult {
  const result = swapAssignmentCaddies(draft, keyA, keyB);
  if (result.specialEditWarned && result.draft === draft) {
    return {
      ok: false,
      code: "DIRECT_EDIT_PROTECTED",
      message: DIRECT_EDIT_PROTECTED_MESSAGE,
    };
  }
  const blocking = result.warnings.find((w) => w.level === "error");
  if (blocking && result.draft === draft) {
    return {
      ok: false,
      code: blocking.code,
      message: blocking.message,
    };
  }
  const a = findTargetAssignment(result.draft, keyA);
  const b = findTargetAssignment(result.draft, keyB);
  return {
    ok: true,
    action: "swap",
    draft: result.draft,
    reservationKeyA: keyA,
    reservationKeyB: keyB,
    toast: `${a?.caddy.name || ""} ↔ ${b?.caddy.name || ""}`.trim(),
    affectedKeys: [keyA, keyB],
  };
}

export function applyDirectCaddyEdit(
  draft: AssignmentDraft,
  input: { reservationKey: string; caddyId: number }
): DirectCaddyEditResult {
  const resKey = String(input.reservationKey || "");
  const caddyId = Number(input.caddyId);
  if (!resKey) {
    return {
      ok: false,
      code: "RESERVATION_NOT_FOUND",
      message: DIRECT_EDIT_NOT_FOUND_MESSAGE,
    };
  }

  const assigned = findTargetAssignment(draft, resKey);
  const unassigned = assigned ? null : findUnassigned(draft, resKey);
  if (!assigned && !unassigned) {
    return {
      ok: false,
      code: "RESERVATION_NOT_FOUND",
      message: DIRECT_EDIT_NOT_FOUND_MESSAGE,
    };
  }

  if (assigned && isDirectEditProtected(assigned)) {
    return {
      ok: false,
      code: "DIRECT_EDIT_PROTECTED",
      message: DIRECT_EDIT_PROTECTED_MESSAGE,
    };
  }

  const caddy = findCaddyInDraft(draft, caddyId);
  if (!caddy) {
    return {
      ok: false,
      code: "CADDY_NOT_FOUND",
      message: DIRECT_EDIT_CADDY_NOT_FOUND_MESSAGE,
    };
  }
  if (!isOperationalPickerCaddy(caddy)) {
    return {
      ok: false,
      code: "NOT_OPERATIONAL",
      message: DIRECT_EDIT_NOT_OPERATIONAL_MESSAGE,
    };
  }

  if (assigned && assigned.caddy.id === caddy.id && !isDirectEditVacant(assigned)) {
    return {
      ok: true,
      action: "noop",
      draft,
      toast: "",
      affectedKeys: [resKey],
    };
  }

  const shift = assigned
    ? assignmentShift(assigned)
    : String(unassigned?.shift || "");
  const peer = sameShiftAssignedRow(draft, shift, caddy.id, resKey);

  if (peer) {
    if (isDirectEditProtected(peer)) {
      return {
        ok: false,
        code: "DIRECT_EDIT_PROTECTED",
        message: DIRECT_EDIT_PROTECTED_MESSAGE,
      };
    }
    if (unassigned) {
      const placed = placeOnUnassigned(draft, resKey, caddy);
      if (!placed.ok) return placed;
      const vacated = placed.draft.assignments.map((row) =>
        reservationKey(row.reservation) === reservationKey(peer.reservation)
          ? {
              ...cloneRow(row),
              caddy: { ...VACANT_CADDY_PLACEHOLDER },
              reason: `DIRECT_EDIT_VACATE(${row.reason})`,
            }
          : row
      );
      return {
        ...placed,
        draft: markEdited({ ...placed.draft, assignments: vacated }),
        affectedKeys: [resKey, reservationKey(peer.reservation)],
      };
    }
    return swapDraft(draft, resKey, reservationKey(peer.reservation));
  }

  if (unassigned) {
    return placeOnUnassigned(draft, resKey, caddy);
  }
  if (assigned && isDirectEditVacant(assigned)) {
    return placeOnVacantAssignment(draft, assigned, caddy);
  }
  if (assigned) {
    return insertSpareIntoRegularWindow(draft, assigned, caddy);
  }
  return {
    ok: false,
    code: "RESERVATION_NOT_FOUND",
    message: DIRECT_EDIT_NOT_FOUND_MESSAGE,
  };
}

export function groupDirectEditCandidates(
  candidates: readonly DirectEditCandidate[]
): Record<DirectEditCandidateGroup, DirectEditCandidate[]> {
  return {
    current: candidates.filter((c) => c.group === "current"),
    assigned: candidates.filter((c) => c.group === "assigned"),
    unassigned: candidates.filter((c) => c.group === "unassigned"),
  };
}
