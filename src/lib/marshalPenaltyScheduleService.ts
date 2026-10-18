/**
 * P3 벌당 근무일 Preview/Apply. 다른 벌당 날짜는 고정하고 from/to 이틀만 고친다.
 * 월 전체 순번 재계산은 하지 않는다. autoAssignEngine 은 건드리지 않는다.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MARSHAL_AUDIT_ACTIONS,
  MarshalRosterError,
  formatMarshalYmd,
  parsePositiveId,
} from "@/lib/marshalDomain";
import { isYmdInMonth } from "@/lib/marshalRotationDomain";
import {
  loadActiveMembers,
  loadDayStatuses,
} from "@/lib/marshalRotationService";
import {
  lockMonthPlanRow,
  lockOccurrenceTargetMonth,
} from "@/lib/marshalPenaltyOccurrenceService";
import {
  assertOccurrenceDayFree,
  assertPinnedDateInTargetMonth,
  assertPinnedDateStatus,
  assertPreviewToken,
  assertScheduleTargetMutable,
  makeSchedulePreviewToken,
  overlaySlotPatches,
  parsePinnedOn,
  planLocalFullDayMove,
  scheduleSourceOf,
  type ScheduleSlotSnapshot,
} from "@/lib/marshalPenaltyScheduleDomain";

type DbClient = PrismaClient | Prisma.TransactionClient;

type ScheduleActor = {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
};

const SLOT_SELECT = {
  id: true,
  date: true,
  shift: true,
  slotIndex: true,
  caddyId: true,
  marshalProfileId: true,
  source: true,
  originalCaddyId: true,
  note: true,
} as const;

function auditRow(input: {
  action: string;
  entityId: number;
  ip?: string | null;
  payload: Record<string, unknown>;
}): Prisma.AuditCreateInput {
  return {
    action: input.action,
    entity: "MarshalPenaltyOccurrence",
    entityId: input.entityId,
    ip: input.ip || null,
    payload: input.payload as Prisma.InputJsonValue,
  };
}

function dayPreview(
  slots: readonly ScheduleSlotSnapshot[],
  names: ReadonlyMap<number, string>
) {
  return [...slots]
    .sort((a, b) => {
      if (a.shift !== b.shift) return a.shift === "AM" ? -1 : 1;
      return a.slotIndex - b.slotIndex;
    })
    .map((slot) => ({
      id: slot.id,
      shift: slot.shift,
      slotIndex: slot.slotIndex,
      caddyId: slot.caddyId,
      source: slot.source,
      name: names.get(slot.caddyId) ?? null,
      warning: slot.note,
    }));
}

function snapshotSlot(slot: {
  id: number;
  date: Date;
  shift: string;
  slotIndex: number;
  caddyId: number;
  marshalProfileId: number;
  source: string;
  originalCaddyId: number | null;
  note: string | null;
}): ScheduleSlotSnapshot {
  return {
    id: slot.id,
    date: formatMarshalYmd(slot.date),
    shift: slot.shift === "PM" ? "PM" : "AM",
    slotIndex: slot.slotIndex,
    caddyId: slot.caddyId,
    profileId: slot.marshalProfileId,
    source: slot.source,
    originalCaddyId: slot.originalCaddyId,
    note: slot.note,
  };
}

function tokenPayload(input: {
  occurrence: {
    id: number;
    updatedAt: Date;
    pinnedOn: Date | null;
    scheduledOn: Date | null;
    status: string;
  };
  plan: {
    id: number;
    updatedAt: Date;
    generatedAt: Date | null;
    needsRegeneration: boolean;
    status: string;
  } | null;
  slots: { id: number; date: Date; shift: string; slotIndex: number; caddyId: number; source: string }[];
  duties: { date: Date; caddyId: number }[];
  occurrences: {
    id: number;
    status: string;
    scheduledOn: Date | null;
    pinnedOn: Date | null;
    autoHeldOn: Date | null;
  }[];
}) {
  return {
    occurrenceId: input.occurrence.id,
    occurrenceUpdatedAt: input.occurrence.updatedAt.toISOString(),
    pinnedOn: input.occurrence.pinnedOn ? formatMarshalYmd(input.occurrence.pinnedOn) : null,
    scheduledOn: input.occurrence.scheduledOn
      ? formatMarshalYmd(input.occurrence.scheduledOn)
      : null,
    status: input.occurrence.status,
    plan: input.plan
      ? {
          id: input.plan.id,
          updatedAt: input.plan.updatedAt.toISOString(),
          generatedAt: input.plan.generatedAt?.toISOString() ?? null,
          needsRegeneration: input.plan.needsRegeneration,
          status: input.plan.status,
        }
      : null,
    slots: input.slots.map((slot) => ({
      id: slot.id,
      date: formatMarshalYmd(slot.date),
      shift: slot.shift,
      slotIndex: slot.slotIndex,
      caddyId: slot.caddyId,
      source: slot.source,
    })),
    duties: input.duties.map((row) => ({
      date: formatMarshalYmd(row.date),
      caddyId: row.caddyId,
    })),
    occurrences: input.occurrences.map((row) => ({
      id: row.id,
      status: row.status,
      scheduledOn: row.scheduledOn ? formatMarshalYmd(row.scheduledOn) : null,
      pinnedOn: row.pinnedOn ? formatMarshalYmd(row.pinnedOn) : null,
      autoHeldOn: row.autoHeldOn ? formatMarshalYmd(row.autoHeldOn) : null,
    })),
  };
}

async function buildSchedulePreview(
  tx: DbClient,
  input: { id: number; date: string; confirmOff?: boolean; forApply: boolean }
) {
  const occurrence = await tx.marshalPenaltyOccurrence.findUnique({
    where: { id: input.id },
    include: { caddy: { select: { id: true, name: true, team: true } } },
  });
  if (!occurrence) {
    throw new MarshalRosterError(
      "벌당 발생을 찾을 수 없습니다.",
      "occurrence_not_found",
      404
    );
  }
  if (occurrence.status === "CANCELLED") {
    throw new MarshalRosterError(
      "취소된 벌당의 날짜는 변경할 수 없습니다.",
      "occurrence_cancelled",
      409
    );
  }
  assertPinnedDateInTargetMonth({
    date: input.date,
    year: occurrence.targetYear,
    month: occurrence.targetMonth,
  });
  await lockOccurrenceTargetMonth(tx, occurrence.targetYear, occurrence.targetMonth);
  const planIdRow = await tx.marshalMonthPlan.findUnique({
    where: {
      year_month: { year: occurrence.targetYear, month: occurrence.targetMonth },
    },
    select: { id: true },
  });
  if (planIdRow) await lockMonthPlanRow(tx, planIdRow.id);
  const plan = planIdRow
    ? await tx.marshalMonthPlan.findUnique({
        where: { id: planIdRow.id },
        include: {
          slots: {
            select: SLOT_SELECT,
            orderBy: [{ date: "asc" }, { shift: "asc" }, { slotIndex: "asc" }],
          },
          penalties: { select: { date: true, caddyId: true } },
        },
      })
    : null;
  const lockedPlan = plan
    ? {
        id: plan.id,
        status: plan.status,
        updatedAt: plan.updatedAt,
        generatedAt: plan.generatedAt,
        needsRegeneration: plan.needsRegeneration,
        amSlotsPerDay: plan.amSlotsPerDay,
        pmSlotsPerDay: plan.pmSlotsPerDay,
      }
    : null;
  assertScheduleTargetMutable(lockedPlan?.status);
  const monthOccurrences = await tx.marshalPenaltyOccurrence.findMany({
    where: {
      targetYear: occurrence.targetYear,
      targetMonth: occurrence.targetMonth,
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      caddyId: true,
      status: true,
      scheduledOn: true,
      pinnedOn: true,
      autoHeldOn: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const occupied = monthOccurrences.map((row) => ({
    id: row.id,
    date: row.scheduledOn
      ? formatMarshalYmd(row.scheduledOn)
      : row.pinnedOn
        ? formatMarshalYmd(row.pinnedOn)
        : null,
  }));
  assertOccurrenceDayFree({
    date: input.date,
    movingId: occurrence.id,
    occupied,
  });
  const dutyClash = (plan?.penalties || []).some(
    (row) => formatMarshalYmd(row.date) === input.date
  );
  if (dutyClash) {
    throw new MarshalRosterError(
      "같은 날짜에 다른 벌당이 있습니다.",
      "date_taken",
      409
    );
  }

  const members = await loadActiveMembers(tx);
  const statusByDateCaddy = await loadDayStatuses(
    tx,
    occurrence.targetYear,
    occurrence.targetMonth,
    members
  );
  const dayStatus = statusByDateCaddy.get(`${input.date}:${occurrence.caddyId}`);
  const requiresOffConfirm = dayStatus?.kind === "off_conflict";
  if (dayStatus?.kind === "hard_skip") {
    assertPinnedDateStatus({
      kind: dayStatus.kind,
      message: dayStatus.message,
    });
  }
  if (input.forApply) {
    assertPinnedDateStatus({
      kind: dayStatus?.kind,
      message: dayStatus?.message,
      confirmOff: input.confirmOff,
    });
  }

  const fromDate = occurrence.scheduledOn
    ? formatMarshalYmd(occurrence.scheduledOn)
    : null;
  const slotsDeferred = Boolean(
    lockedPlan?.generatedAt && lockedPlan.needsRegeneration
  );
  const canApplySlots = Boolean(
    lockedPlan?.generatedAt && !lockedPlan.needsRegeneration
  );
  if (occurrence.status === "SCHEDULED" && lockedPlan?.needsRegeneration) {
    throw new MarshalRosterError(
      "벌당이 변경되어 월표를 다시 생성해야 합니다.",
      "regeneration_required",
      409
    );
  }

  const fromSlots = (plan?.slots || [])
    .filter((slot) => formatMarshalYmd(slot.date) === fromDate)
    .map(snapshotSlot);
  const toSlots = (plan?.slots || [])
    .filter((slot) => formatMarshalYmd(slot.date) === input.date)
    .map(snapshotSlot);

  let move: ReturnType<typeof planLocalFullDayMove> | null = null;
  if (canApplySlots && (fromDate !== input.date || occurrence.status === "OPEN")) {
    move = planLocalFullDayMove({
      fromDate: occurrence.status === "SCHEDULED" ? fromDate : null,
      toDate: input.date,
      moving: {
        caddyId: occurrence.caddyId,
        profileId: occurrence.marshalProfileId,
      },
      fromSlots,
      toSlots,
      members,
      statusByDateCaddy,
      offWarning: requiresOffConfirm,
    });
  }

  const previewToken = makeSchedulePreviewToken(
    tokenPayload({
      occurrence,
      plan: lockedPlan && plan
        ? {
            id: plan.id,
            updatedAt: lockedPlan.updatedAt,
            generatedAt: lockedPlan.generatedAt,
            needsRegeneration: lockedPlan.needsRegeneration,
            status: lockedPlan.status,
          }
        : null,
      slots: plan?.slots || [],
      duties: plan?.penalties || [],
      occurrences: monthOccurrences,
    })
  );

  const otherOccurrences = monthOccurrences
    .filter((row) => row.id !== occurrence.id)
    .map((row) => ({
      id: row.id,
      caddyId: row.caddyId,
      scheduledOn: row.scheduledOn ? formatMarshalYmd(row.scheduledOn) : null,
      pinnedOn: row.pinnedOn ? formatMarshalYmd(row.pinnedOn) : null,
      unchanged: true,
    }));

  const names = new Map(members.map((row) => [row.caddyId, row.name]));
  const fromAfter = move
    ? overlaySlotPatches(fromSlots, move.fromUpdates)
    : fromSlots;
  const toAfter = move ? overlaySlotPatches(toSlots, move.toUpdates) : toSlots;
  return {
    occurrence,
    plan,
    lockedPlan,
    preview: {
      occurrenceId: occurrence.id,
      caddyId: occurrence.caddyId,
      fromDate,
      toDate: input.date,
      inMonth: isYmdInMonth(
        input.date,
        occurrence.targetYear,
        occurrence.targetMonth
      ),
      scheduleSource: "MANUAL" as const,
      previousSource: scheduleSourceOf(occurrence.pinnedOn),
      requiresOffConfirm,
      offWarning: requiresOffConfirm,
      slotsDeferred,
      canApplySlots,
      otherOccurrences,
      fromDay: {
        before: dayPreview(fromSlots, names),
        after: dayPreview(fromAfter, names),
      },
      toDay: {
        before: dayPreview(toSlots, names),
        after: dayPreview(toAfter, names),
      },
      rotationImpact: {
        displaced: move?.displacedRotation ?? [],
        fillers: move?.fillers ?? [],
        nextRotationOrder: plan?.nextRotationOrder ?? null,
        nextPendingProfileIds: plan?.nextPendingProfileIds ?? [],
        nextRotationUnchanged: true,
      },
      fromUpdates: move?.fromUpdates ?? [],
      toUpdates: move?.toUpdates ?? [],
      previewToken,
      planUpdatedAt: lockedPlan?.updatedAt.toISOString() ?? null,
    },
    move,
  };
}

export async function previewPenaltyOccurrenceSchedule(
  input: {
    id: unknown;
    date: unknown;
    confirmOff?: unknown;
  },
  client: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  const date = parsePinnedOn(input.date);
  return client.$transaction(
    async (tx) => {
      const built = await buildSchedulePreview(tx, {
        id,
        date,
        confirmOff: input.confirmOff === true || input.confirmOff === "true",
        forApply: false,
      });
      return built.preview;
    },
    { timeout: 20000 }
  );
}

export async function applyPenaltyOccurrenceSchedule(
  input: {
    id: unknown;
    date: unknown;
    confirmOff?: unknown;
    previewToken?: unknown;
    actor?: ScheduleActor;
  },
  client: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  const date = parsePinnedOn(input.date);
  const confirmOff = input.confirmOff === true || input.confirmOff === "true";
  return client.$transaction(
    async (tx) => {
      const built = await buildSchedulePreview(tx, {
        id,
        date,
        confirmOff,
        forApply: true,
      });
      assertPreviewToken(input.previewToken, built.preview.previewToken);
      const pinnedOn = new Date(`${date}T00:00:00`);
      const fromDate = built.preview.fromDate;
      if (built.move) {
        for (const patch of [...built.move.fromUpdates, ...built.move.toUpdates]) {
          await tx.marshalMonthSlot.update({
            where: { id: patch.id },
            data: {
              caddyId: patch.caddyId,
              marshalProfileId: patch.profileId,
              source: patch.source,
              originalCaddyId: patch.originalCaddyId,
              note: patch.note,
            },
          });
        }
      }
      const placed = Boolean(built.move && built.preview.canApplySlots);
      const saved = await tx.marshalPenaltyOccurrence.update({
        where: { id: built.occurrence.id },
        data: {
          pinnedOn,
          ...(placed
            ? {
                status: "SCHEDULED",
                scheduledOn: pinnedOn,
                scheduledPlanId: built.plan?.id ?? null,
                deferReason: null,
              }
            : {}),
        },
        include: { caddy: { select: { id: true, name: true, team: true } } },
      });
      if (built.plan) {
        await tx.marshalMonthPlan.update({
          where: { id: built.plan.id },
          data: { updatedAt: new Date() },
        });
      }
      await tx.audit.create({
        data: auditRow({
          action: MARSHAL_AUDIT_ACTIONS.PENALTY_OCCURRENCE_SCHEDULE,
          entityId: saved.id,
          ip: input.actor?.ip,
          payload: {
            fromDate,
            toDate: date,
            previousPinnedOn: built.occurrence.pinnedOn
              ? formatMarshalYmd(built.occurrence.pinnedOn)
              : null,
            previousScheduledOn: fromDate,
            previousSource: scheduleSourceOf(built.occurrence.pinnedOn),
            scheduleSource: "MANUAL",
            confirmOff,
            slotsApplied: placed,
            slotsDeferred: built.preview.slotsDeferred,
            displacedRotation: built.preview.rotationImpact.displaced,
            fillers: built.preview.rotationImpact.fillers,
            username: input.actor?.username ?? null,
            userId: input.actor?.userId ?? null,
          },
        }),
      });
      return {
        occurrence: {
          id: saved.id,
          caddyId: saved.caddyId,
          marshalProfileId: saved.marshalProfileId,
          occurredOn: formatMarshalYmd(saved.occurredOn),
          targetYear: saved.targetYear,
          targetMonth: saved.targetMonth,
          scheduledOn: saved.scheduledOn ? formatMarshalYmd(saved.scheduledOn) : null,
          pinnedOn: saved.pinnedOn ? formatMarshalYmd(saved.pinnedOn) : null,
          autoHeldOn: saved.autoHeldOn ? formatMarshalYmd(saved.autoHeldOn) : null,
          scheduleSource: scheduleSourceOf(saved.pinnedOn),
          scheduledPlanId: saved.scheduledPlanId,
          status: saved.status,
          deferReason: saved.deferReason,
          reason: saved.reason,
          note: saved.note,
          caddy: saved.caddy,
        },
        previewToken: built.preview.previewToken,
        fromDate,
        toDate: date,
        slotsApplied: placed,
      };
    },
    { timeout: 20000 }
  );
}
