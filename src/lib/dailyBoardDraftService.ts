/**
 * DailyBoardDraft persistence. Optimistic concurrency on version.
 * Draft reset never touches DailyReservation / DailyPlacement.
 */

import { Prisma } from "@prisma/client";
import { parseYmd } from "@/lib/availabilityEngine";
import {
  DailyBoardDraftPayloadError,
  DRAFT_VERSION_CONFLICT,
  DRAFT_VERSION_CONFLICT_MESSAGE,
  parseDailyBoardDraftPayload,
  type DailyBoardDraftPayloadV1,
  DAILY_BOARD_DRAFT_SCHEMA_VERSION,
} from "@/lib/dailyBoardDraft";
import { prisma as defaultPrisma } from "@/lib/prisma";

export { DRAFT_VERSION_CONFLICT, DRAFT_VERSION_CONFLICT_MESSAGE };

export class DailyBoardDraftConflictError extends Error {
  status = 409;
  code = DRAFT_VERSION_CONFLICT;
  current: DailyBoardDraftRecord | null;
  constructor(current: DailyBoardDraftRecord | null) {
    super(DRAFT_VERSION_CONFLICT_MESSAGE);
    this.name = "DailyBoardDraftConflictError";
    this.current = current;
  }
}

export type DailyBoardDraftRecord = {
  date: string;
  version: number;
  schemaVersion: number;
  payload: DailyBoardDraftPayloadV1;
  updatedAt: string;
  updatedByUserId: number | null;
  createdAt: string;
};

type DraftRow = {
  date: Date;
  version: number;
  schemaVersion: number;
  payload: unknown;
  updatedAt: Date;
  updatedByUserId: number | null;
  createdAt: Date;
};

export type DailyBoardDraftDb = {
  dailyBoardDraft: {
    findUnique: (args: {
      where: { date: Date };
    }) => Promise<DraftRow | null>;
    create: (args: {
      data: {
        date: Date;
        payload: unknown;
        schemaVersion: number;
        version: number;
        updatedByUserId: number | null;
      };
    }) => Promise<DraftRow>;
    updateMany: (args: {
      where: { date: Date; version: number };
      data: {
        payload: unknown;
        schemaVersion: number;
        version: number;
        updatedByUserId: number | null;
      };
    }) => Promise<{ count: number }>;
    deleteMany: (args: { where: { date: Date } }) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: DailyBoardDraftDb) => Promise<T>) => Promise<T>;
};

function ymdFromStoredDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateKey(ymd: string): Date {
  return parseYmd(ymd).start;
}

function toRecord(row: DraftRow, ymd: string): DailyBoardDraftRecord {
  const payload = parseDailyBoardDraftPayload(row.payload, ymd);
  return {
    date: ymd,
    version: row.version,
    schemaVersion: row.schemaVersion,
    payload,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return true;
  }
  return Boolean(
    e && typeof e === "object" && (e as { code?: string }).code === "P2002"
  );
}

export async function getDailyBoardDraft(
  ymd: string,
  db: DailyBoardDraftDb = defaultPrisma as unknown as DailyBoardDraftDb
): Promise<DailyBoardDraftRecord | null> {
  const row = await db.dailyBoardDraft.findUnique({
    where: { date: dateKey(ymd) },
  });
  if (!row) return null;
  return toRecord(row, ymd);
}

export async function saveDailyBoardDraft(input: {
  date: string;
  expectedVersion: number;
  payload: unknown;
  updatedByUserId: number | null;
  db?: DailyBoardDraftDb;
}): Promise<DailyBoardDraftRecord> {
  const ymd = input.date;
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new DailyBoardDraftPayloadError("version이 올바르지 않습니다.");
  }
  const payload = parseDailyBoardDraftPayload(input.payload, ymd);
  const db = input.db ?? (defaultPrisma as unknown as DailyBoardDraftDb);
  const key = dateKey(ymd);

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.dailyBoardDraft.findUnique({
        where: { date: key },
      });
      if (!existing) {
        if (expectedVersion !== 0) {
          throw new DailyBoardDraftConflictError(null);
        }
        const created = await tx.dailyBoardDraft.create({
          data: {
            date: key,
            payload,
            schemaVersion: DAILY_BOARD_DRAFT_SCHEMA_VERSION,
            version: 1,
            updatedByUserId: input.updatedByUserId,
          },
        });
        return toRecord(created, ymd);
      }
      if (existing.version !== expectedVersion) {
        throw new DailyBoardDraftConflictError(toRecord(existing, ymd));
      }
      const updated = await tx.dailyBoardDraft.updateMany({
        where: { date: key, version: expectedVersion },
        data: {
          payload,
          schemaVersion: DAILY_BOARD_DRAFT_SCHEMA_VERSION,
          version: expectedVersion + 1,
          updatedByUserId: input.updatedByUserId,
        },
      });
      if (updated.count !== 1) {
        const latest = await tx.dailyBoardDraft.findUnique({
          where: { date: key },
        });
        throw new DailyBoardDraftConflictError(
          latest ? toRecord(latest, ymd) : null
        );
      }
      const latest = await tx.dailyBoardDraft.findUnique({
        where: { date: key },
      });
      if (!latest) {
        throw new DailyBoardDraftConflictError(null);
      }
      return toRecord(latest, ymd);
    });
  } catch (e) {
    if (e instanceof DailyBoardDraftConflictError) throw e;
    if (isUniqueViolation(e)) {
      const latest = await db.dailyBoardDraft.findUnique({
        where: { date: key },
      });
      throw new DailyBoardDraftConflictError(
        latest ? toRecord(latest, ymd) : null
      );
    }
    throw e;
  }
}

/** Draft row만 삭제. DailyReservation / DailyPlacement 는 건드리지 않는다. */
export async function resetDailyBoardDraft(
  ymd: string,
  db: DailyBoardDraftDb = defaultPrisma as unknown as DailyBoardDraftDb
): Promise<{ deleted: boolean }> {
  const result = await db.dailyBoardDraft.deleteMany({
    where: { date: dateKey(ymd) },
  });
  return { deleted: result.count > 0 };
}

export { DailyBoardDraftPayloadError };
