/**
 * DailyBoardPublished persistence.
 * 같은 날짜 upsert만 수행. 다른 날짜 Published / Draft / Schedule / ShiftDuty 는 건드리지 않는다.
 */

import { parseYmd } from "@/lib/availabilityEngine";
import {
  getDailyBoardDraft,
  type DailyBoardDraftDb,
  type DailyBoardDraftRecord,
} from "@/lib/dailyBoardDraftService";
import {
  buildPublishedPayloadFromDraft,
  DailyBoardPublishedPayloadError,
  DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
  parseDailyBoardPublishedPayload,
  PUBLISH_NO_DRAFT,
  PUBLISH_NO_DRAFT_MESSAGE,
  PUBLISH_STALE_DRAFT,
  PUBLISH_STALE_DRAFT_MESSAGE,
  type DailyBoardPublishedPayloadV1,
} from "@/lib/dailyBoardPublished";
import { prisma as defaultPrisma } from "@/lib/prisma";

export {
  PUBLISH_NO_DRAFT,
  PUBLISH_NO_DRAFT_MESSAGE,
  PUBLISH_STALE_DRAFT,
  PUBLISH_STALE_DRAFT_MESSAGE,
};

export class DailyBoardPublishNoDraftError extends Error {
  status = 404;
  code = PUBLISH_NO_DRAFT;
  constructor() {
    super(PUBLISH_NO_DRAFT_MESSAGE);
    this.name = "DailyBoardPublishNoDraftError";
  }
}

export class DailyBoardPublishStaleError extends Error {
  status = 409;
  code = PUBLISH_STALE_DRAFT;
  currentDraft: DailyBoardDraftRecord | null;
  constructor(currentDraft: DailyBoardDraftRecord | null) {
    super(PUBLISH_STALE_DRAFT_MESSAGE);
    this.name = "DailyBoardPublishStaleError";
    this.currentDraft = currentDraft;
  }
}

export type DailyBoardPublishedRecord = {
  date: string;
  schemaVersion: number;
  sourceDraftVersion: number;
  payload: DailyBoardPublishedPayloadV1;
  publishedAt: string;
  publishedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type PublishedRow = {
  date: Date;
  schemaVersion: number;
  sourceDraftVersion: number;
  payload: unknown;
  publishedAt: Date;
  publishedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DailyBoardPublishedDb = {
  dailyBoardPublished: {
    findUnique: (args: {
      where: { date: Date };
    }) => Promise<PublishedRow | null>;
    upsert: (args: {
      where: { date: Date };
      create: {
        date: Date;
        payload: unknown;
        schemaVersion: number;
        sourceDraftVersion: number;
        publishedAt: Date;
        publishedByUserId: number | null;
      };
      update: {
        payload: unknown;
        schemaVersion: number;
        sourceDraftVersion: number;
        publishedAt: Date;
        publishedByUserId: number | null;
      };
    }) => Promise<PublishedRow>;
  };
};

export type PublishDailyBoardDb = DailyBoardPublishedDb & DailyBoardDraftDb;

export type PublishDailyBoardTimings = {
  getDraftMs: number;
  snapshotMs: number;
  upsertMs: number;
  totalMs: number;
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

function toRecord(row: PublishedRow, ymd: string): DailyBoardPublishedRecord {
  const payload = parseDailyBoardPublishedPayload(row.payload, ymd);
  return {
    date: ymd,
    schemaVersion: row.schemaVersion,
    sourceDraftVersion: row.sourceDraftVersion,
    payload,
    publishedAt: row.publishedAt.toISOString(),
    publishedByUserId: row.publishedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDailyBoardPublished(
  ymd: string,
  db: DailyBoardPublishedDb = defaultPrisma as unknown as DailyBoardPublishedDb
): Promise<DailyBoardPublishedRecord | null> {
  const row = await db.dailyBoardPublished.findUnique({
    where: { date: dateKey(ymd) },
  });
  if (!row) return null;
  return toRecord(row, ymdFromStoredDate(row.date) || ymd);
}

export async function publishDailyBoard(input: {
  date: string;
  expectedDraftVersion: number;
  publishedByUserId: number | null;
  publisherUsername?: string | null;
  db?: PublishDailyBoardDb;
  onTimings?: (timings: PublishDailyBoardTimings) => void;
}): Promise<DailyBoardPublishedRecord> {
  const expected = Number(input.expectedDraftVersion);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new DailyBoardPublishedPayloadError("draftVersion이 올바르지 않습니다.");
  }
  const db =
    input.db ??
    (defaultPrisma as unknown as PublishDailyBoardDb);
  const t0 = Date.now();
  const draft = await getDailyBoardDraft(input.date, db);
  const t1 = Date.now();
  if (!draft) {
    throw new DailyBoardPublishNoDraftError();
  }
  if (draft.version !== expected) {
    throw new DailyBoardPublishStaleError(draft);
  }
  const payload = buildPublishedPayloadFromDraft(draft.payload, {
    publisherUsername: input.publisherUsername ?? null,
  });
  const t2 = Date.now();
  const key = dateKey(input.date);
  const now = new Date();
  const row = await db.dailyBoardPublished.upsert({
    where: { date: key },
    create: {
      date: key,
      payload,
      schemaVersion: DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
      sourceDraftVersion: draft.version,
      publishedAt: now,
      publishedByUserId: input.publishedByUserId,
    },
    update: {
      payload,
      schemaVersion: DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
      sourceDraftVersion: draft.version,
      publishedAt: now,
      publishedByUserId: input.publishedByUserId,
    },
  });
  const t3 = Date.now();
  input.onTimings?.({
    getDraftMs: t1 - t0,
    snapshotMs: t2 - t1,
    upsertMs: t3 - t2,
    totalMs: t3 - t0,
  });
  return toRecord(row, input.date);
}

export { DailyBoardPublishedPayloadError, ymdFromStoredDate };
