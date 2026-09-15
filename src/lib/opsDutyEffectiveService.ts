/**
 * 당번·마샬·조장 effective resolver + 현장 override 저장.
 * DailyOpsDuty / Google Spreadsheet 는 쓰지 않는다.
 * 자동배치 exclusion / Dashboard GET 계약은 이 모듈을 연결하지 않는다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import { countByOpsRole, type DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import { DailyOpsDutyError } from "@/lib/dailyOpsDutyService";
import type { DutyExcelEntry } from "@/lib/opsDutyRoleKeys";
import { isOpsDutyRoleKey } from "@/lib/opsDutyRoleKeys";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
  type OpsDutyPanelRow,
  type OpsDutyReadOnlySource,
  type ResolveOpsDutyReadOnlyDeps,
} from "@/lib/opsDutyReadOnlySource";
import {
  applyOpsDutyOverrides,
  buildOpsDutySlotStates,
  effectiveDutyEntriesFromRows,
  effectiveOpsDutyCaddyIds,
  opsDutyRoleFromRoleKey,
  publicOpsDutyRows,
  sameRoleCaddyConflict,
  type EffectiveOpsDutyRow,
  type OpsDutyOverrideInput,
  type OpsDutyOverrideWriteAction,
  type OpsDutySlotState,
} from "@/lib/opsDutyEffective";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";

export type StoredOpsDutyOverrideRow = OpsDutyOverrideInput & {
  id: number;
};

export type EffectiveOpsDutyResult = {
  date: string;
  baseSource: OpsDutyReadOnlySource;
  persisted: boolean;
  error: string | null;
  storedCount: number;
  overrideCount: number;
  rows: EffectiveOpsDutyRow[];
  slots: OpsDutySlotState[];
  entries: DutyExcelEntry[];
  caddyIds: number[];
  byRole: ReturnType<typeof countByOpsRole>;
  baseRows: OpsDutyPanelRow[];
  overrides: StoredOpsDutyOverrideRow[];
};

export type ResolveEffectiveOpsDutyDeps = ResolveOpsDutyReadOnlyDeps & {
  listOverrides?: (ymd: string) => Promise<StoredOpsDutyOverrideRow[]>;
  listCaddies?: () => Promise<
    Array<NameMatchCaddy & { team?: string; employmentStatus?: string }>
  >;
};

function isMissingOverrideTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    (/DailyOpsDutyOverride/.test(message) && /does not exist/i.test(message))
  );
}

function db(client?: PrismaClient) {
  return client ?? defaultPrisma;
}

export async function listDailyOpsDutyOverrides(
  ymd: string,
  client?: PrismaClient
): Promise<StoredOpsDutyOverrideRow[]> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  try {
    const rows = await db(client).dailyOpsDutyOverride.findMany({
      where: { date: start },
      include: {
        caddy: {
          select: { id: true, name: true, team: true, employmentStatus: true },
        },
      },
      orderBy: [{ roleKey: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      roleKey: row.roleKey,
      role: row.role as DailyOpsDutyRole,
      action: row.action as OpsDutyOverrideInput["action"],
      caddyId: row.caddyId,
      name: row.caddy?.name || row.rawName || "",
      rawName: row.rawName,
      team: row.caddy?.team || "—",
    }));
  } catch (error) {
    if (isMissingOverrideTable(error)) return [];
    throw error;
  }
}

export async function resolveEffectiveOpsDuty(
  ymd: string,
  deps: ResolveEffectiveOpsDutyDeps = {}
): Promise<EffectiveOpsDutyResult> {
  parseYmd(ymd);
  const listOverrides = deps.listOverrides ?? ((date: string) => listDailyOpsDutyOverrides(date));
  const listCaddies =
    deps.listCaddies ??
    (async () =>
      db().caddy.findMany({
        select: { id: true, name: true, team: true, employmentStatus: true },
      }));

  const [base, overrides, caddies] = await Promise.all([
    resolveOpsDutyReadOnly(ymd, deps),
    listOverrides(ymd),
    listCaddies(),
  ]);
  const baseRows = opsDutyPanelRowsFromReadOnly(base, caddies);
  const rows = applyOpsDutyOverrides(baseRows, overrides);
  return {
    date: ymd,
    baseSource: base.source,
    persisted: base.source === "stored",
    error: base.error,
    storedCount: base.stored.length,
    overrideCount: overrides.length,
    rows,
    slots: buildOpsDutySlotStates(baseRows, overrides),
    entries: effectiveDutyEntriesFromRows(rows),
    caddyIds: effectiveOpsDutyCaddyIds(rows),
    byRole: countByOpsRole(rows),
    baseRows,
    overrides,
  };
}

export type OpsDutyOverrideWriteResult = EffectiveOpsDutyResult & {
  action: OpsDutyOverrideWriteAction;
  roleKey: string;
};

export async function writeDailyOpsDutyOverride(input: {
  date: string;
  roleKey: string;
  action: OpsDutyOverrideWriteAction;
  caddyId?: number | null;
  client?: PrismaClient;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
}): Promise<OpsDutyOverrideWriteResult> {
  parseYmd(input.date);
  const { start } = parseYmd(input.date);
  const roleKey = String(input.roleKey || "").trim();
  if (!isOpsDutyRoleKey(roleKey)) {
    throw new DailyOpsDutyError(
      `알 수 없는 역할 슬롯입니다: ${roleKey || "(empty)"}`,
      "role_key_invalid",
      400
    );
  }
  const role = opsDutyRoleFromRoleKey(roleKey);
  if (!role) {
    throw new DailyOpsDutyError("roleKey가 올바르지 않습니다.", "role_key_invalid", 400);
  }

  const prisma = db(input.client);
  if (input.action !== "RESTORE") {
    try {
      await prisma.dailyOpsDutyOverride.findFirst({
        where: { date: start },
        select: { id: true },
      });
    } catch (error) {
      if (isMissingOverrideTable(error)) {
        throw new DailyOpsDutyError(
          "운영현황 수동수정 테이블이 아직 적용되지 않았습니다.",
          "override_table_missing",
          503
        );
      }
      throw error;
    }
  }
  const before = await resolveEffectiveOpsDuty(input.date, {
    listOverrides: (date) => listDailyOpsDutyOverrides(date, input.client),
  });
  const beforeSlot = before.slots.find((slot) => slot.roleKey === roleKey) || null;
  const beforeRow = before.overrides.find((row) => row.roleKey === roleKey) || null;

  if (input.action === "RESTORE") {
    if (beforeRow) {
      await prisma.$transaction(async (tx) => {
        await tx.dailyOpsDutyOverride.deleteMany({
          where: { date: start, roleKey },
        });
        await tx.audit.create({
          data: auditPayload({
            action: "RESTORE",
            date: input.date,
            roleKey,
            ip: input.ip,
            username: input.username,
            userId: input.userId,
            before: snapshotSlot(beforeSlot, beforeRow),
            after: null,
          }),
        });
      });
    }
    const after = await resolveEffectiveOpsDuty(input.date, {
      listOverrides: (date) => listDailyOpsDutyOverrides(date, input.client),
    });
    return { ...after, action: "RESTORE", roleKey };
  }

  if (input.action === "SET") {
    const caddyId = Number(input.caddyId);
    if (!Number.isInteger(caddyId) || caddyId < 1) {
      throw new DailyOpsDutyError("caddyId가 필요합니다.", "caddy_required", 400);
    }
    const caddy = await prisma.caddy.findUnique({
      where: { id: caddyId },
      select: { id: true, name: true, team: true, employmentStatus: true },
    });
    if (!caddy) {
      throw new DailyOpsDutyError("존재하지 않는 캐디입니다.", "caddy_not_found", 404);
    }
    if (caddy.employmentStatus !== "ACTIVE") {
      throw new DailyOpsDutyError(
        `RETIRED/LEAVE 캐디는 당번·마샬·조장으로 지정하지 않습니다: ${caddy.name}(${caddy.employmentStatus})`,
        "inactive_caddy",
        400
      );
    }
    const conflict = sameRoleCaddyConflict(before.rows, role, roleKey, caddyId);
    if (conflict) {
      throw new DailyOpsDutyError(
        "같은 역할에 동일 캐디가 중복됩니다.",
        "duplicate_role_caddy",
        409
      );
    }
    await prisma.$transaction(async (tx) => {
      await tx.dailyOpsDutyOverride.upsert({
        where: { date_roleKey: { date: start, roleKey } },
        create: {
          date: start,
          role,
          roleKey,
          action: "SET",
          caddyId: caddy.id,
          rawName: caddy.name,
        },
        update: {
          role,
          action: "SET",
          caddyId: caddy.id,
          rawName: caddy.name,
        },
      });
      await tx.audit.create({
        data: auditPayload({
          action: "SET",
          date: input.date,
          roleKey,
          ip: input.ip,
          username: input.username,
          userId: input.userId,
          before: snapshotSlot(beforeSlot, beforeRow),
          after: { action: "SET", caddyId: caddy.id, name: caddy.name },
        }),
      });
    });
    const after = await resolveEffectiveOpsDuty(input.date, {
      listOverrides: (date) => listDailyOpsDutyOverrides(date, input.client),
    });
    return { ...after, action: "SET", roleKey };
  }

  await prisma.$transaction(async (tx) => {
    await tx.dailyOpsDutyOverride.upsert({
      where: { date_roleKey: { date: start, roleKey } },
      create: {
        date: start,
        role,
        roleKey,
        action: "CLEAR",
        caddyId: null,
        rawName: null,
      },
      update: {
        role,
        action: "CLEAR",
        caddyId: null,
        rawName: null,
      },
    });
    await tx.audit.create({
      data: auditPayload({
        action: "CLEAR",
        date: input.date,
        roleKey,
        ip: input.ip,
        username: input.username,
        userId: input.userId,
        before: snapshotSlot(beforeSlot, beforeRow),
        after: { action: "CLEAR", caddyId: null, name: null },
      }),
    });
  });
  const after = await resolveEffectiveOpsDuty(input.date, {
    listOverrides: (date) => listDailyOpsDutyOverrides(date, input.client),
  });
  return { ...after, action: "CLEAR", roleKey };
}

function snapshotSlot(
  slot: OpsDutySlotState | null,
  override: StoredOpsDutyOverrideRow | null
) {
  return {
    person: slot?.person || null,
    overridden: Boolean(slot?.overridden),
    overrideAction: override?.action || null,
    overrideCaddyId: override?.caddyId ?? null,
  };
}

function auditPayload(input: {
  action: OpsDutyOverrideWriteAction;
  date: string;
  roleKey: string;
  ip?: string | null;
  username?: string | null;
  userId?: number | null;
  before: unknown;
  after: unknown;
}): Prisma.AuditCreateInput {
  return {
    action: `DAILY_OPS_DUTY_OVERRIDE_${input.action}`,
    entity: "DailyOpsDutyOverride",
    entityId: 0,
    ip: input.ip || null,
    payload: {
      date: input.date,
      roleKey: input.roleKey,
      action: input.action,
      before: input.before,
      after: input.after,
      user: input.username || null,
      userId: input.userId ?? null,
    } as Prisma.InputJsonValue,
  };
}

/** POST override 응답. GET UI 계약에 slots를 넣지 않는다. */
export function overrideWriteJson(result: OpsDutyOverrideWriteResult) {
  return {
    ok: true,
    action: result.action,
    roleKey: result.roleKey,
    date: result.date,
    source: result.baseSource,
    persisted: result.persisted,
    count: result.rows.length,
    byRole: result.byRole,
    caddyIds: result.caddyIds,
    rows: publicOpsDutyRows(result.rows),
    error: result.error,
    overrideCount: result.overrideCount,
    storedCount: result.storedCount,
  };
}
