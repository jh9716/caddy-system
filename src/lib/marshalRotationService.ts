/**
 * 마샬 월 순환 저장. DailyOpsDuty / Assignment.MARSHAL / Cart 에 write 하지 않는다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { assignmentOverlapsDay, parseYmd } from "@/lib/availabilityEngine";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  DEFAULT_AM_SLOTS_PER_DAY,
  DEFAULT_PM_SLOTS_PER_DAY,
  MARSHAL_AUDIT_ACTIONS,
  MARSHAL_PROFILE_ENTITY,
  MarshalRosterError,
  formatMarshalYmd,
  parseMarshalStartedOn,
  parsePositiveCaddyId,
  parsePositiveId,
} from "@/lib/marshalDomain";
import {
  assertFullDayPenaltyPairLocked,
  assertPlanMutable,
  assertReplaceConfirmed,
  assertSlotMatchesPlan,
  assertSubstituteChangesCaddy,
  canonicalOriginalCaddyId,
  classifyMarshalDayStatus,
  effectiveOffForDay,
  generateMonthRotation,
  inheritStartPendingProfileIds,
  isYmdInMonth,
  listMonthYmds,
  parseMarshalShift,
  resolveCreatePenaltyCoverage,
  resolveUpdatePenaltyShiftCoverage,
  parseSlotsPerDay,
  parseYearMonth,
  previousYearMonth,
  type DayPenaltyInput,
  type GeneratedSlot,
  type MarshalDayKind,
  type OpenCredit,
  type RotationMember,
} from "@/lib/marshalRotationDomain";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type MarshalActor = {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
};

const CADDY_SELECT = {
  id: true,
  name: true,
  team: true,
  teamOrder: true,
  caddyType: true,
  employmentStatus: true,
} as const;

function db(client?: PrismaClient): PrismaClient {
  return client ?? defaultPrisma;
}

function auditRow(input: {
  action: string;
  entity: string;
  entityId: number;
  ip?: string | null;
  payload: Record<string, unknown>;
}): Prisma.AuditCreateInput {
  return {
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    ip: input.ip || null,
    payload: input.payload as Prisma.InputJsonValue,
  };
}

function serializeSlot(
  slot: {
    id: number;
    date: Date;
    shift: string;
    slotIndex: number;
    caddyId: number;
    marshalProfileId: number;
    source: string;
    originalCaddyId: number | null;
    note: string | null;
    caddy: { id: number; name: string; team: string };
    originalCaddy?: { id: number; name: string } | null;
  },
  warning: string | null
) {
  return {
    id: slot.id,
    date: formatMarshalYmd(slot.date),
    shift: slot.shift,
    slotIndex: slot.slotIndex,
    caddyId: slot.caddyId,
    marshalProfileId: slot.marshalProfileId,
    source: slot.source,
    originalCaddyId: slot.originalCaddyId,
    note: slot.note,
    warning,
    caddy: slot.caddy,
    originalCaddy: slot.originalCaddy ?? null,
  };
}

async function loadActiveMembers(tx: DbClient): Promise<RotationMember[]> {
  const rows = await tx.marshalProfile.findMany({
    where: { active: true },
    include: { caddy: { select: CADDY_SELECT } },
  });
  return rows.map((row) => ({
    profileId: row.id,
    caddyId: row.caddyId,
    rotationOrder: row.rotationOrder as number,
    name: row.caddy.name,
    employmentStatus: row.caddy.employmentStatus,
  }));
}

async function loadDayStatuses(
  tx: DbClient,
  year: number,
  month: number,
  members: readonly RotationMember[]
): Promise<Map<string, { kind: MarshalDayKind; message: string | null }>> {
  const ymds = listMonthYmds(year, month);
  const monthStart = parseMarshalStartedOn(ymds[0]);
  const monthEnd = parseYmd(ymds[ymds.length - 1]).end;
  const caddyIds = members.map((m) => m.caddyId);
  const [assignments, overrides, dayUnavail] = await Promise.all([
    tx.assignment.findMany({
      where: {
        caddyId: { in: caddyIds },
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
      select: { caddyId: true, type: true, startDate: true, endDate: true },
    }),
    tx.dailyOffOverride.findMany({
      where: {
        caddyId: { in: caddyIds },
        date: { gte: monthStart, lte: monthEnd },
      },
      select: { caddyId: true, date: true, action: true },
    }),
    tx.dailyCaddyUnavailable.findMany({
      where: {
        caddyId: { in: caddyIds },
        date: { gte: monthStart, lte: monthEnd },
        reason: "SICK",
      },
      select: { caddyId: true, date: true, reason: true },
    }),
  ]);

  const out = new Map<string, { kind: MarshalDayKind; message: string | null }>();
  for (const ymd of ymds) {
    const { start, end } = parseYmd(ymd);
    const offIds = assignments
      .filter(
        (row) =>
          row.type === "OFF" && assignmentOverlapsDay(row, start, end)
      )
      .map((row) => row.caddyId);
    const dayOverrides = overrides
      .filter((row) => formatMarshalYmd(row.date) === ymd)
      .map((row) => ({ caddyId: row.caddyId, action: row.action }));
    const effectiveOff = effectiveOffForDay({
      offCaddyIds: offIds,
      overrides: dayOverrides,
    });
    const sickIds = new Set(
      dayUnavail
        .filter((row) => formatMarshalYmd(row.date) === ymd)
        .map((row) => row.caddyId)
    );
    for (const member of members) {
      const overlappingTypes = assignments
        .filter(
          (row) =>
            row.caddyId === member.caddyId &&
            assignmentOverlapsDay(row, start, end)
        )
        .map((row) => String(row.type));
      if (sickIds.has(member.caddyId) && !overlappingTypes.includes("SICK")) {
        overlappingTypes.push("SICK");
      }
      out.set(
        `${ymd}:${member.caddyId}`,
        classifyMarshalDayStatus({
          employmentStatus: member.employmentStatus,
          overlappingTypes,
          isEffectiveOff: effectiveOff.has(member.caddyId),
        })
      );
    }
  }
  return out;
}

function attachWarnings(
  slots: GeneratedSlot[],
  statusByDateCaddy: Map<string, { kind: MarshalDayKind; message: string | null }>
) {
  return slots.map((slot) => {
    const status = statusByDateCaddy.get(`${slot.date}:${slot.caddyId}`);
    return {
      ...slot,
      warning: status?.kind === "off_conflict" ? status.message : slot.warning,
    };
  });
}

export async function getMonthPlan(
  input: { year: unknown; month: unknown },
  client?: PrismaClient
) {
  const { year, month } = parseYearMonth(input.year, input.month);
  const prisma = db(client);
  const [plan, prev, members, credits] = await Promise.all([
    prisma.marshalMonthPlan.findUnique({
      where: { year_month: { year, month } },
      include: {
        slots: {
          include: {
            caddy: { select: { id: true, name: true, team: true } },
            originalCaddy: { select: { id: true, name: true } },
          },
          orderBy: [{ date: "asc" }, { shift: "asc" }, { slotIndex: "asc" }],
        },
        penalties: {
          include: { caddy: { select: { id: true, name: true, team: true } } },
          orderBy: [{ date: "asc" }, { shift: "asc" }],
        },
      },
    }),
    prisma.marshalMonthPlan.findUnique({
      where: {
        year_month: previousYearMonth(year, month),
      },
      select: {
        status: true,
        nextRotationOrder: true,
        nextPendingProfileIds: true,
        year: true,
        month: true,
      },
    }),
    loadActiveMembers(prisma),
    prisma.marshalRotationCredit.findMany({
      where: { status: "OPEN" },
      include: {
        marshalProfile: {
          include: { caddy: { select: { id: true, name: true } } },
        },
        replacedCaddy: { select: { id: true, name: true } },
      },
      orderBy: { id: "asc" },
    }),
  ]);

  const prevFinalized = prev?.status === "FINALIZED" ? prev : null;
  const suggestedStart =
    prevFinalized != null ? prevFinalized.nextRotationOrder : null;
  const suggestedStartPendingProfileIds = prevFinalized
    ? prevFinalized.nextPendingProfileIds || []
    : [];
  const statusByDateCaddy = plan
    ? await loadDayStatuses(prisma, year, month, members)
    : new Map();
  const pendingById = new Map(members.map((row) => [row.profileId, row]));
  const pendingNames = (ids: readonly number[]) =>
    ids
      .map((id) => pendingById.get(id)?.name)
      .filter((name): name is string => Boolean(name));

  return {
    year,
    month,
    suggestedStartRotationOrder: suggestedStart,
    suggestedStartPendingProfileIds,
    suggestedStartPendingNames: pendingNames(suggestedStartPendingProfileIds),
    previousFinalized: prevFinalized,
    members,
    credits: credits.map((row) => ({
      id: row.id,
      marshalProfileId: row.marshalProfileId,
      status: row.status,
      sourceDate: row.sourceDate ? formatMarshalYmd(row.sourceDate) : null,
      replacedCaddyId: row.replacedCaddyId,
      reason: row.reason,
      note: row.note,
      caddy: row.marshalProfile.caddy,
      replacedCaddy: row.replacedCaddy,
    })),
    creditRemaining: members.map((member) => ({
      profileId: member.profileId,
      caddyId: member.caddyId,
      name: member.name,
      remaining: credits.filter((c) => c.marshalProfileId === member.profileId)
        .length,
    })),
    plan: plan
      ? {
          id: plan.id,
          year: plan.year,
          month: plan.month,
          amSlotsPerDay: plan.amSlotsPerDay,
          pmSlotsPerDay: plan.pmSlotsPerDay,
          status: plan.status,
          startRotationOrder: plan.startRotationOrder,
          nextRotationOrder: plan.nextRotationOrder,
          startPendingProfileIds: plan.startPendingProfileIds || [],
          nextPendingProfileIds: plan.nextPendingProfileIds || [],
          startPendingNames: pendingNames(plan.startPendingProfileIds || []),
          nextPendingNames: pendingNames(plan.nextPendingProfileIds || []),
          generatedAt: plan.generatedAt?.toISOString() ?? null,
          slots: plan.slots.map((slot) =>
            serializeSlot(
              slot,
              statusByDateCaddy.get(
                `${formatMarshalYmd(slot.date)}:${slot.caddyId}`
              )?.kind === "off_conflict"
                ? statusByDateCaddy.get(
                    `${formatMarshalYmd(slot.date)}:${slot.caddyId}`
                  )?.message || "휴무 충돌"
                : null
            )
          ),
          penalties: plan.penalties.map((row) => ({
            id: row.id,
            date: formatMarshalYmd(row.date),
            shift: row.shift,
            coverage: row.coverage,
            caddyId: row.caddyId,
            marshalProfileId: row.marshalProfileId,
            reason: row.reason,
            note: row.note,
            caddy: row.caddy,
          })),
        }
      : null,
  };
}

export async function upsertMonthPlanSettings(
  input: {
    year: unknown;
    month: unknown;
    amSlotsPerDay?: unknown;
    pmSlotsPerDay?: unknown;
    startRotationOrder?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const { year, month } = parseYearMonth(input.year, input.month);
  const amSlotsPerDay = parseSlotsPerDay(
    input.amSlotsPerDay,
    "조출 인원",
    DEFAULT_AM_SLOTS_PER_DAY
  );
  const pmSlotsPerDay = parseSlotsPerDay(
    input.pmSlotsPerDay,
    "후출 인원",
    DEFAULT_PM_SLOTS_PER_DAY
  );
  const prisma = db(client);
  const existing = await prisma.marshalMonthPlan.findUnique({
    where: { year_month: { year, month } },
  });
  if (existing?.status === "FINALIZED") {
    throw new MarshalRosterError(
      "FINALIZED 월표 설정은 바꿀 수 없습니다.",
      "finalized_locked",
      409
    );
  }
  let startRotationOrder =
    input.startRotationOrder === undefined || input.startRotationOrder === ""
      ? null
      : parsePositiveId(input.startRotationOrder, "startRotationOrder");
  const prev = await prisma.marshalMonthPlan.findUnique({
    where: { year_month: previousYearMonth(year, month) },
    select: {
      status: true,
      nextRotationOrder: true,
      nextPendingProfileIds: true,
    },
  });
  if (startRotationOrder == null) {
    if (prev?.status === "FINALIZED") {
      startRotationOrder = prev.nextRotationOrder;
    } else {
      throw new MarshalRosterError(
        "이전 FINALIZED 월표가 없습니다. 시작 순번을 지정하세요.",
        "start_order_required",
        400
      );
    }
  }
  const startPendingProfileIds = inheritStartPendingProfileIds({
    hasGeneratedPlan: Boolean(existing?.generatedAt),
    storedStartPendingProfileIds: existing?.startPendingProfileIds,
    previousFinalizedNextPending:
      prev?.status === "FINALIZED" ? prev.nextPendingProfileIds : [],
  });
  const row = existing
    ? await prisma.marshalMonthPlan.update({
        where: { id: existing.id },
        data: {
          amSlotsPerDay,
          pmSlotsPerDay,
          startRotationOrder,
          nextRotationOrder: existing.generatedAt
            ? existing.nextRotationOrder
            : startRotationOrder,
          startPendingProfileIds: existing.generatedAt
            ? existing.startPendingProfileIds
            : startPendingProfileIds,
        },
      })
    : await prisma.marshalMonthPlan.create({
        data: {
          year,
          month,
          amSlotsPerDay,
          pmSlotsPerDay,
          startRotationOrder,
          nextRotationOrder: startRotationOrder,
          startPendingProfileIds,
          nextPendingProfileIds: [],
        },
      });
  return getMonthPlan({ year, month }, client);
}

export async function generateMonthPlan(
  input: {
    year: unknown;
    month: unknown;
    amSlotsPerDay?: unknown;
    pmSlotsPerDay?: unknown;
    startRotationOrder?: unknown;
    replace?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const { year, month } = parseYearMonth(input.year, input.month);
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    let plan = await tx.marshalMonthPlan.findUnique({
      where: { year_month: { year, month } },
      include: { slots: { select: { id: true, source: true } }, penalties: true },
    });
    assertPlanMutable(plan?.status || "DRAFT", "generate");
    assertReplaceConfirmed(input.replace, Boolean(plan?.slots.length));
    if (plan?.slots.length) {
      const destructive = plan.slots.some((s) =>
        s.source === "MANUAL" || s.source === "SUBSTITUTE" || s.source === "PENALTY"
      );
      if (
        destructive &&
        input.replace !== true &&
        input.replace !== "true"
      ) {
        throw new MarshalRosterError(
          "벌당/수동/대타 슬롯이 있는 DRAFT를 덮어씁니다. replace=true 가 필요합니다.",
          "draft_has_overrides",
          409
        );
      }
    }

    const members = await loadActiveMembers(tx);
    const prev = await tx.marshalMonthPlan.findUnique({
      where: { year_month: previousYearMonth(year, month) },
      select: {
        status: true,
        nextRotationOrder: true,
        nextPendingProfileIds: true,
      },
    });
    let startRotationOrder =
      input.startRotationOrder === undefined || input.startRotationOrder === ""
        ? plan?.startRotationOrder ?? null
        : parsePositiveId(input.startRotationOrder, "startRotationOrder");
    if (startRotationOrder == null && prev?.status === "FINALIZED") {
      startRotationOrder = prev.nextRotationOrder;
    }
    if (startRotationOrder == null) {
      throw new MarshalRosterError(
        "시작 순번이 필요합니다.",
        "start_order_required",
        400
      );
    }
    const startPendingProfileIds = inheritStartPendingProfileIds({
      hasGeneratedPlan: Boolean(plan?.generatedAt),
      storedStartPendingProfileIds: plan?.startPendingProfileIds,
      previousFinalizedNextPending:
        prev?.status === "FINALIZED" ? prev.nextPendingProfileIds : [],
    });
    const amSlotsPerDay = parseSlotsPerDay(
      input.amSlotsPerDay,
      "조출 인원",
      plan?.amSlotsPerDay ?? DEFAULT_AM_SLOTS_PER_DAY
    );
    const pmSlotsPerDay = parseSlotsPerDay(
      input.pmSlotsPerDay,
      "후출 인원",
      plan?.pmSlotsPerDay ?? DEFAULT_PM_SLOTS_PER_DAY
    );

    if (!plan) {
      plan = await tx.marshalMonthPlan.create({
        data: {
          year,
          month,
          amSlotsPerDay,
          pmSlotsPerDay,
          startRotationOrder,
          nextRotationOrder: startRotationOrder,
          startPendingProfileIds,
          nextPendingProfileIds: [],
        },
        include: { slots: { select: { id: true, source: true } }, penalties: true },
      });
    } else {
      plan = await tx.marshalMonthPlan.update({
        where: { id: plan.id },
        data: {
          amSlotsPerDay,
          pmSlotsPerDay,
          startRotationOrder,
          startPendingProfileIds: plan.generatedAt
            ? plan.startPendingProfileIds
            : startPendingProfileIds,
        },
        include: { slots: { select: { id: true, source: true } }, penalties: true },
      });
    }

    await tx.marshalRotationCredit.updateMany({
      where: { consumedPlanId: plan.id, status: "CONSUMED" },
      data: { status: "OPEN", consumedPlanId: null, consumedDate: null },
    });
    await tx.marshalMonthSlot.deleteMany({ where: { planId: plan.id } });

    const statusByDateCaddy = await loadDayStatuses(tx, year, month, members);
    const openCredits: OpenCredit[] = (
      await tx.marshalRotationCredit.findMany({
        where: { status: "OPEN" },
        select: { id: true, marshalProfileId: true },
        orderBy: { id: "asc" },
      })
    ).map((row) => ({ id: row.id, profileId: row.marshalProfileId }));

    const penaltiesByDate = new Map<string, DayPenaltyInput[]>();
    for (const penalty of plan.penalties) {
      const ymd = formatMarshalYmd(penalty.date);
      const list = penaltiesByDate.get(ymd) || [];
      list.push({
        caddyId: penalty.caddyId,
        profileId: penalty.marshalProfileId,
        shift: penalty.shift,
        coverage: penalty.coverage,
      });
      penaltiesByDate.set(ymd, list);
    }

    const generated = generateMonthRotation({
      year,
      month,
      amSlotsPerDay,
      pmSlotsPerDay,
      startRotationOrder,
      startPendingProfileIds,
      members,
      penaltiesByDate,
      statusByDateCaddy,
      openCredits,
    });
    const slots = attachWarnings(generated.slots, statusByDateCaddy);

    if (slots.length !== listMonthYmds(year, month).length * (amSlotsPerDay + pmSlotsPerDay)) {
      throw new MarshalRosterError(
        "월표가 부분 생성되었습니다. 저장하지 않습니다.",
        "partial_generate",
        400
      );
    }

    await tx.marshalMonthSlot.createMany({
      data: slots.map((slot) => ({
        planId: plan!.id,
        date: parseMarshalStartedOn(slot.date),
        shift: slot.shift,
        slotIndex: slot.slotIndex,
        caddyId: slot.caddyId,
        marshalProfileId: slot.profileId,
        source: slot.source,
        note: slot.warning,
      })),
    });
    for (const credit of generated.consumedCredits) {
      await tx.marshalRotationCredit.update({
        where: { id: credit.creditId },
        data: {
          status: "CONSUMED",
          consumedPlanId: plan.id,
          consumedDate: parseMarshalStartedOn(credit.date),
        },
      });
    }
    const saved = await tx.marshalMonthPlan.update({
      where: { id: plan.id },
      data: {
        startPendingProfileIds,
        nextRotationOrder: generated.nextRotationOrder,
        nextPendingProfileIds: generated.nextPendingProfileIds,
        generatedAt: new Date(),
      },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.MONTH_GENERATE,
        entity: "MarshalMonthPlan",
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          year,
          month,
          startRotationOrder,
          nextRotationOrder: generated.nextRotationOrder,
          startPendingProfileIds,
          nextPendingProfileIds: generated.nextPendingProfileIds,
          amSlotsPerDay,
          pmSlotsPerDay,
          slotCount: slots.length,
          consumedCredits: generated.consumedCredits.length,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return {
      planId: saved.id,
      year,
      month,
      startRotationOrder,
      nextRotationOrder: generated.nextRotationOrder,
      startPendingProfileIds,
      nextPendingProfileIds: generated.nextPendingProfileIds,
      warnings: generated.warnings,
      slotCount: slots.length,
    };
  });
}

export async function finalizeMonthPlan(
  input: { id: unknown; actor?: MarshalActor },
  client?: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    const plan = await tx.marshalMonthPlan.findUnique({
      where: { id },
      include: { slots: { select: { id: true } } },
    });
    if (!plan) {
      throw new MarshalRosterError("월표를 찾을 수 없습니다.", "plan_not_found", 404);
    }
    if (plan.status === "FINALIZED") {
      throw new MarshalRosterError("이미 FINALIZED 입니다.", "already_finalized", 409);
    }
    if (!plan.generatedAt || plan.slots.length === 0) {
      throw new MarshalRosterError(
        "생성되지 않은 월표는 마감할 수 없습니다.",
        "not_generated",
        400
      );
    }
    const saved = await tx.marshalMonthPlan.update({
      where: { id },
      data: { status: "FINALIZED" },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.MONTH_FINALIZE,
        entity: "MarshalMonthPlan",
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          year: saved.year,
          month: saved.month,
          nextRotationOrder: saved.nextRotationOrder,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return saved;
  });
}

export async function replaceMonthSlot(
  input: {
    planId: unknown;
    slotId: unknown;
    caddyId: unknown;
    note?: unknown;
    asSubstitute?: unknown;
    applyCredit?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const planId = parsePositiveId(input.planId, "planId");
  const slotId = parsePositiveId(input.slotId, "slotId");
  const caddyId = parsePositiveCaddyId(input.caddyId);
  const asSubstitute = input.asSubstitute === true || input.asSubstitute === "true";
  const applyCredit = input.applyCredit === true || input.applyCredit === "true";
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    const slot = await tx.marshalMonthSlot.findUnique({
      where: { id: slotId },
      include: { plan: true, caddy: { select: { name: true } } },
    });
    if (!slot) {
      throw new MarshalRosterError("슬롯을 찾을 수 없습니다.", "slot_not_found", 404);
    }
    assertSlotMatchesPlan(slot.planId, planId);
    if (caddyId === slot.caddyId) {
      throw new MarshalRosterError(
        "같은 마샬로 교체할 수 없습니다.",
        "substitute_unchanged",
        400
      );
    }
    if (asSubstitute) {
      assertSubstituteChangesCaddy(slot.caddyId, caddyId);
    }
    const daySlots = await tx.marshalMonthSlot.findMany({
      where: { planId: slot.planId, date: slot.date },
      select: { id: true, caddyId: true, shift: true, source: true },
    });
    assertFullDayPenaltyPairLocked({
      slotId: slot.id,
      slotCaddyId: slot.caddyId,
      slotSource: slot.source,
      daySlots,
    });
    const profile = await tx.marshalProfile.findUnique({
      where: { caddyId },
      include: { caddy: { select: CADDY_SELECT } },
    });
    if (!profile || !profile.active) {
      throw new MarshalRosterError(
        "활성 마샬만 배정할 수 있습니다.",
        "inactive_marshal",
        400
      );
    }
    const clash = await tx.marshalMonthSlot.findFirst({
      where: {
        planId: slot.planId,
        date: slot.date,
        caddyId,
        NOT: { id: slot.id },
      },
    });
    if (clash) {
      throw new MarshalRosterError(
        "같은 날 이미 배정된 마샬입니다.",
        "same_day_duplicate",
        409
      );
    }
    const fromCaddyId = slot.caddyId;
    const originalScheduledCaddyId = canonicalOriginalCaddyId(slot);
    const saved = await tx.marshalMonthSlot.update({
      where: { id: slot.id },
      data: {
        caddyId,
        marshalProfileId: profile.id,
        source: asSubstitute ? "SUBSTITUTE" : "MANUAL",
        originalCaddyId: asSubstitute
          ? originalScheduledCaddyId
          : slot.originalCaddyId,
        note: input.note == null ? slot.note : String(input.note),
      },
      include: {
        caddy: { select: { id: true, name: true, team: true } },
        originalCaddy: { select: { id: true, name: true } },
      },
    });
    await tx.audit.create({
      data: auditRow({
        action: asSubstitute
          ? MARSHAL_AUDIT_ACTIONS.SUBSTITUTE
          : MARSHAL_AUDIT_ACTIONS.MONTH_SLOT_CHANGE,
        entity: "MarshalMonthSlot",
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          planId: slot.planId,
          date: formatMarshalYmd(slot.date),
          originalCaddyId: originalScheduledCaddyId,
          fromCaddyId,
          toCaddyId: caddyId,
          asSubstitute,
          applyCredit,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    if (asSubstitute && applyCredit && caddyId !== fromCaddyId) {
      const credit = await tx.marshalRotationCredit.create({
        data: {
          marshalProfileId: profile.id,
          status: "OPEN",
          sourceDate: slot.date,
          replacedCaddyId: originalScheduledCaddyId,
          reason: "대타 보정",
          note: input.note == null ? null : String(input.note),
          createdByUserId: input.actor?.userId ?? null,
        },
      });
      await tx.audit.create({
        data: auditRow({
          action: MARSHAL_AUDIT_ACTIONS.ADJUSTMENT_CHANGE,
          entity: "MarshalRotationCredit",
          entityId: credit.id,
          ip: input.actor?.ip,
          payload: {
            delta: 1,
            marshalProfileId: profile.id,
            replacedCaddyId: originalScheduledCaddyId,
            fromCaddyId,
            username: input.actor?.username ?? null,
            userId: input.actor?.userId ?? null,
          },
        }),
      });
    }
    return serializeSlot(saved, null);
  });
}

export async function createPenaltyDuty(
  input: {
    year: unknown;
    month: unknown;
    date: unknown;
    caddyId: unknown;
    shift: unknown;
    coverage?: unknown;
    reason: unknown;
    note?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const { year, month } = parseYearMonth(input.year, input.month);
  const date = parseMarshalStartedOn(input.date);
  const ymd = formatMarshalYmd(date);
  if (!isYmdInMonth(ymd, year, month)) {
    throw new MarshalRosterError("벌당 날짜가 해당 월이 아닙니다.", "invalid_date", 400);
  }
  const caddyId = parsePositiveCaddyId(input.caddyId);
  const shift = parseMarshalShift(input.shift);
  const coverage = resolveCreatePenaltyCoverage(input.coverage, shift);
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new MarshalRosterError("벌당 사유가 필요합니다.", "reason_required", 400);
  }
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    let plan = await tx.marshalMonthPlan.findUnique({
      where: { year_month: { year, month } },
    });
    if (plan?.status === "FINALIZED") {
      throw new MarshalRosterError(
        "FINALIZED 월표에는 벌당을 추가할 수 없습니다.",
        "finalized_locked",
        409
      );
    }
    const profile = await tx.marshalProfile.findUnique({
      where: { caddyId },
      include: { caddy: { select: CADDY_SELECT } },
    });
    if (!profile?.active) {
      throw new MarshalRosterError("활성 마샬만 벌당할 수 있습니다.", "inactive_marshal", 400);
    }
    if (!plan) {
      throw new MarshalRosterError(
        "먼저 월표 설정을 저장하세요.",
        "plan_not_found",
        404
      );
    }
    const row = await tx.marshalPenaltyDuty.create({
      data: {
        planId: plan.id,
        date,
        shift,
        coverage,
        caddyId,
        marshalProfileId: profile.id,
        reason,
        note: input.note == null ? null : String(input.note),
        createdByUserId: input.actor?.userId ?? null,
      },
      include: { caddy: { select: { id: true, name: true, team: true } } },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.PENALTY_CREATE,
        entity: "MarshalPenaltyDuty",
        entityId: row.id,
        ip: input.actor?.ip,
        payload: {
          date: ymd,
          caddyId,
          shift,
          coverage,
          reason,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return {
      id: row.id,
      date: ymd,
      shift: row.shift,
      coverage: row.coverage,
      caddyId: row.caddyId,
      reason: row.reason,
      note: row.note,
      caddy: row.caddy,
    };
  });
}

export async function updatePenaltyDuty(
  input: {
    id: unknown;
    shift?: unknown;
    coverage?: unknown;
    reason?: unknown;
    note?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    const current = await tx.marshalPenaltyDuty.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!current) {
      throw new MarshalRosterError("벌당을 찾을 수 없습니다.", "penalty_not_found", 404);
    }
    if (current.plan.status === "FINALIZED") {
      throw new MarshalRosterError(
        "FINALIZED 월표의 벌당은 수정할 수 없습니다.",
        "finalized_locked",
        409
      );
    }
    const next = resolveUpdatePenaltyShiftCoverage({
      currentShift: current.shift,
      currentCoverage: current.coverage,
      shift: input.shift,
      coverage: input.coverage,
    });
    const saved = await tx.marshalPenaltyDuty.update({
      where: { id },
      data: {
        shift: next.shift,
        coverage: next.coverage,
        reason:
          input.reason === undefined ? undefined : String(input.reason).trim(),
        note: input.note === undefined ? undefined : String(input.note),
      },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.PENALTY_UPDATE,
        entity: "MarshalPenaltyDuty",
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          shift: saved.shift,
          coverage: saved.coverage,
          reason: saved.reason,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return saved;
  });
}

export async function deletePenaltyDuty(
  input: { id: unknown; actor?: MarshalActor },
  client?: PrismaClient
) {
  const id = parsePositiveId(input.id, "id");
  const prisma = db(client);
  const current = await prisma.marshalPenaltyDuty.findUnique({
    where: { id },
    include: { plan: true },
  });
  if (!current) {
    throw new MarshalRosterError("벌당을 찾을 수 없습니다.", "penalty_not_found", 404);
  }
  if (current.plan.status === "FINALIZED") {
    throw new MarshalRosterError(
      "FINALIZED 월표의 벌당은 삭제할 수 없습니다.",
      "finalized_locked",
      409
    );
  }
  await prisma.marshalPenaltyDuty.delete({ where: { id } });
  await prisma.audit.create({
    data: auditRow({
      action: MARSHAL_AUDIT_ACTIONS.PENALTY_UPDATE,
      entity: "MarshalPenaltyDuty",
      entityId: id,
      ip: input.actor?.ip,
      payload: {
        deleted: true,
        username: input.actor?.username ?? null,
        userId: input.actor?.userId ?? null,
      },
    }),
  });
}

export async function changeRotationCredit(
  input: {
    marshalProfileId?: unknown;
    creditId?: unknown;
    delta: unknown;
    sourceDate?: unknown;
    replacedCaddyId?: unknown;
    reason?: unknown;
    note?: unknown;
    actor?: MarshalActor;
  },
  client?: PrismaClient
) {
  const delta = Number(input.delta);
  if (delta !== 1 && delta !== -1) {
    throw new MarshalRosterError("보정은 +1 또는 -1만 가능합니다.", "invalid_delta", 400);
  }
  const prisma = db(client);
  return prisma.$transaction(async (tx) => {
    if (delta === 1) {
      const profileId = parsePositiveId(input.marshalProfileId, "marshalProfileId");
      const profile = await tx.marshalProfile.findUnique({
        where: { id: profileId },
      });
      if (!profile) {
        throw new MarshalRosterError("마샬 명단을 찾을 수 없습니다.", "profile_not_found", 404);
      }
      const row = await tx.marshalRotationCredit.create({
        data: {
          marshalProfileId: profileId,
          status: "OPEN",
          sourceDate: input.sourceDate
            ? parseMarshalStartedOn(input.sourceDate)
            : null,
          replacedCaddyId: input.replacedCaddyId
            ? parsePositiveCaddyId(input.replacedCaddyId)
            : null,
          reason: input.reason == null ? "대타 보정" : String(input.reason),
          note: input.note == null ? null : String(input.note),
          createdByUserId: input.actor?.userId ?? null,
        },
      });
      await tx.audit.create({
        data: auditRow({
          action: MARSHAL_AUDIT_ACTIONS.ADJUSTMENT_CHANGE,
          entity: "MarshalRotationCredit",
          entityId: row.id,
          ip: input.actor?.ip,
          payload: {
            delta: 1,
            marshalProfileId: profileId,
            username: input.actor?.username ?? null,
            userId: input.actor?.userId ?? null,
          },
        }),
      });
      return row;
    }
    const creditId = parsePositiveId(input.creditId, "creditId");
    const current = await tx.marshalRotationCredit.findUnique({
      where: { id: creditId },
    });
    if (!current || current.status !== "OPEN") {
      throw new MarshalRosterError(
        "취소할 보정 잔여가 없습니다.",
        "credit_not_open",
        404
      );
    }
    const saved = await tx.marshalRotationCredit.update({
      where: { id: creditId },
      data: { status: "CANCELLED" },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.ADJUSTMENT_CHANGE,
        entity: "MarshalRotationCredit",
        entityId: saved.id,
        ip: input.actor?.ip,
        payload: {
          delta: -1,
          marshalProfileId: current.marshalProfileId,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return saved;
  });
}
