/**
 * 운영현황 병가/결근 저장. DailyCaddyUnavailable 만 사용.
 * live-change reflow / DailyAssignmentChange 경로는 건드리지 않는다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  listUnavailablePanelRows,
  type UnavailablePanelSourceRow,
} from "@/lib/dailyBoardDraftService";

export class DailyUnavailableWriteError extends Error {
  status = 400;
  code = "daily_unavailable_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "DailyUnavailableWriteError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

export type DailyUnavailableReasonWrite = "SICK" | "ATTENDANCE_NOSHOW";
export type DailyUnavailableWriteAction = "SET" | "CLEAR";

function db(client?: PrismaClient) {
  return client ?? defaultPrisma;
}

function parseReason(raw: unknown): DailyUnavailableReasonWrite | null {
  const value = String(raw || "").trim().toUpperCase();
  if (value === "SICK" || value === "병가") return "SICK";
  if (value === "ATTENDANCE_NOSHOW" || value === "결근" || value === "NOSHOW") {
    return "ATTENDANCE_NOSHOW";
  }
  return null;
}

export async function writeDailyUnavailable(input: {
  date: string;
  action: DailyUnavailableWriteAction;
  caddyId: number;
  reason: unknown;
  client?: PrismaClient;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
}): Promise<{
  action: DailyUnavailableWriteAction;
  date: string;
  caddyId: number;
  reason: DailyUnavailableReasonWrite;
  rows: UnavailablePanelSourceRow[];
}> {
  parseYmd(input.date);
  const reason = parseReason(input.reason);
  if (!reason) {
    throw new DailyUnavailableWriteError(
      "reason=SICK|ATTENDANCE_NOSHOW 필요",
      "reason_invalid",
      400
    );
  }
  const action = String(input.action || "").toUpperCase();
  if (action !== "SET" && action !== "CLEAR") {
    throw new DailyUnavailableWriteError("action=SET|CLEAR 필요", "action_invalid", 400);
  }
  const caddyId = Number(input.caddyId);
  if (!Number.isInteger(caddyId) || caddyId < 1) {
    throw new DailyUnavailableWriteError("재직 캐디를 선택하세요.", "caddy_required", 400);
  }
  const { start } = parseYmd(input.date);
  const prisma = db(input.client);
  const caddy = await prisma.caddy.findUnique({
    where: { id: caddyId },
    select: { id: true, name: true, employmentStatus: true },
  });
  if (!caddy) {
    throw new DailyUnavailableWriteError("캐디를 찾을 수 없습니다.", "caddy_not_found", 404);
  }
  if (String(caddy.employmentStatus || "") !== "ACTIVE") {
    throw new DailyUnavailableWriteError(
      "재직 캐디만 선택할 수 있습니다.",
      "caddy_not_active",
      400
    );
  }

  const existing = await prisma.dailyCaddyUnavailable.findUnique({
    where: { date_caddyId: { date: start, caddyId } },
  });
  const before = existing
    ? { caddyId, reason: String(existing.reason), name: caddy.name }
    : null;

  if (action === "CLEAR") {
    if (existing && String(existing.reason) === reason) {
      await prisma.$transaction(async (tx) => {
        await tx.dailyCaddyUnavailable.deleteMany({
          where: { date: start, caddyId, reason },
        });
        await tx.audit.create({
          data: unavailableAudit({
            action: "CLEAR",
            date: input.date,
            caddyId,
            name: caddy.name,
            reason,
            ip: input.ip,
            username: input.username,
            userId: input.userId,
            before,
            after: null,
          }),
        });
      });
    }
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.dailyCaddyUnavailable.upsert({
        where: { date_caddyId: { date: start, caddyId } },
        create: { date: start, caddyId, reason },
        update: { reason, note: null },
      });
      await tx.audit.create({
        data: unavailableAudit({
          action: "SET",
          date: input.date,
          caddyId,
          name: caddy.name,
          reason,
          ip: input.ip,
          username: input.username,
          userId: input.userId,
          before,
          after: { caddyId, reason, name: caddy.name },
        }),
      });
    });
  }

  return {
    action: action as DailyUnavailableWriteAction,
    date: input.date,
    caddyId,
    reason,
    rows: await listUnavailablePanelRows(input.date),
  };
}

function unavailableAudit(input: {
  action: DailyUnavailableWriteAction;
  date: string;
  caddyId: number;
  name: string;
  reason: DailyUnavailableReasonWrite;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
  before: unknown;
  after: unknown;
}): Prisma.AuditCreateInput {
  return {
    action: `DAILY_UNAVAILABLE_${input.action}_${input.reason}`,
    entity: "DailyCaddyUnavailable",
    entityId: input.caddyId,
    ip: input.ip || null,
    payload: {
      date: input.date,
      caddyId: input.caddyId,
      name: input.name,
      reason: input.reason,
      before: input.before,
      after: input.after,
      user: input.username || null,
      userId: input.userId ?? null,
      createdAt: new Date().toISOString(),
    } as Prisma.InputJsonValue,
  };
}
