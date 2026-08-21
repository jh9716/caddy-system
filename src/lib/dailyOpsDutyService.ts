/**
 * 당번·마샬·조장 일일 일정 저장 (Prisma)
 * 같은 날짜는 delete+createMany 교체. Caddy.employmentStatus는 변경하지 않음.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import type { DutyExcelEntry } from "@/lib/dutyMarshalLeaderParser";
import {
  dutyEntriesFromStored,
  matchDutyEntriesToCaddies,
  parseMatchedOpsDutyRows,
  type DailyOpsDutyRole,
  type MatchedOpsDutyRow,
  type OpsDutyReview,
} from "@/lib/dailyOpsDuty";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";

export class DailyOpsDutyError extends Error {
  status = 400;
  code = "daily_ops_duty_invalid";
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "DailyOpsDutyError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

export type StoredOpsDutyRow = {
  id: number;
  role: DailyOpsDutyRole;
  roleKey: string;
  caddyId: number;
  rawName: string;
  name: string;
  team: string;
  employmentStatus: string;
};

function db(client?: PrismaClient) {
  return client ?? defaultPrisma;
}

export async function listDailyOpsDuties(
  ymd: string,
  client?: PrismaClient
): Promise<StoredOpsDutyRow[]> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  const rows = await db(client).dailyOpsDuty.findMany({
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
    role: row.role as DailyOpsDutyRole,
    roleKey: row.roleKey,
    caddyId: row.caddyId,
    rawName: row.rawName,
    name: row.caddy.name,
    team: row.caddy.team,
    employmentStatus: row.caddy.employmentStatus,
  }));
}

export async function listDailyOpsDutyCaddyIds(
  ymd: string,
  client?: PrismaClient
): Promise<number[]> {
  const rows = await listDailyOpsDuties(ymd, client);
  return [...new Set(rows.map((r) => r.caddyId))];
}

export async function loadStoredDutyEntries(
  ymd: string,
  client?: PrismaClient
): Promise<DutyExcelEntry[]> {
  const rows = await listDailyOpsDuties(ymd, client);
  return dutyEntriesFromStored(rows);
}

export type ReplaceDailyOpsDutiesResult = {
  date: string;
  replaced: boolean;
  previousCount: number;
  saved: StoredOpsDutyRow[];
  reviews: OpsDutyReview[];
};

export async function previewDailyOpsDutyReplace(input: {
  date: string;
  entries: DutyExcelEntry[];
  caddies: NameMatchCaddy[];
  client?: PrismaClient;
}): Promise<{
  date: string;
  matched: MatchedOpsDutyRow[];
  reviews: OpsDutyReview[];
  existing: StoredOpsDutyRow[];
  existingCount: number;
}> {
  parseYmd(input.date);
  const { matched, reviews } = matchDutyEntriesToCaddies(
    input.entries,
    input.caddies
  );
  const existing = await listDailyOpsDuties(input.date, input.client);
  return {
    date: input.date,
    matched,
    reviews,
    existing,
    existingCount: existing.length,
  };
}

export async function replaceDailyOpsDuties(input: {
  date: string;
  matched: MatchedOpsDutyRow[];
  confirmReplace?: boolean;
  client?: PrismaClient;
  ip?: string | null;
}): Promise<ReplaceDailyOpsDutiesResult> {
  parseYmd(input.date);
  const { start } = parseYmd(input.date);
  let matched: MatchedOpsDutyRow[];
  try {
    matched = parseMatchedOpsDutyRows(input.matched);
  } catch (e: unknown) {
    throw new DailyOpsDutyError(
      e instanceof Error ? e.message : "matched[]가 올바르지 않습니다.",
      "matched_invalid",
      400
    );
  }
  const prisma = db(input.client);
  const existing = await listDailyOpsDuties(input.date, input.client);
  if (existing.length > 0 && input.confirmReplace !== true) {
    throw new DailyOpsDutyError(
      `이 날짜에 이미 당번·마샬·조장 일정 ${existing.length}건이 있습니다. 교체를 확정하세요.`,
      "replace_confirm_required",
      409
    );
  }

  const caddyIds = [...new Set(matched.map((r) => r.caddyId))];
  if (caddyIds.length) {
    const found = await prisma.caddy.findMany({
      where: { id: { in: caddyIds } },
      select: { id: true, name: true, employmentStatus: true },
    });
    const foundIds = new Set(found.map((c) => c.id));
    const missing = caddyIds.filter((id) => !foundIds.has(id));
    if (missing.length) {
      throw new DailyOpsDutyError(
        `존재하지 않는 캐디입니다: ${missing.join(", ")}`,
        "caddy_not_found",
        404
      );
    }
    const inactive = found.filter((c) => c.employmentStatus !== "ACTIVE");
    if (inactive.length) {
      throw new DailyOpsDutyError(
        `RETIRED/LEAVE 캐디는 당번·마샬·조장으로 저장하지 않습니다: ${inactive
          .map((c) => `${c.name}(${c.employmentStatus})`)
          .join(", ")}`,
        "inactive_caddy",
        400
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.dailyOpsDuty.deleteMany({ where: { date: start } });
    if (matched.length > 0) {
      await tx.dailyOpsDuty.createMany({
        data: matched.map((row) => ({
          date: start,
          role: row.role,
          roleKey: row.roleKey,
          caddyId: row.caddyId,
          rawName: row.rawName,
        })),
      });
    }
    await tx.audit.create({
      data: {
        action: "DAILY_OPS_DUTY_REPLACE",
        entity: "DailyOpsDuty",
        entityId: 0,
        ip: input.ip || null,
        payload: {
          date: input.date,
          previousCount: existing.length,
          savedCount: matched.length,
          caddyIds: matched.map((r) => r.caddyId),
          roles: matched.map((r) => r.role),
        } as Prisma.InputJsonValue,
      },
    });
  });

  const saved = await listDailyOpsDuties(input.date, input.client);
  return {
    date: input.date,
    replaced: existing.length > 0,
    previousCount: existing.length,
    saved,
    reviews: [],
  };
}
