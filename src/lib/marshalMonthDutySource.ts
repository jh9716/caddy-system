/**
 * FINALIZED 월 마샬 슬롯 → Daily Ops marshal duty read-only source.
 * DailyOpsDuty materialize / rotation generate / Sheet write 없음.
 * P2 slot 값(caddyId, source)을 다시 계산하지 않고 그대로 읽는다.
 */

import type { PrismaClient } from "@prisma/client";
import { parseYmd } from "@/lib/availabilityEngine";
import type { DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import type { DutyExcelEntry } from "@/lib/opsDutyRoleKeys";
import { isOpsDutyRoleKey } from "@/lib/opsDutyRoleKeys";
import { prisma as defaultPrisma } from "@/lib/prisma";

export const MARSHAL_MONTH_DUTY_ROLE_KEYS = [
  "마샬_조출_1",
  "마샬_조출_2",
  "마샬_후출_1",
] as const;

export type MarshalMonthDutyRoleKey = (typeof MARSHAL_MONTH_DUTY_ROLE_KEYS)[number];

export type OpsDutyMarshalSource = "monthly" | "stored" | "sheet" | "none";

export type MonthlyMarshalDutyRow = {
  roleKey: MarshalMonthDutyRoleKey;
  role: Extract<DailyOpsDutyRole, "MARSHAL_AM" | "MARSHAL_PM">;
  caddyId: number;
  name: string;
  team: string;
  rawName: string;
  employmentStatus?: string;
  slotSource: string;
};

export type MonthlyMarshalDutyResult = {
  source: "monthly" | "none";
  planId: number | null;
  planStatus: "FINALIZED" | "DRAFT" | null;
  rows: MonthlyMarshalDutyRow[];
};

export type LoadMonthlyMarshalDutyDeps = {
  prisma?: PrismaClient;
};

const ROLE_FROM_KEY: Record<
  MarshalMonthDutyRoleKey,
  Extract<DailyOpsDutyRole, "MARSHAL_AM" | "MARSHAL_PM">
> = {
  마샬_조출_1: "MARSHAL_AM",
  마샬_조출_2: "MARSHAL_AM",
  마샬_후출_1: "MARSHAL_PM",
};

export function isMarshalMonthDutyRoleKey(
  value: unknown
): value is MarshalMonthDutyRoleKey {
  return MARSHAL_MONTH_DUTY_ROLE_KEYS.includes(String(value) as MarshalMonthDutyRoleKey);
}

/** 기존 8-key 계약에 있는 마샬 칸만 매핑. PM2+ / AM3+ 는 새 key를 만들지 않는다. */
export function marshalMonthSlotToRoleKey(
  shift: unknown,
  slotIndex: unknown
): MarshalMonthDutyRoleKey | null {
  const normalized = String(shift ?? "").trim().toUpperCase();
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  if (normalized === "AM" || normalized === "조출") {
    if (index === 0) return "마샬_조출_1";
    if (index === 1) return "마샬_조출_2";
    return null;
  }
  if (normalized === "PM" || normalized === "후출") {
    if (index === 0) return "마샬_후출_1";
    return null;
  }
  return null;
}

export function emptyMonthlyMarshalDutyResult(): MonthlyMarshalDutyResult {
  return {
    source: "none",
    planId: null,
    planStatus: null,
    rows: [],
  };
}

export function mapFinalizedMarshalSlots(input: {
  planId?: number | null;
  planStatus: string | null | undefined;
  slots: readonly {
    shift: unknown;
    slotIndex: unknown;
    caddyId: unknown;
    name?: unknown;
    team?: unknown;
    rawName?: unknown;
    employmentStatus?: unknown;
    source?: unknown;
  }[];
}): MonthlyMarshalDutyResult {
  const status = String(input.planStatus ?? "").trim().toUpperCase();
  if (status !== "FINALIZED") {
    return {
      source: "none",
      planId: Number.isInteger(Number(input.planId)) ? Number(input.planId) : null,
      planStatus: status === "DRAFT" ? "DRAFT" : null,
      rows: [],
    };
  }
  const planId = Number(input.planId);
  const rows: MonthlyMarshalDutyRow[] = [];
  const usedKeys = new Set<string>();
  for (const slot of input.slots) {
    const roleKey = marshalMonthSlotToRoleKey(slot.shift, slot.slotIndex);
    if (!roleKey || usedKeys.has(roleKey)) continue;
    const caddyId = Number(slot.caddyId);
    const name = String(slot.name || slot.rawName || "").trim();
    if (!Number.isInteger(caddyId) || caddyId < 1 || !name) continue;
    usedKeys.add(roleKey);
    rows.push({
      roleKey,
      role: ROLE_FROM_KEY[roleKey],
      caddyId,
      name,
      team: String(slot.team || "").trim() || "—",
      rawName: String(slot.rawName || name).trim(),
      employmentStatus: slot.employmentStatus
        ? String(slot.employmentStatus)
        : undefined,
      slotSource: String(slot.source || "").trim() || "ROTATION",
    });
  }
  return {
    source: rows.length > 0 ? "monthly" : "none",
    planId: Number.isInteger(planId) && planId > 0 ? planId : null,
    planStatus: "FINALIZED",
    rows,
  };
}

function isMissingMarshalMonthTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    ((/MarshalMonthPlan|MarshalMonthSlot/.test(message) &&
      /does not exist/i.test(message)))
  );
}

export async function loadFinalizedMarshalMonthDuty(
  ymd: string,
  deps: LoadMonthlyMarshalDutyDeps = {}
): Promise<MonthlyMarshalDutyResult> {
  parseYmd(ymd);
  const { start } = parseYmd(ymd);
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const db = deps.prisma ?? defaultPrisma;
  try {
    const plan = await db.marshalMonthPlan.findUnique({
      where: { year_month: { year, month } },
      select: { id: true, status: true },
    });
    if (!plan) return emptyMonthlyMarshalDutyResult();
    if (plan.status !== "FINALIZED") {
      return {
        source: "none",
        planId: plan.id,
        planStatus: plan.status === "DRAFT" ? "DRAFT" : null,
        rows: [],
      };
    }
    const slots = await db.marshalMonthSlot.findMany({
      where: { planId: plan.id, date: start },
      include: {
        caddy: {
          select: { id: true, name: true, team: true, employmentStatus: true },
        },
      },
      orderBy: [{ shift: "asc" }, { slotIndex: "asc" }, { id: "asc" }],
    });
    return mapFinalizedMarshalSlots({
      planId: plan.id,
      planStatus: plan.status,
      slots: slots.map((slot) => ({
        shift: slot.shift,
        slotIndex: slot.slotIndex,
        caddyId: slot.caddyId,
        name: slot.caddy?.name || "",
        team: slot.caddy?.team || "—",
        rawName: slot.caddy?.name || "",
        employmentStatus: slot.caddy?.employmentStatus,
        source: slot.source,
      })),
    });
  } catch (error) {
    if (isMissingMarshalMonthTable(error)) return emptyMonthlyMarshalDutyResult();
    throw error;
  }
}

export async function listFinalizedMarshalMonthDutyRows(
  ymd: string,
  deps: LoadMonthlyMarshalDutyDeps = {}
): Promise<MonthlyMarshalDutyRow[]> {
  const loaded = await loadFinalizedMarshalMonthDuty(ymd, deps);
  return loaded.rows;
}

export function overlayMonthlyMarshalDutyEntries(
  legacyEntries: readonly DutyExcelEntry[],
  monthly: readonly MonthlyMarshalDutyRow[]
): DutyExcelEntry[] {
  if (monthly.length === 0) return [...legacyEntries];
  const monthlyKeys = new Set<string>(monthly.map((row) => row.roleKey));
  const kept = legacyEntries.filter((entry) => !monthlyKeys.has(entry.roleKey));
  const extra: DutyExcelEntry[] = [];
  for (const row of monthly) {
    if (!isOpsDutyRoleKey(row.roleKey)) continue;
    const rawName = String(row.rawName || row.name || "").trim();
    if (!rawName) continue;
    extra.push({
      kind: row.role === "MARSHAL_PM" ? "marshal_pm" : "marshal_am",
      roleKey: row.roleKey,
      rawName,
    });
  }
  return [...kept, ...extra];
}

export function resolveMarshalDutySource(input: {
  monthlyRows: readonly MonthlyMarshalDutyRow[];
  legacySource: "stored" | "sheet" | "none";
  legacyEntries: readonly { roleKey?: string }[];
}): OpsDutyMarshalSource {
  if (input.monthlyRows.length > 0) return "monthly";
  const hasLegacyMarshal = input.legacyEntries.some((row) =>
    isMarshalMonthDutyRoleKey(row.roleKey)
  );
  if (!hasLegacyMarshal) return "none";
  if (input.legacySource === "stored") return "stored";
  if (input.legacySource === "sheet") return "sheet";
  return "none";
}

export function monthlyMarshalToDutyEntries(
  monthly: readonly MonthlyMarshalDutyRow[]
): DutyExcelEntry[] {
  return overlayMonthlyMarshalDutyEntries([], monthly);
}

export function opsDutyRoleFromMarshalMonthKey(
  roleKey: string
): DailyOpsDutyRole | null {
  if (!isMarshalMonthDutyRoleKey(roleKey)) return null;
  return ROLE_FROM_KEY[roleKey];
}
