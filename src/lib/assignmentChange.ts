/**
 * 현장 배치 변경 V1 — preview는 순수 함수(DB write 없음), apply만 영속.
 * 엔진 source of truth: reflowRegularAssignments → assignRegularSequence
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  buildConfirmPersistPlan,
  type ConfirmRequestBody,
} from "@/lib/assignmentConfirm";
import {
  applyLiveResultToDraft,
  autoResultFromDraft,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  isPlacementLocked,
  parseAssignShiftPart,
  reflowRegularAssignments,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type CaddyUnavailableCause,
  type ReflowWarning,
  type RegularReflowResult,
  type ReservationCancelCause,
  type ReservationChangeEvent,
} from "@/lib/autoAssignEngine";
import type { ShiftPart } from "@/lib/reservationParser";
import {
  isStableReservationMoveKey,
  parseMoveDestination,
  stableReservationMoveKeyFromId,
  summarizeReservationMove,
} from "@/lib/reservationMove";

export const LIVE_CHANGE_TYPES = [
  "CANCEL_RESERVATION",
  "TEAM_NOSHOW",
  "CADDY_SICK",
  "CADDY_ATTENDANCE_NOSHOW",
  "ADD_RESERVATION",
  "SWAP_CADDY",
  "SET_LIMOUSINE",
  "ASSIGN_DRIVING",
  "CLEAR_DRIVING",
  "SET_LOCK",
  "MOVE_RESERVATION",
] as const;

export type LiveChangeType = (typeof LIVE_CHANGE_TYPES)[number];

export const LIVE_CHANGE_LABELS: Record<LiveChangeType, string> = {
  CANCEL_RESERVATION: "예약 취소",
  TEAM_NOSHOW: "예약/팀 노쇼",
  CADDY_SICK: "캐디 병가",
  CADDY_ATTENDANCE_NOSHOW: "캐디 결근",
  ADD_RESERVATION: "당추(예약 추가)",
  SWAP_CADDY: "순번 바꿈",
  SET_LIMOUSINE: "리무진카트 요청",
  ASSIGN_DRIVING: "드라이빙 캐디 지정",
  CLEAR_DRIVING: "드라이빙 지정 해제",
  SET_LOCK: "LOCK 변경",
  MOVE_RESERVATION: "팀 이동",
};

export const LIVE_CHANGE_APPLY_USER_MESSAGE =
  "배치 저장 중 오류가 발생했습니다. 다시 시도해주세요.";

/** 보드 Quick Action에서 확인창 후 즉시 저장. 고급 배치 변경은 preview 유지. */
export const QUICK_ACTION_CONFIRM_TYPES: readonly LiveChangeType[] = [
  "CANCEL_RESERVATION",
  "TEAM_NOSHOW",
  "CADDY_SICK",
  "CADDY_ATTENDANCE_NOSHOW",
];

/** 보드에서 미리보기 없이 즉시 저장하는 Quick Action. */
export const QUICK_ACTION_INSTANT_TYPES: readonly LiveChangeType[] = [
  "SET_LIMOUSINE",
  "SET_LOCK",
  "SWAP_CADDY",
  "ASSIGN_DRIVING",
  "CLEAR_DRIVING",
];

export function needsQuickActionConfirm(type: LiveChangeType): boolean {
  return (QUICK_ACTION_CONFIRM_TYPES as readonly string[]).includes(type);
}

export function isInstantQuickAction(type: LiveChangeType): boolean {
  return (QUICK_ACTION_INSTANT_TYPES as readonly string[]).includes(type);
}

export function swapOrderToast(nameA: string, nameB: string): string {
  return `${nameA} ↔ ${nameB} 순번을 변경했습니다`;
}

export const QUICK_ACTION_CONFIRM_MESSAGE = "정말 적용하시겠습니까?";

/** 전체 날짜 delete/create 없이 patch 가능한 단순 Quick Action. */
export function isPatchableLiveChange(type: LiveChangeType): boolean {
  return (
    type === "SWAP_CADDY" || type === "SET_LOCK" || type === "SET_LIMOUSINE"
  );
}

/**
 * 예약 취소/팀 노쇼/병가/결근 — 한 row delete/patch 금지.
 * Quick Action과 고급 배치 변경 모두 reflowRegularAssignments가 source of truth.
 */
export const SEQUENCE_REFLOW_LIVE_CHANGE_TYPES: readonly LiveChangeType[] = [
  "CANCEL_RESERVATION",
  "TEAM_NOSHOW",
  "CADDY_SICK",
  "CADDY_ATTENDANCE_NOSHOW",
  "MOVE_RESERVATION",
];

export function isSequenceReflowLiveChange(type: LiveChangeType): boolean {
  return (SEQUENCE_REFLOW_LIVE_CHANGE_TYPES as readonly string[]).includes(type);
}

/** sequence reflow 액션은 서버 재계산 결과를 화면에 반영해야 한다. swap/lock/limo는 optimistic patch 유지. */
export function shouldReconcileLivePersist(type: LiveChangeType): boolean {
  return isSequenceReflowLiveChange(type);
}

export function skipsOpsRewriteOnLivePersist(type: LiveChangeType): boolean {
  return type === "SET_LOCK" || type === "SET_LIMOUSINE";
}

/** 보드 탭/프리셋이 이 조건을 충족하면 배치 다시 맞추기 없이 preview 계산. */
export function isLiveChangeReady(
  change: LiveChangeInput | null | undefined
): boolean {
  if (!change) return false;
  switch (change.type) {
    case "CANCEL_RESERVATION":
    case "TEAM_NOSHOW":
      return !!change.reservationKey || change.reservationId != null;
    case "CADDY_SICK":
    case "CADDY_ATTENDANCE_NOSHOW":
      return Number(change.caddyId) > 0;
    case "ADD_RESERVATION":
      return !!change.addReservation;
    case "SWAP_CADDY":
      return (
        !!change.reservationKeyA &&
        !!change.reservationKeyB &&
        change.reservationKeyA !== change.reservationKeyB
      );
    case "SET_LIMOUSINE":
    case "CLEAR_DRIVING":
    case "SET_LOCK":
      return !!change.reservationKey || change.reservationId != null;
    case "ASSIGN_DRIVING":
      return (
        (!!change.reservationKey || change.reservationId != null) &&
        Number(change.caddyId) > 0
      );
    case "MOVE_RESERVATION":
      return (
        (isStableReservationMoveKey(change.reservationKey) ||
          change.reservationId != null) &&
        !!parseMoveDestination(change.to)
      );
    default:
      return false;
  }
}

export type LiveChangeInput = {
  type: LiveChangeType;
  reservationKey?: string;
  reservationId?: string | number;
  caddyId?: number;
  /** 병가 클릭 부. CADDY_SICK에만 사용. 없으면 1부(종일). */
  shift?: ShiftPart;
  reservationKeyA?: string;
  reservationKeyB?: string;
  addReservation?: AutoAssignReservation;
  limousineCart?: boolean;
  locked?: boolean;
  note?: string | null;
  to?: {
    course: string;
    shift: string;
    teeTime: string;
    date?: string;
  };
};

export type LiveChangePreview = RegularReflowResult & {
  changeType: LiveChangeType;
  events: ReservationChangeEvent[];
};

export type PersistReservationRow = {
  identityKey: string;
  course: string;
  shift: string;
  teeTime: string;
  teamName: string | null;
  hole: number | null;
  source: string | null;
  status: "ACTIVE" | "CANCELLED" | "TEAM_NOSHOW";
  rawRowIndex: number | null;
  limousineCart: boolean;
};

export type PersistPlacementRow = {
  identityKey: string;
  caddyId: number;
  kind: string;
  reason: string | null;
  sequenceIndex: number;
  pairId: string | null;
  locked: boolean;
};

export type PersistUnavailableRow = {
  caddyId: number;
  reason: CaddyUnavailableCause;
  note: string | null;
  effectiveFromShift: ShiftPart | null;
};

export type LiveChangePersistPlan = {
  date: string;
  dateObj: Date;
  changeType: LiveChangeType;
  cause: string;
  reservations: PersistReservationRow[];
  placements: PersistPlacementRow[];
  unavailables: PersistUnavailableRow[];
  payload: Record<string, unknown>;
};

export type LiveChangeMemoryStore = {
  reservations: PersistReservationRow[];
  placements: PersistPlacementRow[];
  unavailables: PersistUnavailableRow[];
  changes: Array<{
    id: number;
    date: string;
    changeType: LiveChangeType;
    cause: string;
    payload: Record<string, unknown>;
  }>;
  /** employmentStatus / caddyType 회귀 검증용 (apply가 만지면 안 됨) */
  caddyEmployment: Map<number, string>;
  caddyTypes: Map<number, string>;
};

export function emptyLiveChangeMemoryStore(): LiveChangeMemoryStore {
  return {
    reservations: [],
    placements: [],
    unavailables: [],
    changes: [],
    caddyEmployment: new Map(),
    caddyTypes: new Map(),
  };
}

export function eventsFromLiveChange(
  input: LiveChangeInput
): ReservationChangeEvent[] {
  switch (input.type) {
    case "CANCEL_RESERVATION":
    case "TEAM_NOSHOW": {
      const cause: ReservationCancelCause =
        input.type === "TEAM_NOSHOW" ? "TEAM_NOSHOW" : "CANCEL";
      return [
        {
          type: "CANCEL_RESERVATION",
          cause,
          reservationKey: input.reservationKey,
          reservationId: input.reservationId,
        },
      ];
    }
    case "CADDY_SICK":
    case "CADDY_ATTENDANCE_NOSHOW": {
      const cause: CaddyUnavailableCause =
        input.type === "CADDY_SICK" ? "SICK" : "ATTENDANCE_NOSHOW";
      if (!input.caddyId) return [];
      const fromShift =
        input.type === "CADDY_SICK"
          ? parseAssignShiftPart(input.shift) ?? "1부"
          : "1부";
      return [
        {
          type: "REMOVE_CADDY",
          caddyId: input.caddyId,
          cause,
          note: input.note,
          fromShift,
        },
      ];
    }
    case "ADD_RESERVATION": {
      if (!input.addReservation) return [];
      return [{ type: "ADD_RESERVATION", reservation: input.addReservation }];
    }
    case "SWAP_CADDY": {
      if (!input.reservationKeyA || !input.reservationKeyB) return [];
      return [
        {
          type: "SWAP_CADDY",
          reservationKeyA: input.reservationKeyA,
          reservationKeyB: input.reservationKeyB,
        },
      ];
    }
    case "SET_LIMOUSINE": {
      if (!input.reservationKey && input.reservationId == null) return [];
      return [
        {
          type: "SET_LIMOUSINE",
          reservationKey: input.reservationKey,
          reservationId: input.reservationId,
          limousineCart: input.limousineCart === true,
        },
      ];
    }
    case "ASSIGN_DRIVING": {
      if (!input.reservationKey || !input.caddyId) return [];
      return [
        {
          type: "ASSIGN_DRIVING",
          reservationKey: input.reservationKey,
          caddyId: input.caddyId,
        },
      ];
    }
    case "CLEAR_DRIVING": {
      if (!input.reservationKey) return [];
      return [{ type: "CLEAR_DRIVING", reservationKey: input.reservationKey }];
    }
    case "SET_LOCK": {
      if (!input.reservationKey) return [];
      return [
        {
          type: "SET_LOCK",
          reservationKey: input.reservationKey,
          locked: input.locked === true,
        },
      ];
    }
    case "MOVE_RESERVATION": {
      const dest = parseMoveDestination(input.to);
      if (!dest) return [];
      const reservationKey =
        (isStableReservationMoveKey(input.reservationKey) &&
          input.reservationKey) ||
        (input.reservationId != null
          ? stableReservationMoveKeyFromId(input.reservationId)
          : null) ||
        input.reservationKey;
      if (
        !isStableReservationMoveKey(reservationKey) &&
        input.reservationId == null
      ) {
        return [
          {
            type: "MOVE_RESERVATION",
            reservationKey: input.reservationKey,
            reservationId: input.reservationId,
            to: dest,
          },
        ];
      }
      return [
        {
          type: "MOVE_RESERVATION",
          reservationKey: reservationKey || undefined,
          reservationId: input.reservationId,
          to: {
            course: dest.course,
            shift: dest.shift,
            teeTime: dest.teeTime,
            date: input.to?.date,
          },
        },
      ];
    }
    default:
      return [];
  }
}

/** preview 전용. prisma / writer 를 호출하지 않는다. */
export function previewLiveAssignmentChange(input: {
  previous: AutoAssignResultV1;
  regularCaddyPool: AutoAssignCaddy[];
  change: LiveChangeInput;
}): LiveChangePreview {
  const events = eventsFromLiveChange(input.change);
  const reflow = reflowRegularAssignments({
    previous: input.previous,
    regularCaddyPool: input.regularCaddyPool,
    events,
  });
  return {
    ...reflow,
    changeType: input.change.type,
    events,
  };
}

/** Quick Action / 고급 배치 변경이 같은 draft → reflow 경로를 타게 한다. */
export function previewLiveChangeFromDraft(input: {
  draft: AssignmentDraft;
  base?: AutoAssignResultV1 | null;
  change: LiveChangeInput;
}): LiveChangePreview {
  return previewLiveAssignmentChange({
    previous: autoResultFromDraft(input.draft, input.base ?? null),
    regularCaddyPool: input.draft.caddyPool,
    change: input.change,
  });
}

export function applyLiveChangePreviewToDraft(
  draft: AssignmentDraft,
  preview: LiveChangePreview
): AssignmentDraft {
  return applyLiveResultToDraft(draft, preview.after);
}

export type LiveBoardSnapshot = {
  placements: Array<{
    key: string;
    reservationId: string;
    teeTime: string;
    course: string;
    shift: string;
    caddyId: number;
    kind: string;
    locked: boolean;
    sequenceIndex: number;
  }>;
  spares: Array<{
    shift: string;
    spare1: number | null;
    spare2: number | null;
  }>;
  unassignedKeys: string[];
};

export function liveBoardSnapshot(result: AutoAssignResultV1): LiveBoardSnapshot {
  return {
    placements: [...result.assignments]
      .map((row) => ({
        key: reservationKey(row.reservation),
        reservationId: String(row.reservation.id ?? ""),
        teeTime: row.reservation.teeTime,
        course: String(row.reservation.course),
        shift: String(row.reservation.shift),
        caddyId: row.caddy.id,
        kind: row.kind,
        locked: isPlacementLocked(row),
        sequenceIndex: row.sequenceIndex,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    spares: [...(result.sparesByShift || [])]
      .map((row) => ({
        shift: String(row.shift),
        spare1: row.spare1?.caddyId ?? null,
        spare2: row.spare2?.caddyId ?? null,
      }))
      .sort((a, b) => a.shift.localeCompare(b.shift)),
    unassignedKeys: (result.unassignedReservations || [])
      .map((row) => reservationKey(row.reservation))
      .sort(),
  };
}

export function sameLiveBoard(
  a: AutoAssignResultV1,
  b: AutoAssignResultV1
): boolean {
  return JSON.stringify(liveBoardSnapshot(a)) === JSON.stringify(liveBoardSnapshot(b));
}

export function previewLiveAssignmentEvents(input: {
  previous: AutoAssignResultV1;
  regularCaddyPool: AutoAssignCaddy[];
  events: ReservationChangeEvent[];
  changeType?: LiveChangeType;
}): LiveChangePreview {
  const reflow = reflowRegularAssignments({
    previous: input.previous,
    regularCaddyPool: input.regularCaddyPool,
    events: input.events,
  });
  return {
    ...reflow,
    changeType: input.changeType || inferChangeType(input.events),
    events: input.events,
  };
}

function inferChangeType(events: ReservationChangeEvent[]): LiveChangeType {
  if (events.length === 1) {
    const e = events[0];
    if (e.type === "SWAP_CADDY") return "SWAP_CADDY";
    if (e.type === "SET_LIMOUSINE") return "SET_LIMOUSINE";
    if (e.type === "ASSIGN_DRIVING") return "ASSIGN_DRIVING";
    if (e.type === "CLEAR_DRIVING") return "CLEAR_DRIVING";
    if (e.type === "SET_LOCK") return "SET_LOCK";
    if (e.type === "MOVE_RESERVATION") return "MOVE_RESERVATION";
    if (e.type === "ADD_RESERVATION") return "ADD_RESERVATION";
    if (e.type === "REMOVE_CADDY") {
      return e.cause === "SICK" ? "CADDY_SICK" : "CADDY_ATTENDANCE_NOSHOW";
    }
    if (e.type === "CANCEL_RESERVATION") {
      return e.cause === "TEAM_NOSHOW" ? "TEAM_NOSHOW" : "CANCEL_RESERVATION";
    }
  }
  return "CANCEL_RESERVATION";
}

function reservationStatusForKey(
  key: string,
  before: AutoAssignResultV1,
  after: AutoAssignResultV1,
  changeType: LiveChangeType
): PersistReservationRow["status"] {
  const afterHas = after.assignments.some(
    (a) => reservationKey(a.reservation) === key
  );
  const afterUnassigned = (after.unassignedReservations || []).some(
    (u) => reservationKey(u.reservation) === key
  );
  if (afterHas || afterUnassigned) return "ACTIVE";
  const beforeHad =
    before.assignments.some((a) => reservationKey(a.reservation) === key) ||
    (before.unassignedReservations || []).some(
      (u) => reservationKey(u.reservation) === key
    );
  if (!beforeHad) return "ACTIVE";
  return changeType === "TEAM_NOSHOW" ? "TEAM_NOSHOW" : "CANCELLED";
}

export function buildLiveChangePersistPlan(
  preview: LiveChangePreview
): LiveChangePersistPlan {
  const { date } = preview;
  const { start: dateObj } = parseYmd(date);
  const seen = new Map<string, AutoAssignReservation>();
  for (const row of preview.before.assignments) {
    seen.set(reservationKey(row.reservation), row.reservation);
  }
  for (const u of preview.before.unassignedReservations || []) {
    seen.set(reservationKey(u.reservation), u.reservation);
  }
  for (const row of preview.after.assignments) {
    seen.set(reservationKey(row.reservation), row.reservation);
  }
  for (const u of preview.after.unassignedReservations || []) {
    seen.set(reservationKey(u.reservation), u.reservation);
  }

  const reservations: PersistReservationRow[] = [...seen.entries()].map(
    ([identityKey, r]) => ({
      identityKey,
      course: r.course,
      shift: String(r.shift),
      teeTime: r.teeTime,
      teamName: r.teamName ?? null,
      hole: r.hole ?? r.startingHole ?? null,
      source: r.sourceSheet ?? null,
      status: reservationStatusForKey(
        identityKey,
        preview.before,
        preview.after,
        preview.changeType
      ),
      rawRowIndex: r.rawRowIndex ?? null,
      limousineCart: r.limousineCart === true,
    })
  );

  const placements: PersistPlacementRow[] = preview.after.assignments.map(
    (row) => ({
      identityKey: reservationKey(row.reservation),
      caddyId: row.caddy.id,
      kind: row.kind,
      reason: row.reason ?? null,
      sequenceIndex: row.sequenceIndex,
      pairId: row.pairId ?? null,
      locked: isPlacementLocked(row),
    })
  );

  const unavailables: PersistUnavailableRow[] = [];
  for (const event of preview.events) {
    if (event.type !== "REMOVE_CADDY") continue;
    unavailables.push({
      caddyId: event.caddyId,
      reason: event.cause,
      note: event.note ?? null,
      effectiveFromShift:
        event.cause === "SICK" ? event.fromShift ?? "1부" : null,
    });
  }

  const payload: Record<string, unknown> = {
    changeType: preview.changeType,
    reason: preview.reason,
    summary: preview.summary,
    warnings: preview.warnings,
    unavailableCaddyIds: preview.unavailableCaddyIds,
    effectiveFromShift: unavailables.map((u) => ({
      caddyId: u.caddyId,
      effectiveFromShift: u.effectiveFromShift,
    })),
    sparesByShift: preview.after.sparesByShift,
    lockedPreserved: preview.lockedPreserved,
    placementDiffs: preview.placementDiffs.map((d) => ({
      reservationKey: d.reservationKey,
      beforeCaddyId: d.beforeCaddy?.id ?? null,
      afterCaddyId: d.afterCaddy?.id ?? null,
      lockedPreserved: d.lockedPreserved,
      course: d.reservation.course,
      teeTime: d.reservation.teeTime,
      shift: d.reservation.shift,
    })),
  };

  if (preview.changeType === "MOVE_RESERVATION") {
    const event = preview.events.find((e) => e.type === "MOVE_RESERVATION");
    const move =
      event && event.type === "MOVE_RESERVATION"
        ? summarizeReservationMove({
            before: preview.before,
            after: preview.after,
            event,
            warnings: preview.warnings,
            placementDiffs: preview.placementDiffs,
          })
        : null;
    if (move) {
      payload.move = {
        reservationId: move.reservationId,
        reservationKey: move.reservationKey,
        from: move.from,
        to: move.to,
        placementChangeCount: move.placementChangeCount,
        freezeShifts: move.freezeShifts,
        reflowShifts: move.reflowShifts,
        beforeCaddyId: move.beforeCaddy?.id ?? null,
        afterCaddyId: move.afterCaddy?.id ?? null,
        sameCaddyBySequence: move.sameCaddyBySequence,
        caddyFollowsTeam: false,
      };
    }
  }

  return {
    date,
    dateObj,
    changeType: preview.changeType,
    cause: preview.reason,
    reservations,
    placements,
    unavailables,
    payload,
  };
}

/** 테스트/미리보기용 in-memory apply. Caddy.employmentStatus는 절대 변경하지 않음. */
export function applyLiveChangeToMemory(
  store: LiveChangeMemoryStore,
  plan: LiveChangePersistPlan
): { changeId: number } {
  const employmentBefore = new Map(store.caddyEmployment);
  const typesBefore = new Map(store.caddyTypes);
  store.reservations = plan.reservations.map((r) => ({ ...r }));
  store.placements = plan.placements.map((p) => ({ ...p }));
  const byCaddy = new Map(store.unavailables.map((u) => [u.caddyId, u]));
  for (const u of plan.unavailables) byCaddy.set(u.caddyId, { ...u });
  store.unavailables = [...byCaddy.values()];
  const changeId = store.changes.length + 1;
  store.changes.push({
    id: changeId,
    date: plan.date,
    changeType: plan.changeType,
    cause: plan.cause,
    payload: plan.payload,
  });
  store.caddyEmployment = employmentBefore;
  store.caddyTypes = typesBefore;
  return { changeId };
}

export type ApplyLiveChangeResult =
  | {
      ok: true;
      changeId: number;
      date: string;
      opsUpdated: boolean;
      duplicate?: boolean;
      preview: LiveChangePreview;
    }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      message: string;
      warnings?: ReflowWarning[];
    };

function mapUnavailableReason(
  reason: CaddyUnavailableCause
): "SICK" | "ATTENDANCE_NOSHOW" {
  return reason === "SICK" ? "SICK" : "ATTENDANCE_NOSHOW";
}

function mapChangeType(
  type: Exclude<LiveChangeType, "SET_LOCK">
):
  | "CANCEL_RESERVATION"
  | "TEAM_NOSHOW"
  | "CADDY_SICK"
  | "CADDY_ATTENDANCE_NOSHOW"
  | "ADD_RESERVATION"
  | "SWAP_CADDY"
  | "SET_LIMOUSINE"
  | "ASSIGN_DRIVING"
  | "CLEAR_DRIVING"
  | "MOVE_RESERVATION" {
  return type;
}

export class LiveChangePersistError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "LiveChangePersistError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function numericMoveReservationId(
  event: Extract<ReservationChangeEvent, { type: "MOVE_RESERVATION" }>
): number | null {
  const raw =
    event.reservationId != null && String(event.reservationId) !== ""
      ? String(event.reservationId)
      : isStableReservationMoveKey(event.reservationKey)
        ? String(event.reservationKey).slice(3)
        : "";
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function persistMovedReservationDay(
  tx: Prisma.TransactionClient,
  plan: LiveChangePersistPlan,
  preview: LiveChangePreview
): Promise<void> {
  const event = preview.events.find((e) => e.type === "MOVE_RESERVATION");
  if (!event || event.type !== "MOVE_RESERVATION") {
    throw new LiveChangePersistError(
      "MOVE_NOT_FOUND",
      "이동할 예약을 찾을 수 없습니다."
    );
  }
  const dest = parseMoveDestination(event.to);
  if (!dest) {
    throw new LiveChangePersistError(
      "MOVE_BAD_DESTINATION",
      "목적 코스·부·티타임을 확인하세요."
    );
  }
  if (event.to.date && String(event.to.date) !== plan.date) {
    throw new LiveChangePersistError(
      "MOVE_DATE_CHANGE",
      "다른 날짜로는 이동할 수 없습니다."
    );
  }

  const existing = await tx.dailyReservation.findMany({
    where: { date: plan.dateObj },
  });
  const numericId = numericMoveReservationId(event);
  const source =
    (numericId != null ? existing.find((row) => row.id === numericId) : null) ||
    (isStableReservationMoveKey(event.reservationKey)
      ? existing.find((row) => row.identityKey === event.reservationKey)
      : null) ||
    existing.find(
      (row) =>
        numericId != null && row.identityKey === `id:${numericId}`
    );

  if (!source) {
    throw new LiveChangePersistError(
      "MOVE_NOT_FOUND",
      "이동할 예약을 찾을 수 없습니다."
    );
  }
  if (source.status !== "ACTIVE") {
    throw new LiveChangePersistError(
      "MOVE_SOURCE_INACTIVE",
      "취소/노쇼 예약은 이동할 수 없습니다."
    );
  }
  if (
    source.course === dest.course &&
    source.shift === dest.shift &&
    source.teeTime === dest.teeTime
  ) {
    throw new LiveChangePersistError(
      "MOVE_SAME_SLOT",
      "목적지가 현재 위치와 같습니다."
    );
  }
  const collision = existing.find(
    (row) =>
      row.id !== source.id &&
      row.status === "ACTIVE" &&
      row.course === dest.course &&
      row.shift === dest.shift &&
      row.teeTime === dest.teeTime
  );
  if (collision) {
    throw new LiveChangePersistError(
      "DUPLICATE_COURSE_TEETIME",
      `해당 코스/티타임에 이미 예약이 있습니다 (${collision.course} ${collision.teeTime}).`
    );
  }

  await tx.dailyReservation.update({
    where: { id: source.id },
    data: {
      course: dest.course,
      shift: dest.shift,
      teeTime: dest.teeTime,
    },
  });

  const byId = new Map(existing.map((row) => [row.id, row]));
  const byIdentity = new Map(existing.map((row) => [row.identityKey, row]));
  const resolveExistingId = (identityKey: string): number | null => {
    if (identityKey.startsWith("id:")) {
      const n = Number(identityKey.slice(3));
      if (Number.isInteger(n) && byId.has(n)) return n;
    }
    return byIdentity.get(identityKey)?.id ?? null;
  };

  await tx.dailyPlacement.deleteMany({ where: { date: plan.dateObj } });
  const placementData = plan.placements
    .map((row) => {
      const reservationId = resolveExistingId(row.identityKey);
      if (!reservationId) return null;
      return {
        date: plan.dateObj,
        reservationId,
        caddyId: row.caddyId,
        kind: row.kind,
        reason: row.reason,
        sequenceIndex: row.sequenceIndex,
        pairId: row.pairId,
        locked: row.locked,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
  if (placementData.length > 0) {
    await tx.dailyPlacement.createMany({ data: placementData });
  }
}

function mapReservationStatus(
  status: PersistReservationRow["status"]
): "ACTIVE" | "CANCELLED" | "TEAM_NOSHOW" {
  return status;
}

async function tryPatchLiveDay(
  tx: Prisma.TransactionClient,
  plan: LiveChangePersistPlan,
  preview: LiveChangePreview
): Promise<boolean> {
  // 예약취소/노쇼/병가/결근은 1–2 row patch 금지. reflow persist만 허용.
  if (isSequenceReflowLiveChange(plan.changeType)) return false;
  if (!isPatchableLiveChange(plan.changeType)) return false;
  const existing = await tx.dailyReservation.count({
    where: { date: plan.dateObj },
  });
  if (existing === 0) return false;

  const findReservationId = async (identityKey: string) => {
    const row = await tx.dailyReservation.findUnique({
      where: {
        date_identityKey: { date: plan.dateObj, identityKey },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  };

  if (plan.changeType === "SET_LIMOUSINE") {
    const event = preview.events.find((e) => e.type === "SET_LIMOUSINE");
    const key = event && "reservationKey" in event ? event.reservationKey : "";
    if (!key) return false;
    const row = plan.reservations.find((r) => r.identityKey === key);
    if (!row) return false;
    const id = await findReservationId(key);
    if (id == null) return false;
    await tx.dailyReservation.update({
      where: { id },
      data: { limousineCart: row.limousineCart },
    });
    return true;
  }

  if (plan.changeType === "SET_LOCK") {
    const event = preview.events.find((e) => e.type === "SET_LOCK");
    const key = event && "reservationKey" in event ? event.reservationKey : "";
    if (!key) return false;
    const placement = plan.placements.find((p) => p.identityKey === key);
    if (!placement) return false;
    const reservationId = await findReservationId(key);
    if (reservationId == null) return false;
    await tx.dailyPlacement.update({
      where: { reservationId },
      data: { locked: placement.locked },
    });
    return true;
  }

  if (plan.changeType === "SWAP_CADDY") {
    const event = preview.events.find((e) => e.type === "SWAP_CADDY");
    if (!event || event.type !== "SWAP_CADDY") return false;
    const keys = [event.reservationKeyA, event.reservationKeyB];
    for (const key of keys) {
      const placement = plan.placements.find((p) => p.identityKey === key);
      const reservationId = await findReservationId(key);
      if (!placement || reservationId == null) return false;
      await tx.dailyPlacement.update({
        where: { reservationId },
        data: {
          caddyId: placement.caddyId,
          kind: placement.kind,
          reason: placement.reason,
          sequenceIndex: placement.sequenceIndex,
          pairId: placement.pairId,
          locked: placement.locked,
        },
      });
    }
    return true;
  }

  return false;
}

async function writePlanWithPrisma(
  db: PrismaClient,
  plan: LiveChangePersistPlan,
  preview: LiveChangePreview,
  opts: { ip?: string | null; updateOpsIfPresent?: boolean }
): Promise<{ changeId: number; opsUpdated: boolean }> {
  // 계산은 이미 plan에 완료. tx 안에서는 날짜 단위 delete + createMany 몇 번만.
  // 244건을 하나씩 create 하면 Prisma interactive tx(기본 5s)가 닫혀
  // "Transaction not found / Transaction ID is invalid" 가 난다.
  return db.$transaction(
    async (tx) => {
      const patched = await tryPatchLiveDay(tx, plan, preview);
      if (!patched) {
        if (plan.changeType === "MOVE_RESERVATION") {
          await persistMovedReservationDay(tx, plan, preview);
        } else {
        await tx.dailyPlacement.deleteMany({ where: { date: plan.dateObj } });
        await tx.dailyReservation.deleteMany({ where: { date: plan.dateObj } });

        const reservationData = plan.reservations.map((row) => ({
          date: plan.dateObj,
          course: row.course,
          shift: row.shift,
          teeTime: row.teeTime,
          teamName: row.teamName,
          hole: row.hole,
          source: row.source,
          status: mapReservationStatus(row.status),
          identityKey: row.identityKey,
          rawRowIndex: row.rawRowIndex,
          limousineCart: row.limousineCart,
        }));
        const createdRows =
          reservationData.length > 0
            ? await tx.dailyReservation.createManyAndReturn({
                data: reservationData,
                select: { id: true, identityKey: true },
              })
            : [];
        const created = new Map(
          createdRows.map((row) => [row.identityKey, row.id])
        );

        const placementData = plan.placements
          .map((row) => {
            const reservationId = created.get(row.identityKey);
            if (!reservationId) return null;
            return {
              date: plan.dateObj,
              reservationId,
              caddyId: row.caddyId,
              kind: row.kind,
              reason: row.reason,
              sequenceIndex: row.sequenceIndex,
              pairId: row.pairId,
              locked: row.locked,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row != null);
        if (placementData.length > 0) {
          await tx.dailyPlacement.createMany({ data: placementData });
        }
        }
      }

      if (plan.unavailables.length > 0) {
        const unavailableIds = plan.unavailables.map((row) => row.caddyId);
        await tx.dailyCaddyUnavailable.deleteMany({
          where: { date: plan.dateObj, caddyId: { in: unavailableIds } },
        });
        await tx.dailyCaddyUnavailable.createMany({
          data: plan.unavailables.map((row) => ({
            date: plan.dateObj,
            caddyId: row.caddyId,
            reason: mapUnavailableReason(row.reason),
            note: row.note,
            effectiveFromShift: row.effectiveFromShift,
          })),
        });
      }

      let changeId: number;
      if (plan.changeType === "SET_LOCK") {
        const audit = await tx.audit.create({
          data: {
            action: "ASSIGNMENTS_SET_LOCK",
            entity: "DailyPlacement",
            entityId: 0,
            ip: opts.ip || null,
            payload: {
              date: plan.date,
              changeType: plan.changeType,
              cause: plan.cause,
            },
          },
        });
        changeId = audit.id;
      } else {
        const change = await tx.dailyAssignmentChange.create({
          data: {
            date: plan.dateObj,
            changeType: mapChangeType(plan.changeType),
            cause: plan.cause,
            payload: plan.payload as Prisma.InputJsonValue,
          },
        });
        changeId = change.id;
        await tx.audit.create({
          data: {
            action: "ASSIGNMENTS_LIVE_CHANGE",
            entity: "DailyAssignmentChange",
            entityId: change.id,
            ip: opts.ip || null,
            payload: {
              date: plan.date,
              changeType: plan.changeType,
              cause: plan.cause,
              changeId: change.id,
            },
          },
        });
      }

      let opsUpdated = false;
      if (
        opts.updateOpsIfPresent &&
        !skipsOpsRewriteOnLivePersist(plan.changeType)
      ) {
        const existing = await tx.shiftDuty.count({
          where: { date: plan.dateObj },
        });
        if (existing > 0 && preview.after.assignments.length > 0) {
          const body: ConfirmRequestBody = {
            status: "CONFIRMED",
            date: plan.date,
            assignments: preview.after.assignments,
            replace: true,
          };
          const opsPlan = buildConfirmPersistPlan(body);
          await tx.shiftDuty.deleteMany({ where: { date: plan.dateObj } });
          await tx.schedule.deleteMany({ where: { date: plan.dateObj } });
          await tx.scheduleExtraTag.deleteMany({ where: { date: plan.dateObj } });
          if (opsPlan.schedules.length > 0) {
            await tx.schedule.createMany({ data: opsPlan.schedules });
          }
          if (opsPlan.shiftDuties.length > 0) {
            await tx.shiftDuty.createMany({ data: opsPlan.shiftDuties });
          }
          if (opsPlan.extraTags.length > 0) {
            await tx.scheduleExtraTag.createMany({ data: opsPlan.extraTags });
          }
          opsUpdated = true;
        }
      }

      return { changeId, opsUpdated };
    },
    {
      maxWait: 10_000,
      timeout: 20_000,
    }
  );
}

export async function applyLiveAssignmentChange(
  input: {
    previous: AutoAssignResultV1;
    regularCaddyPool: AutoAssignCaddy[];
    change?: LiveChangeInput;
    events?: ReservationChangeEvent[];
    changeType?: LiveChangeType;
  },
  options: {
    prisma?: PrismaClient;
    ip?: string | null;
    updateOpsIfPresent?: boolean;
    /** 테스트 전용 in-memory writer. 있으면 prisma를 호출하지 않음. */
    memory?: LiveChangeMemoryStore;
  } = {}
): Promise<ApplyLiveChangeResult> {
  const events =
    input.events ||
    (input.change ? eventsFromLiveChange(input.change) : []);
  if (events.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: "EMPTY_EVENTS",
      message: "변경 이벤트가 없습니다.",
    };
  }

  const preview = previewLiveAssignmentEvents({
    previous: input.previous,
    regularCaddyPool: input.regularCaddyPool,
    events,
    changeType: input.changeType || input.change?.type,
  });
  const blocking = preview.warnings.filter((w) => w.level === "error");
  if (blocking.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      code: blocking[0].code,
      message: blocking[0].message,
      warnings: preview.warnings,
    };
  }

  const plan = buildLiveChangePersistPlan(preview);

  if (options.memory) {
    const { changeId } = applyLiveChangeToMemory(options.memory, plan);
    return {
      ok: true,
      changeId,
      date: plan.date,
      opsUpdated: false,
      preview,
    };
  }

  const db = options.prisma ?? defaultPrisma;
  try {
    const written = await writePlanWithPrisma(db, plan, preview, {
      ip: options.ip,
      updateOpsIfPresent: options.updateOpsIfPresent !== false,
    });
    return {
      ok: true,
      changeId: written.changeId,
      date: plan.date,
      opsUpdated: written.opsUpdated,
      preview,
    };
  } catch (e: unknown) {
    if (e instanceof LiveChangePersistError) {
      return {
        ok: false,
        httpStatus: e.httpStatus,
        code: e.code,
        message: e.message,
      };
    }
    console.error("[applyLiveAssignmentChange]", e);
    return {
      ok: false,
      httpStatus: 500,
      code: "APPLY_FAILED",
      message: LIVE_CHANGE_APPLY_USER_MESSAGE,
    };
  }
}

export function makeAddReservation(input: {
  date: string;
  course: string;
  shift: ShiftPart | string;
  teeTime: string;
  teamName?: string | null;
}): AutoAssignReservation {
  const teeTime = String(input.teeTime || "").trim();
  const course = String(input.course || "").trim().toUpperCase();
  const shift = input.shift;
  return {
    id: `add:${input.date}:${course}:${shift}:${teeTime}`,
    date: input.date,
    course,
    shift,
    teeTime,
    teamName: input.teamName ?? "당추",
    sourceSheet: "MANUAL_ADD",
  };
}

/** 빈 보드 칸/당추 추가 폼 → 기존 ADD_RESERVATION LiveChange 입력. */
export function makeAddReservationChange(input: {
  date: string;
  course: string;
  shift: ShiftPart | string;
  teeTime: string;
  teamName?: string | null;
}): LiveChangeInput {
  return {
    type: "ADD_RESERVATION",
    addReservation: makeAddReservation(input),
  };
}

export function makeMoveReservationChange(input: {
  reservationKey?: string;
  reservationId?: string | number;
  to: { course: string; shift: string; teeTime: string; date?: string };
}): LiveChangeInput {
  return {
    type: "MOVE_RESERVATION",
    reservationKey: input.reservationKey,
    reservationId: input.reservationId,
    to: input.to,
  };
}

/** 빈 보드 칸: 이동 모드면 목적지, 아니면 당추. */
export function changeFromEmptyBoardCell(input: {
  date: string;
  course: string;
  shift: ShiftPart | string;
  teeTime: string;
  teamName?: string | null;
  moveReservationKey?: string | null;
}): LiveChangeInput {
  if (input.moveReservationKey) {
    return makeMoveReservationChange({
      reservationKey: input.moveReservationKey,
      to: {
        course: input.course,
        shift: String(input.shift),
        teeTime: input.teeTime,
      },
    });
  }
  return makeAddReservationChange({
    date: input.date,
    course: input.course,
    shift: input.shift,
    teeTime: input.teeTime,
    teamName: input.teamName,
  });
}

export function hasBlockingLiveChangeError(
  warnings: ReflowWarning[] | undefined | null
): boolean {
  return (warnings || []).some((w) => w.level === "error");
}
