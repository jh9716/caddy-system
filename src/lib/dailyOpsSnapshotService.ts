/**
 * 관리자 대시보드 V2 Phase 2 snapshot 저장/조회.
 * GET 경로에서 호출하지 않는 capture만 write. sheet/autosync/DailyOpsDuty write 없음.
 */

import { parseYmd } from "@/lib/availabilityEngine";
import { loadAdminOpsDashboard } from "@/lib/adminOpsDashboardService";
import {
  DAILY_OPS_SNAPSHOT_SCHEMA_VERSION,
  dashboardViewFromLive,
  dashboardViewFromSnapshot,
  toDailyOpsSnapshotPayload,
  type AdminOpsDashboardView,
} from "@/lib/dailyOpsSnapshot";
import { isPastKstYmd, kstYmd } from "@/lib/kstDate";
import { prisma as defaultPrisma } from "@/lib/prisma";

export type DailyOpsSnapshotRow = {
  date: Date;
  payload: unknown;
  schemaVersion: number;
  capturedAt: Date;
};

export type DailyOpsSnapshotDb = {
  dailyOpsSnapshot: {
    findUnique: (args: {
      where: { date: Date };
    }) => Promise<DailyOpsSnapshotRow | null>;
    create: (args: {
      data: {
        date: Date;
        payload: object;
        schemaVersion: number;
        capturedAt: Date;
      };
    }) => Promise<DailyOpsSnapshotRow>;
  };
};

export type CaptureDailyOpsSnapshotResult = {
  status: "created" | "exists";
  date: string;
  capturedAt: string | null;
};

function dateKey(ymd: string): Date {
  return parseYmd(ymd).start;
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
  );
}

function isMissingTable(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2021"
  );
}

export async function findDailyOpsSnapshot(
  ymd: string,
  db: DailyOpsSnapshotDb = defaultPrisma as unknown as DailyOpsSnapshotDb
): Promise<DailyOpsSnapshotRow | null> {
  parseYmd(ymd);
  try {
    return await db.dailyOpsSnapshot.findUnique({ where: { date: dateKey(ymd) } });
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

export async function captureDailyOpsSnapshot(
  ymd: string,
  options?: {
    now?: Date;
    db?: DailyOpsSnapshotDb;
    loadLive?: typeof loadAdminOpsDashboard;
  }
): Promise<CaptureDailyOpsSnapshotResult> {
  parseYmd(ymd);
  const db = options?.db ?? (defaultPrisma as unknown as DailyOpsSnapshotDb);
  const loadLive = options?.loadLive ?? loadAdminOpsDashboard;
  const existing = await db.dailyOpsSnapshot.findUnique({
    where: { date: dateKey(ymd) },
  });
  if (existing) {
    return {
      status: "exists",
      date: ymd,
      capturedAt: existing.capturedAt.toISOString(),
    };
  }

  const live = await loadLive(ymd);
  const payload = toDailyOpsSnapshotPayload(live);
  const capturedAt = options?.now ?? new Date();
  try {
    const row = await db.dailyOpsSnapshot.create({
      data: {
        date: dateKey(ymd),
        payload,
        schemaVersion: DAILY_OPS_SNAPSHOT_SCHEMA_VERSION,
        capturedAt,
      },
    });
    return {
      status: "created",
      date: ymd,
      capturedAt: row.capturedAt.toISOString(),
    };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = await db.dailyOpsSnapshot.findUnique({
      where: { date: dateKey(ymd) },
    });
    return {
      status: "exists",
      date: ymd,
      capturedAt: raced?.capturedAt.toISOString() ?? null,
    };
  }
}

/**
 * 대시보드 GET용. 오늘/미래는 snapshot을 조회하지 않고 live만 반환.
 * write 없음.
 */
export async function loadAdminOpsDashboardView(
  ymd: string,
  options?: {
    now?: Date;
    db?: DailyOpsSnapshotDb;
    loadLive?: typeof loadAdminOpsDashboard;
  }
): Promise<AdminOpsDashboardView> {
  parseYmd(ymd);
  const now = options?.now ?? new Date();
  const loadLive = options?.loadLive ?? loadAdminOpsDashboard;
  const past = isPastKstYmd(ymd, now);

  if (!past) {
    return dashboardViewFromLive(await loadLive(ymd), false);
  }

  const db = options?.db ?? (defaultPrisma as unknown as DailyOpsSnapshotDb);
  const snap = await findDailyOpsSnapshot(ymd, db);
  if (snap) {
    return dashboardViewFromSnapshot({
      ymd,
      payload: snap.payload,
      capturedAt: snap.capturedAt,
    });
  }
  return dashboardViewFromLive(await loadLive(ymd), true);
}

export function todayKstYmd(now: Date = new Date()): string {
  return kstYmd(now);
}
