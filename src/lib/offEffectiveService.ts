/**
 * 현장 휴무 overlay 저장 + effective resolver.
 * Spreadsheet / offSnapshot 원본은 쓰지 않는다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  isDailyOffOverrideWriteAction,
  resolveEffectiveOff,
  type DailyOffOverrideAction,
  type DailyOffOverrideWriteAction,
  type EffectiveOffResult,
  type OffOverrideInput,
} from "@/lib/offEffective";

export class DailyOffOverrideError extends Error {
  status = 400;
  code = "daily_off_override_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "DailyOffOverrideError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

export type StoredOffOverrideRow = OffOverrideInput & {
  id: number;
  name: string;
  team: string;
  employmentStatus: string;
};

export type ResolveEffectiveOffResult = EffectiveOffResult & {
  date: string;
  overrides: StoredOffOverrideRow[];
};

function db(client?: PrismaClient) {
  return client ?? defaultPrisma;
}

function isMissingOverrideTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    (/DailyOffOverride/.test(message) && /does not exist/i.test(message))
  );
}

export async function listDailyOffOverrides(
  ymd: string,
  client?: PrismaClient
): Promise<StoredOffOverrideRow[]> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  try {
    const rows = await db(client).dailyOffOverride.findMany({
      where: { date: start },
      include: {
        caddy: {
          select: { id: true, name: true, team: true, employmentStatus: true },
        },
      },
      orderBy: [{ caddyId: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      caddyId: row.caddyId,
      action: row.action as DailyOffOverrideAction,
      name: row.caddy?.name || "",
      team: row.caddy?.team || "—",
      employmentStatus: String(row.caddy?.employmentStatus || ""),
    }));
  } catch (error) {
    if (isMissingOverrideTable(error)) return [];
    throw error;
  }
}

export async function resolveEffectiveOffForDate(
  ymd: string,
  input: {
    baseOffCaddyIds?: readonly number[] | null;
    client?: PrismaClient;
    listOverrides?: (date: string) => Promise<StoredOffOverrideRow[]>;
  } = {}
): Promise<ResolveEffectiveOffResult> {
  parseYmd(ymd);
  const listOverrides =
    input.listOverrides ?? ((date: string) => listDailyOffOverrides(date, input.client));
  const overrides = await listOverrides(ymd);
  return {
    date: ymd,
    overrides,
    ...resolveEffectiveOff({
      baseOffCaddyIds: input.baseOffCaddyIds,
      overrides,
    }),
  };
}

export type OffOverrideWriteResult = ResolveEffectiveOffResult & {
  action: DailyOffOverrideWriteAction;
  caddyId: number;
};

export async function writeDailyOffOverride(input: {
  date: string;
  action: DailyOffOverrideWriteAction;
  caddyId: number;
  client?: PrismaClient;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
}): Promise<OffOverrideWriteResult> {
  parseYmd(input.date);
  if (!isDailyOffOverrideWriteAction(input.action)) {
    throw new DailyOffOverrideError(
      "action=FORCE_OFF|FORCE_AVAILABLE|RESTORE 필요",
      "action_invalid",
      400
    );
  }
  const caddyId = Number(input.caddyId);
  if (!Number.isInteger(caddyId) || caddyId < 1) {
    throw new DailyOffOverrideError("재직 캐디를 선택하세요.", "caddy_required", 400);
  }
  const { start } = parseYmd(input.date);
  const prisma = db(input.client);

  if (input.action !== "RESTORE") {
    try {
      await prisma.dailyOffOverride.findFirst({
        where: { date: start },
        select: { id: true },
      });
    } catch (error) {
      if (isMissingOverrideTable(error)) {
        throw new DailyOffOverrideError(
          "휴무 수동수정 테이블이 아직 적용되지 않았습니다.",
          "override_table_missing",
          503
        );
      }
      throw error;
    }
  }

  const caddy = await prisma.caddy.findUnique({
    where: { id: caddyId },
    select: { id: true, name: true, team: true, employmentStatus: true },
  });
  if (!caddy) {
    throw new DailyOffOverrideError("캐디를 찾을 수 없습니다.", "caddy_not_found", 404);
  }
  if (String(caddy.employmentStatus || "") !== "ACTIVE") {
    throw new DailyOffOverrideError("재직 캐디만 선택할 수 있습니다.", "caddy_not_active", 400);
  }

  const beforeOverrides = await listDailyOffOverrides(input.date, input.client);
  const beforeRow = beforeOverrides.find((row) => row.caddyId === caddyId) || null;
  const before = beforeRow
    ? { action: beforeRow.action, caddyId: beforeRow.caddyId, name: beforeRow.name }
    : null;

  if (input.action === "RESTORE") {
    if (beforeRow) {
      await prisma.$transaction(async (tx) => {
        await tx.dailyOffOverride.deleteMany({
          where: { date: start, caddyId },
        });
        await tx.audit.create({
          data: auditPayload({
            action: "RESTORE",
            date: input.date,
            caddyId,
            name: caddy.name,
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
    const after = {
      action: input.action,
      caddyId,
      name: caddy.name,
    };
    await prisma.$transaction(async (tx) => {
      await tx.dailyOffOverride.upsert({
        where: { date_caddyId: { date: start, caddyId } },
        create: {
          date: start,
          caddyId,
          action: input.action,
        },
        update: {
          action: input.action,
        },
      });
      await tx.audit.create({
        data: auditPayload({
          action: input.action,
          date: input.date,
          caddyId,
          name: caddy.name,
          ip: input.ip,
          username: input.username,
          userId: input.userId,
          before,
          after,
        }),
      });
    });
  }

  const resolved = await resolveEffectiveOffForDate(input.date, {
    client: input.client,
  });
  return { ...resolved, action: input.action, caddyId };
}

function auditPayload(input: {
  action: DailyOffOverrideWriteAction;
  date: string;
  caddyId: number;
  name: string;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
  before: unknown;
  after: unknown;
}): Prisma.AuditCreateInput {
  return {
    action: `DAILY_OFF_OVERRIDE_${input.action}`,
    entity: "DailyOffOverride",
    entityId: input.caddyId,
    ip: input.ip || null,
    payload: {
      date: input.date,
      caddyId: input.caddyId,
      name: input.name,
      before: input.before,
      after: input.after,
      user: input.username || null,
      userId: input.userId ?? null,
      createdAt: new Date().toISOString(),
    } as Prisma.InputJsonValue,
  };
}

export function offOverrideWriteJson(result: OffOverrideWriteResult) {
  return {
    ok: true,
    action: result.action,
    date: result.date,
    caddyId: result.caddyId,
    baseOffCaddyIds: result.baseOffCaddyIds,
    offCaddyIds: result.offCaddyIds,
    forceOffIds: result.forceOffIds,
    forceAvailableIds: result.forceAvailableIds,
    overrides: result.overrides.map((row) => ({
      caddyId: row.caddyId,
      action: row.action,
      name: row.name,
      team: row.team,
    })),
  };
}
