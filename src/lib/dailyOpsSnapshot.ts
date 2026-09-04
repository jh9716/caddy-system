/**
 * 관리자 대시보드 V2 Phase 2 snapshot payload.
 * Phase 1 normalized presentation만 저장. 전화/차량/예약 개인정보 없음.
 */

import type {
  AdminOpsCaddyRow,
  AdminOpsDashboardPayload,
  AdminOpsDutyGroup,
  AdminOpsReasonCount,
  AdminOpsStatusTone,
} from "@/lib/adminOpsDashboard";
import type { AvailabilityBucket, CaddyTypeCode } from "@/lib/availabilityEngine";

export const DAILY_OPS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const SNAPSHOT_FORBIDDEN_KEYS = [
  "phone",
  "phoneNormalized",
  "vehicle",
  "vehicleNumber",
  "carNumber",
  "reservationId",
  "reservationKey",
  "teamName",
  "guestName",
  "customer",
  "customerName",
  "전화번호",
  "차량번호",
] as const;

export type DailyOpsSnapshotCaddy = {
  caddyId: number;
  name: string;
  team: string;
  caddyType: CaddyTypeCode;
  caddyTypeLabel: string;
  bucket: AvailabilityBucket;
  status: "available" | "excluded";
  statusLabel: string;
  statusTone: AdminOpsStatusTone;
  reasons: string[];
};

export type DailyOpsSnapshotBody = {
  schemaVersion: typeof DAILY_OPS_SNAPSHOT_SCHEMA_VERSION;
  date: string;
  roster: AdminOpsDashboardPayload["roster"];
  availability: AdminOpsDashboardPayload["availability"];
  opsDuties: AdminOpsDutyGroup[];
  caddies: DailyOpsSnapshotCaddy[];
};

export type AdminOpsDashboardView = Omit<
  AdminOpsDashboardPayload,
  "reconstructedFromCurrentRoster"
> & {
  reconstructedFromCurrentRoster: boolean;
  snapshotAvailable: boolean;
  capturedAt: string | null;
  source: "live" | "snapshot";
  isPastDate: boolean;
  sourceQuality: "complete" | "fallback" | "snapshot";
};

function asCaddyType(value: unknown): CaddyTypeCode {
  if (value === "THIRD" || value === "DRIVING" || value === "HOUSE") return value;
  return "HOUSE";
}

function asBucket(value: unknown): AvailabilityBucket {
  if (value === "special" || value === "excluded" || value === "available") return value;
  return "available";
}

function asStatus(value: unknown): "available" | "excluded" {
  return value === "excluded" ? "excluded" : "available";
}

function asTone(value: unknown): AdminOpsStatusTone {
  if (
    value === "off" ||
    value === "sick" ||
    value === "duty" ||
    value === "marshal" ||
    value === "leader" ||
    value === "other" ||
    value === "available"
  ) {
    return value;
  }
  return "other";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

export function toDailyOpsSnapshotPayload(
  dash: AdminOpsDashboardPayload
): DailyOpsSnapshotBody {
  return {
    schemaVersion: DAILY_OPS_SNAPSHOT_SCHEMA_VERSION,
    date: dash.date,
    roster: {
      activeCount: dash.roster.activeCount,
      houseCount: dash.roster.houseCount,
      thirdCount: dash.roster.thirdCount,
    },
    availability: {
      finalAvailable: dash.availability.finalAvailable,
      houseAvailable: dash.availability.houseAvailable,
      thirdAvailable: dash.availability.thirdAvailable,
      offCount: dash.availability.offCount,
      reasonCounts: dash.availability.reasonCounts.map((item: AdminOpsReasonCount) => ({
        reason: item.reason,
        count: item.count,
      })),
    },
    opsDuties: dash.opsDuties.map((group) => ({
      role: group.role,
      label: group.label,
      names: [...group.names],
    })),
    caddies: dash.caddies.map((row) => ({
      caddyId: row.id,
      name: row.name,
      team: row.team,
      caddyType: row.caddyType,
      caddyTypeLabel: row.caddyTypeLabel,
      bucket: row.bucket,
      status: row.status,
      statusLabel: row.statusLabel,
      statusTone: row.statusTone,
      reasons: [...row.reasons],
    })),
  };
}

export function snapshotCaddyToDashboardRow(row: DailyOpsSnapshotCaddy): AdminOpsCaddyRow {
  return {
    id: row.caddyId,
    name: row.name,
    team: row.team,
    caddyType: row.caddyType,
    caddyTypeLabel: row.caddyTypeLabel,
    bucket: row.bucket,
    status: row.status,
    statusLabel: row.statusLabel,
    statusTone: row.statusTone,
    reasons: [...row.reasons],
  };
}

export function parseDailyOpsSnapshotPayload(raw: unknown, ymd: string): DailyOpsSnapshotBody {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const roster = (obj.roster && typeof obj.roster === "object" ? obj.roster : {}) as Record<
    string,
    unknown
  >;
  const availability = (
    obj.availability && typeof obj.availability === "object" ? obj.availability : {}
  ) as Record<string, unknown>;
  const reasonCounts = Array.isArray(availability.reasonCounts)
    ? availability.reasonCounts
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          reason: String(item.reason ?? "").trim(),
          count: Number(item.count) || 0,
        }))
        .filter((item) => item.reason)
    : [];
  const opsDuties = Array.isArray(obj.opsDuties)
    ? obj.opsDuties
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          role: String(item.role ?? "") as AdminOpsDutyGroup["role"],
          label: String(item.label ?? ""),
          names: asStringList(item.names),
        }))
    : [];
  const caddies = Array.isArray(obj.caddies)
    ? obj.caddies
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          caddyId: Number(item.caddyId ?? item.id) || 0,
          name: String(item.name ?? ""),
          team: String(item.team ?? ""),
          caddyType: asCaddyType(item.caddyType),
          caddyTypeLabel: String(item.caddyTypeLabel ?? ""),
          bucket: asBucket(item.bucket),
          status: asStatus(item.status),
          statusLabel: String(item.statusLabel ?? (item.status === "excluded" ? "제외" : "가용")),
          statusTone: asTone(item.statusTone),
          reasons: asStringList(item.reasons),
        }))
        .filter((row) => row.caddyId > 0 && row.name)
    : [];

  return {
    schemaVersion: DAILY_OPS_SNAPSHOT_SCHEMA_VERSION,
    date: typeof obj.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.date) ? obj.date : ymd,
    roster: {
      activeCount: Number(roster.activeCount) || 0,
      houseCount: Number(roster.houseCount) || 0,
      thirdCount: Number(roster.thirdCount) || 0,
    },
    availability: {
      finalAvailable: Number(availability.finalAvailable) || 0,
      houseAvailable: Number(availability.houseAvailable) || 0,
      thirdAvailable: Number(availability.thirdAvailable) || 0,
      offCount: Number(availability.offCount) || 0,
      reasonCounts,
    },
    opsDuties,
    caddies,
  };
}

export function dashboardViewFromSnapshot(input: {
  ymd: string;
  payload: unknown;
  capturedAt: Date | string;
}): AdminOpsDashboardView {
  const body = parseDailyOpsSnapshotPayload(input.payload, input.ymd);
  const capturedAt =
    input.capturedAt instanceof Date
      ? input.capturedAt.toISOString()
      : String(input.capturedAt);
  return {
    date: body.date,
    reconstructedFromCurrentRoster: false,
    snapshotAvailable: true,
    capturedAt,
    source: "snapshot",
    isPastDate: true,
    sourceQuality: "snapshot",
    roster: body.roster,
    availability: body.availability,
    opsDuties: body.opsDuties,
    caddies: body.caddies.map(snapshotCaddyToDashboardRow),
  };
}

export function dashboardViewFromLive(
  dash: AdminOpsDashboardPayload,
  isPastDate: boolean,
  sourceQuality: "complete" | "fallback" = "complete"
): AdminOpsDashboardView {
  return {
    ...dash,
    reconstructedFromCurrentRoster: true,
    snapshotAvailable: false,
    capturedAt: null,
    source: "live",
    isPastDate,
    sourceQuality,
  };
}

export function snapshotHasForbiddenKeys(payload: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((SNAPSHOT_FORBIDDEN_KEYS as readonly string[]).includes(key)) found.add(key);
      walk(child);
    }
  };
  walk(payload);
  return [...found];
}
