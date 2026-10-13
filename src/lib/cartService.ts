/**
 * 카트 마스터 CRUD. 날짜 배정/가용 없음.
 * 자동배치 엔진·당일 배치표와 분리.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { isOperationalEmploymentStatus } from "@/lib/operationalRoster";
import {
  CartManageError,
  assertEligibleCartOwner,
  compareCartNumber,
  cartOwnerPublic,
  isCartNumberUniqueViolation,
  isCartOwnerUniqueViolation,
  resolveCartCreateInput,
  resolveCartPatchInput,
  type CartWriteInput,
} from "@/lib/cartManage";

const OWNER_SELECT = {
  id: true,
  name: true,
  team: true,
  employmentStatus: true,
} as const;

export type CartAuditActor = {
  username?: string | null;
  userId?: number | null;
  ip?: string | null;
};

function db(client?: PrismaClient) {
  return client ?? defaultPrisma;
}

function mapUniqueViolation(error: unknown): never {
  const e = error as { code?: string; meta?: { target?: unknown } };
  if (isCartNumberUniqueViolation(e)) {
    throw new CartManageError(
      "이미 등록된 카트 번호입니다.",
      "cart_number_duplicate",
      409
    );
  }
  if (isCartOwnerUniqueViolation(e)) {
    throw new CartManageError(
      "이 캐디는 이미 다른 고정카트의 주인입니다.",
      "cart_owner_taken",
      409
    );
  }
  throw error;
}

function cartJson(row: {
  id: number;
  number: string;
  kind: string;
  kindLabel: string | null;
  ownerCaddyId: number | null;
  dormitoryOnly: boolean;
  operationalStatus: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  ownerCaddy?: {
    id: number;
    name: string;
    team: string;
    employmentStatus: string;
  } | null;
}) {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    kindLabel: row.kindLabel,
    ownerCaddyId: row.ownerCaddyId,
    dormitoryOnly: row.dormitoryOnly,
    operationalStatus: row.operationalStatus,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    owner: cartOwnerPublic(row.ownerCaddy),
  };
}

async function assertOwnerAvailable(
  prisma: PrismaClient,
  ownerCaddyId: number | null,
  excludeCartId?: number
) {
  if (ownerCaddyId == null) return;
  const owner = await prisma.caddy.findUnique({
    where: { id: ownerCaddyId },
    select: OWNER_SELECT,
  });
  assertEligibleCartOwner(owner);
  const taken = await prisma.cart.findFirst({
    where: {
      ownerCaddyId,
      ...(excludeCartId ? { id: { not: excludeCartId } } : {}),
    },
    select: { id: true, number: true },
  });
  if (taken) {
    throw new CartManageError(
      `이 캐디는 이미 카트 ${taken.number}의 고정 주인입니다.`,
      "cart_owner_taken",
      409
    );
  }
}

function auditPayload(
  action: string,
  entityId: number,
  actor: CartAuditActor,
  extra: Record<string, unknown>
): Prisma.AuditCreateInput {
  return {
    action,
    entity: "Cart",
    entityId,
    ip: actor.ip || null,
    payload: {
      ...extra,
      user: actor.username || null,
      userId: actor.userId ?? null,
      createdAt: new Date().toISOString(),
    } as Prisma.InputJsonValue,
  };
}

function persistData(input: CartWriteInput): Prisma.CartUncheckedCreateInput {
  return {
    number: input.number,
    kind: input.kind,
    kindLabel: input.kindLabel,
    ownerCaddyId: input.ownerCaddyId,
    dormitoryOnly: input.dormitoryOnly,
    operationalStatus: input.operationalStatus,
    note: input.note,
  };
}

export async function listCarts(client?: PrismaClient) {
  const rows = await db(client).cart.findMany({
    include: { ownerCaddy: { select: OWNER_SELECT } },
  });
  rows.sort((a, b) => compareCartNumber(a.number, b.number) || a.id - b.id);
  return rows.map(cartJson);
}

export async function getCartById(id: number, client?: PrismaClient) {
  if (!Number.isInteger(id) || id < 1) {
    throw new CartManageError("id 필요", "cart_id_required");
  }
  const row = await db(client).cart.findUnique({
    where: { id },
    include: { ownerCaddy: { select: OWNER_SELECT } },
  });
  if (!row) {
    throw new CartManageError("카트를 찾을 수 없습니다.", "cart_not_found", 404);
  }
  return cartJson(row);
}

export async function createCart(
  body: Record<string, unknown>,
  actor: CartAuditActor = {},
  client?: PrismaClient
) {
  const input = resolveCartCreateInput(body);
  const prisma = db(client);
  await assertOwnerAvailable(prisma, input.ownerCaddyId);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.cart.create({
        data: persistData(input),
        include: { ownerCaddy: { select: OWNER_SELECT } },
      });
      await tx.audit.create({
        data: auditPayload("CART_CREATE", row.id, actor, {
          number: row.number,
          kind: row.kind,
          ownerCaddyId: row.ownerCaddyId,
          dormitoryOnly: row.dormitoryOnly,
          operationalStatus: row.operationalStatus,
        }),
      });
      return row;
    });
    return cartJson(created);
  } catch (error) {
    mapUniqueViolation(error);
  }
}

export async function updateCart(
  id: number,
  body: Record<string, unknown>,
  actor: CartAuditActor = {},
  client?: PrismaClient
) {
  if (!Number.isInteger(id) || id < 1) {
    throw new CartManageError("id 필요", "cart_id_required");
  }
  const prisma = db(client);
  const current = await prisma.cart.findUnique({
    where: { id },
    include: { ownerCaddy: { select: OWNER_SELECT } },
  });
  if (!current) {
    throw new CartManageError("카트를 찾을 수 없습니다.", "cart_not_found", 404);
  }
  const input = resolveCartPatchInput(body, current);
  await assertOwnerAvailable(prisma, input.ownerCaddyId, id);

  const changed = {
    number: input.number !== current.number,
    kind: input.kind !== current.kind || input.kindLabel !== (current.kindLabel ?? null),
    owner: input.ownerCaddyId !== (current.ownerCaddyId ?? null),
    dormitory: input.dormitoryOnly !== current.dormitoryOnly,
    status: input.operationalStatus !== current.operationalStatus,
    note: input.note !== (current.note ?? null),
  };

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.cart.update({
        where: { id },
        data: persistData(input),
        include: { ownerCaddy: { select: OWNER_SELECT } },
      });
      const after = {
        number: row.number,
        kind: row.kind,
        kindLabel: row.kindLabel,
        ownerCaddyId: row.ownerCaddyId,
        dormitoryOnly: row.dormitoryOnly,
        operationalStatus: row.operationalStatus,
        note: row.note,
      };
      const before = {
        number: current.number,
        kind: current.kind,
        kindLabel: current.kindLabel,
        ownerCaddyId: current.ownerCaddyId,
        dormitoryOnly: current.dormitoryOnly,
        operationalStatus: current.operationalStatus,
        note: current.note,
      };
      await tx.audit.create({
        data: auditPayload("CART_UPDATE", id, actor, { before, after }),
      });
      if (changed.status) {
        await tx.audit.create({
          data: auditPayload("CART_STATUS_CHANGE", id, actor, {
            before: current.operationalStatus,
            after: row.operationalStatus,
          }),
        });
      }
      if (changed.owner) {
        await tx.audit.create({
          data: auditPayload("CART_OWNER_CHANGE", id, actor, {
            before: current.ownerCaddyId,
            after: row.ownerCaddyId,
          }),
        });
      }
      if (changed.dormitory) {
        await tx.audit.create({
          data: auditPayload("CART_DORMITORY_CHANGE", id, actor, {
            before: current.dormitoryOnly,
            after: row.dormitoryOnly,
          }),
        });
      }
      return row;
    });
    return cartJson(updated);
  } catch (error) {
    mapUniqueViolation(error);
  }
}

export function isOperationalCaddyForOwnerSelect(employmentStatus: unknown) {
  return isOperationalEmploymentStatus(employmentStatus);
}
