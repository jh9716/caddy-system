/**
 * P2 벌당 발생 기록. 월표 없이 등록하고, 월 생성 시 FULL_DAY 로 합친다.
 * MarshalPenaltyDuty 행을 만들지 않는다. autoAssignEngine 은 건드리지 않는다.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MARSHAL_AUDIT_ACTIONS,
  MarshalRosterError,
  formatMarshalYmd,
  parsePositiveCaddyId,
  parsePositiveId,
} from "@/lib/marshalDomain";
import {
  listMonthYmds,
  type DayPenaltyInput,
  type MarshalDayKind,
  type RotationMember,
} from "@/lib/marshalRotationDomain";
import {
  assertOccurrenceCancellable,
  assertOccurrenceTargetMutable,
  mergeAssignedOccurrences,
  parseOccurredOn,
  scheduleOccurrencesForMonth,
  targetMonthFromOccurredOn,
} from "@/lib/marshalPenaltyOccurrenceDomain";
type DbClient = PrismaClient | Prisma.TransactionClient;

type OccurrenceActor = {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
};

const CADDY_SELECT = {
  id: true,
  name: true,
  team: true,
} as const;

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

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

function serializeOccurrence(row: {
  id: number;
  caddyId: number;
  marshalProfileId: number;
  occurredOn: Date;
  targetYear: number;
  targetMonth: number;
  scheduledOn: Date | null;
  scheduledPlanId: number | null;
  status: string;
  deferReason: string | null;
  reason: string;
  note: string | null;
  caddy?: { id: number; name: string; team: string };
}) {
  return {
    id: row.id,
    caddyId: row.caddyId,
    marshalProfileId: row.marshalProfileId,
    occurredOn: formatMarshalYmd(row.occurredOn),
    targetYear: row.targetYear,
    targetMonth: row.targetMonth,
    scheduledOn: row.scheduledOn ? formatMarshalYmd(row.scheduledOn) : null,
    scheduledPlanId: row.scheduledPlanId,
    status: row.status,
    deferReason: row.deferReason,
    reason: row.reason,
    note: row.note,
    caddy: row.caddy ?? null,
  };
}

export async function lockMonthPlanRow(tx: DbClient, planId: number): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "MarshalMonthPlan" WHERE id = ${planId} FOR UPDATE`
  );
}

export async function lockTargetOccurrences(
  tx: DbClient,
  year: number,
  month: number
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "MarshalPenaltyOccurrence" WHERE "targetYear" = ${year} AND "targetMonth" = ${month} FOR UPDATE`
  );
}

export async function listPenaltyOccurrences(
  input: { year: unknown; month: unknown },
  client: PrismaClient
) {
  const year = Number(input.year);
  const month = Number(input.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new MarshalRosterError("연도가 올바르지 않습니다.", "invalid_year", 400);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new MarshalRosterError("월이 올바르지 않습니다.", "invalid_month", 400);
  }
  const rows = await client.marshalPenaltyOccurrence.findMany({
    where: { targetYear: year, targetMonth: month },
    include: { caddy: { select: CADDY_SELECT } },
    orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
  });
  return rows.map(serializeOccurrence);
}

export async function createPenaltyOccurrence(
  input: {
    caddyId: unknown;
    occurredOn: unknown;
    reason: unknown;
    note?: unknown;
    actor?: OccurrenceActor;
  },
  client: PrismaClient
) {
  const caddyId = parsePositiveCaddyId(input.caddyId);
  const occurredOn = parseOccurredOn(input.occurredOn);
  const target = targetMonthFromOccurredOn(occurredOn);
  if (target.year > 2100) {
    throw new MarshalRosterError(
      "대상 월이 허용 범위를 넘습니다.",
      "invalid_year",
      400
    );
  }
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new MarshalRosterError("벌당 사유가 필요합니다.", "reason_required", 400);
  }
  const note = input.note == null ? null : String(input.note);
  try {
    return await client.$transaction(async (tx) => {
      const profile = await tx.marshalProfile.findUnique({
        where: { caddyId },
        include: { caddy: { select: CADDY_SELECT } },
      });
      if (!profile?.active) {
        throw new MarshalRosterError(
          "활성 마샬만 벌당할 수 있습니다.",
          "inactive_marshal",
          400
        );
      }
      const targetPlan = await tx.marshalMonthPlan.findUnique({
        where: { year_month: { year: target.year, month: target.month } },
      });
      if (targetPlan) {
        await lockMonthPlanRow(tx, targetPlan.id);
        const locked = await tx.marshalMonthPlan.findUnique({
          where: { id: targetPlan.id },
          select: { status: true },
        });
        assertOccurrenceTargetMutable(locked?.status);
      }
      const row = await tx.marshalPenaltyOccurrence.create({
        data: {
          caddyId,
          marshalProfileId: profile.id,
          occurredOn,
          targetYear: target.year,
          targetMonth: target.month,
          status: "OPEN",
          reason,
          note,
          createdByUserId: input.actor?.userId ?? null,
        },
        include: { caddy: { select: CADDY_SELECT } },
      });
      await tx.audit.create({
        data: auditRow({
          action: MARSHAL_AUDIT_ACTIONS.PENALTY_OCCURRENCE_CREATE,
          entityId: row.id,
          ip: input.actor?.ip,
          payload: {
            caddyId,
            occurredOn: formatMarshalYmd(occurredOn),
            targetYear: target.year,
            targetMonth: target.month,
            reason,
            username: input.actor?.username ?? null,
            userId: input.actor?.userId ?? null,
          },
        }),
      });
      return serializeOccurrence(row);
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new MarshalRosterError(
        "같은 날 같은 캐디의 벌당 발생이 이미 있습니다.",
        "duplicate_occurrence",
        409
      );
    }
    throw error;
  }
}

export async function cancelPenaltyOccurrence(
  input: { id: unknown; actor?: OccurrenceActor },
  client: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  return client.$transaction(async (tx) => {
    const current = await tx.marshalPenaltyOccurrence.findUnique({
      where: { id },
      include: {
        scheduledPlan: { select: { id: true, status: true } },
        caddy: { select: CADDY_SELECT },
      },
    });
    if (!current) {
      throw new MarshalRosterError(
        "벌당 발생을 찾을 수 없습니다.",
        "occurrence_not_found",
        404
      );
    }
    if (current.scheduledPlanId) {
      await lockMonthPlanRow(tx, current.scheduledPlanId);
    }
    const planStatus = current.scheduledPlanId
      ? (
          await tx.marshalMonthPlan.findUnique({
            where: { id: current.scheduledPlanId },
            select: { status: true },
          })
        )?.status
      : current.scheduledPlan?.status;
    assertOccurrenceCancellable({
      status: current.status,
      planStatus,
    });
    const saved = await tx.marshalPenaltyOccurrence.update({
      where: { id },
      data: {
        status: "CANCELLED",
        scheduledOn: null,
        scheduledPlanId: null,
        deferReason: "운영자가 취소했습니다.",
      },
      include: { caddy: { select: CADDY_SELECT } },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.PENALTY_OCCURRENCE_CANCEL,
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          previousStatus: current.status,
          scheduledOn: current.scheduledOn
            ? formatMarshalYmd(current.scheduledOn)
            : null,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return serializeOccurrence(saved);
  });
}

/**
 * 이 월에 배정된 SCHEDULED 를 OPEN 으로 되돌린 뒤 다시 싼다.
 * PenaltyDuty 행은 만들지 않고 DayPenaltyInput 만 합친다.
 */
export async function applyOccurrencesToMonth(
  tx: DbClient,
  input: {
    planId: number;
    year: number;
    month: number;
    amSlotsPerDay: number;
    pmSlotsPerDay: number;
    members: readonly RotationMember[];
    penaltiesByDate: ReadonlyMap<string, readonly DayPenaltyInput[]>;
    statusByDateCaddy: ReadonlyMap<
      string,
      { kind: MarshalDayKind; message: string | null }
    >;
  }
): Promise<{
  penaltiesByDate: Map<string, DayPenaltyInput[]>;
  assignedCount: number;
  leftoverCount: number;
  assignedIds: number[];
  leftoverIds: number[];
}> {
  await lockTargetOccurrences(tx, input.year, input.month);
  await tx.marshalPenaltyOccurrence.updateMany({
    where: { scheduledPlanId: input.planId, status: "SCHEDULED" },
    data: {
      status: "OPEN",
      scheduledOn: null,
      scheduledPlanId: null,
      deferReason: null,
    },
  });
  const openRows = await tx.marshalPenaltyOccurrence.findMany({
    where: {
      targetYear: input.year,
      targetMonth: input.month,
      status: "OPEN",
    },
    orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
  });
  const activeCaddyIds = new Set(input.members.map((row) => row.caddyId));
  const eligible = [];
  const inactiveLeftover: { id: number; deferReason: string }[] = [];
  for (const row of openRows) {
    if (!activeCaddyIds.has(row.caddyId)) {
      inactiveLeftover.push({
        id: row.id,
        deferReason: "활성 마샬이 아닙니다.",
      });
      continue;
    }
    eligible.push({
      id: row.id,
      caddyId: row.caddyId,
      profileId: row.marshalProfileId,
      occurredOn: formatMarshalYmd(row.occurredOn),
    });
  }
  const packed = scheduleOccurrencesForMonth({
    dates: listMonthYmds(input.year, input.month),
    amSlots: input.amSlotsPerDay,
    pmSlots: input.pmSlotsPerDay,
    occurrences: eligible,
    existingByDate: input.penaltiesByDate,
    statusByDateCaddy: input.statusByDateCaddy,
  });
  const leftover = [...inactiveLeftover, ...packed.leftover];
  await Promise.all(
    packed.assignments.map((row) =>
      tx.marshalPenaltyOccurrence.update({
        where: { id: row.id },
        data: {
          status: "SCHEDULED",
          scheduledOn: new Date(`${row.date}T00:00:00`),
          scheduledPlanId: input.planId,
          deferReason: null,
        },
      })
    )
  );
  await Promise.all(
    leftover.map((row) =>
      tx.marshalPenaltyOccurrence.update({
        where: { id: row.id },
        data: {
          status: "OPEN",
          scheduledOn: null,
          scheduledPlanId: null,
          deferReason: row.deferReason,
        },
      })
    )
  );
  return {
    penaltiesByDate: mergeAssignedOccurrences(
      input.penaltiesByDate,
      packed.assignments
    ),
    assignedCount: packed.assignments.length,
    leftoverCount: leftover.length,
    assignedIds: packed.assignments.map((row) => row.id),
    leftoverIds: leftover.map((row) => row.id),
  };
}
