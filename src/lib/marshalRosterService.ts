/**
 * 마샬 명단 저장. DailyOpsDuty / Assignment.MARSHAL / MARSHAL_SUPPORT 에 write 하지 않는다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  MARSHAL_AUDIT_ACTIONS,
  MARSHAL_PROFILE_ENTITY,
  MarshalRosterError,
  assertCaddyEligibleForMarshal,
  formatMarshalYmd,
  parseMarshalStartedOn,
  parseOptionalSeniorCaddyId,
  parsePositiveCaddyId,
  parsePositiveId,
  serializeMarshalProfile,
  type MarshalRosterRow,
} from "@/lib/marshalDomain";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type MarshalRosterActor = {
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

async function requireCaddy(client: DbClient, caddyId: number) {
  const caddy = await client.caddy.findUnique({
    where: { id: caddyId },
    select: CADDY_SELECT,
  });
  if (!caddy) {
    throw new MarshalRosterError(
      "존재하지 않는 캐디입니다.",
      "caddy_not_found",
      404
    );
  }
  return caddy;
}

async function requireEligibleCaddy(client: DbClient, caddyId: number) {
  const caddy = await requireCaddy(client, caddyId);
  assertCaddyEligibleForMarshal(caddy);
  return caddy;
}

function auditRow(input: {
  action: string;
  entityId: number;
  ip?: string | null;
  payload: Record<string, unknown>;
}): Prisma.AuditCreateInput {
  return {
    action: input.action,
    entity: MARSHAL_PROFILE_ENTITY,
    entityId: input.entityId,
    ip: input.ip || null,
    payload: input.payload as Prisma.InputJsonValue,
  };
}

export async function listMarshalProfiles(
  client?: PrismaClient
): Promise<MarshalRosterRow[]> {
  const rows = await db(client).marshalProfile.findMany({
    include: { caddy: { select: CADDY_SELECT } },
    orderBy: [
      { active: "desc" },
      { caddy: { team: "asc" } },
      { caddy: { teamOrder: "asc" } },
      { id: "asc" },
    ],
  });
  return rows.map(serializeMarshalProfile);
}

export async function createMarshalProfile(
  input: {
    caddyId: unknown;
    startedOn: unknown;
    seniorCaddyId?: unknown;
    actor?: MarshalRosterActor;
  },
  client?: PrismaClient
): Promise<MarshalRosterRow> {
  const caddyId = parsePositiveCaddyId(input.caddyId);
  const startedOn = parseMarshalStartedOn(input.startedOn);
  const seniorCaddyId = parseOptionalSeniorCaddyId(input.seniorCaddyId, caddyId);
  const prisma = db(client);

  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.marshalProfile.findUnique({
      where: { caddyId },
      select: { id: true, active: true },
    });
    if (existing) {
      throw new MarshalRosterError(
        existing.active
          ? "이미 마샬 명단에 등록된 캐디입니다."
          : "비활성 마샬입니다. 복구는 수정 API를 사용하세요.",
        "already_registered",
        409
      );
    }
    const caddy = await requireEligibleCaddy(tx, caddyId);
    if (seniorCaddyId != null) {
      await requireCaddy(tx, seniorCaddyId);
    }
    const row = await tx.marshalProfile.create({
      data: {
        caddyId,
        startedOn,
        seniorCaddyId,
        active: true,
      },
      include: { caddy: { select: CADDY_SELECT } },
    });
    await tx.audit.create({
      data: auditRow({
        action: MARSHAL_AUDIT_ACTIONS.CREATE,
        entityId: row.id,
        ip: input.actor?.ip,
        payload: {
          caddyId,
          name: caddy.name,
          startedOn: formatMarshalYmd(startedOn),
          seniorCaddyId,
          username: input.actor?.username ?? null,
          userId: input.actor?.userId ?? null,
        },
      }),
    });
    return row;
  });
  return serializeMarshalProfile(created);
}

export async function updateMarshalProfile(
  input: {
    id: unknown;
    active?: unknown;
    startedOn?: unknown;
    seniorCaddyId?: unknown;
    actor?: MarshalRosterActor;
  },
  client?: PrismaClient
): Promise<MarshalRosterRow> {
  const id = parsePositiveId(input.id, "id");
  const prisma = db(client);
  const hasActive = input.active !== undefined;
  const hasStartedOn = input.startedOn !== undefined;
  const hasSenior = input.seniorCaddyId !== undefined;
  if (!hasActive && !hasStartedOn && !hasSenior) {
    throw new MarshalRosterError("수정할 값이 없습니다.", "empty_patch", 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.marshalProfile.findUnique({
      where: { id },
      include: { caddy: { select: CADDY_SELECT } },
    });
    if (!current) {
      throw new MarshalRosterError(
        "마샬 명단을 찾을 수 없습니다.",
        "profile_not_found",
        404
      );
    }

    const data: Prisma.MarshalProfileUpdateInput = {};
    const audits: Prisma.AuditCreateInput[] = [];

    if (hasActive) {
      const nextActive = input.active === true || input.active === "true";
      if (nextActive !== current.active) {
        if (nextActive) {
          assertCaddyEligibleForMarshal(current.caddy);
        }
        data.active = nextActive;
        audits.push(
          auditRow({
            action: nextActive
              ? MARSHAL_AUDIT_ACTIONS.REACTIVATE
              : MARSHAL_AUDIT_ACTIONS.DEACTIVATE,
            entityId: current.id,
            ip: input.actor?.ip,
            payload: {
              caddyId: current.caddyId,
              name: current.caddy.name,
              from: current.active,
              to: nextActive,
              username: input.actor?.username ?? null,
              userId: input.actor?.userId ?? null,
            },
          })
        );
      }
    }

    if (hasStartedOn) {
      const startedOn = parseMarshalStartedOn(input.startedOn);
      const prev = formatMarshalYmd(current.startedOn);
      const next = formatMarshalYmd(startedOn);
      if (prev !== next) {
        data.startedOn = startedOn;
        audits.push(
          auditRow({
            action: MARSHAL_AUDIT_ACTIONS.UPDATE_STARTED_ON,
            entityId: current.id,
            ip: input.actor?.ip,
            payload: {
              caddyId: current.caddyId,
              name: current.caddy.name,
              from: prev,
              to: next,
              username: input.actor?.username ?? null,
              userId: input.actor?.userId ?? null,
            },
          })
        );
      }
    }

    if (hasSenior) {
      const seniorCaddyId = parseOptionalSeniorCaddyId(
        input.seniorCaddyId,
        current.caddyId
      );
      if (seniorCaddyId !== current.seniorCaddyId) {
        if (seniorCaddyId != null) {
          await requireCaddy(tx, seniorCaddyId);
        }
        data.seniorCaddy = seniorCaddyId
          ? { connect: { id: seniorCaddyId } }
          : { disconnect: true };
        audits.push(
          auditRow({
            action: MARSHAL_AUDIT_ACTIONS.UPDATE_SENIOR,
            entityId: current.id,
            ip: input.actor?.ip,
            payload: {
              caddyId: current.caddyId,
              name: current.caddy.name,
              from: current.seniorCaddyId,
              to: seniorCaddyId,
              username: input.actor?.username ?? null,
              userId: input.actor?.userId ?? null,
            },
          })
        );
      }
    }

    if (Object.keys(data).length === 0) {
      return current;
    }

    const row = await tx.marshalProfile.update({
      where: { id },
      data,
      include: { caddy: { select: CADDY_SELECT } },
    });
    for (const audit of audits) {
      await tx.audit.create({ data: audit });
    }
    return row;
  });
  return serializeMarshalProfile(updated);
}

export function marshalErrorResponse(error: unknown): {
  status: number;
  body: { error: string; code?: string };
} {
  if (error instanceof MarshalRosterError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }
  return { status: 500, body: { error: "마샬 명단 처리에 실패했습니다." } };
}
