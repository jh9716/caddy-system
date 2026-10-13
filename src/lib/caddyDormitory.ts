/**
 * 기숙사 자격 SoT. extraFlags/team/memo 추정 금지.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export function parseDormitoryResidentFlag(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error("기숙사 여부는 true/false 여야 합니다."), {
      status: 400,
      code: "dormitory_resident_invalid",
    });
  }
  return value;
}

export async function writeCaddyDormitoryAudit(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    caddyId: number;
    name?: string | null;
    before: boolean;
    after: boolean;
    username?: string | null;
    userId?: number | null;
    ip?: string | null;
  }
) {
  if (input.before === input.after) return;
  await db.audit.create({
    data: {
      action: "CADDY_DORMITORY_CHANGE",
      entity: "Caddy",
      entityId: input.caddyId,
      ip: input.ip || null,
      payload: {
        caddyId: input.caddyId,
        name: input.name || null,
        before: input.before,
        after: input.after,
        user: input.username || null,
        userId: input.userId ?? null,
        createdAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
}
