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
  isPlacementLocked,
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
    default:
      return false;
  }
}

export type LiveChangeInput = {
  type: LiveChangeType;
  reservationKey?: string;
  reservationId?: string | number;
  caddyId?: number;
  reservationKeyA?: string;
  reservationKeyB?: string;
  addReservation?: AutoAssignReservation;
  limousineCart?: boolean;
  locked?: boolean;
  note?: string | null;
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
      return [
        {
          type: "REMOVE_CADDY",
          caddyId: input.caddyId,
          cause,
          note: input.note,
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
    });
  }

  return {
    date,
    dateObj,
    changeType: preview.changeType,
    cause: preview.reason,
    reservations,
    placements,
    unavailables,
    payload: {
      changeType: preview.changeType,
      reason: preview.reason,
      summary: preview.summary,
      warnings: preview.warnings,
      unavailableCaddyIds: preview.unavailableCaddyIds,
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
    },
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
  | "CLEAR_DRIVING" {
  return type;
}

function mapReservationStatus(
  status: PersistReservationRow["status"]
): "ACTIVE" | "CANCELLED" | "TEAM_NOSHOW" {
  return status;
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
        .filter(
          (row): row is NonNullable<typeof row> => row != null
        );
      if (placementData.length > 0) {
        await tx.dailyPlacement.createMany({ data: placementData });
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
      if (opts.updateOpsIfPresent) {
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
