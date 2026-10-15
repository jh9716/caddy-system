/**
 * FINALIZED 월 마샬 슬롯 → Daily Ops marshal duty read-only source.
 * DailyOpsDuty materialize / rotation generate / Sheet write 없음.
 * P2 slot 값(caddyId, source)을 다시 계산하지 않고 그대로 읽는다.
 *
 * 기존 8-key editor/Sheet 계약(마샬_조출_1/2, 마샬_후출_1)은 확장하지 않는다.
 * AM2+/PM1+ 는 monthly-only extra roleKey 로만 전달한다.
 */

import type { PrismaClient } from "@prisma/client";
import { parseYmd } from "@/lib/availabilityEngine";
import type { DailyOpsDutyRole } from "@/lib/dailyOpsDuty";
import { dutyEntriesFromStored } from "@/lib/dailyOpsDuty";
import { isOperationalCaddy } from "@/lib/operationalRoster";
import type { DutyExcelEntry } from "@/lib/opsDutyRoleKeys";
import { isOpsDutyRoleKey } from "@/lib/opsDutyRoleKeys";
import { prisma as defaultPrisma } from "@/lib/prisma";

/** Sheet/editor 8-key 안에 있는 마샬 칸. extra monthly slot은 여기 넣지 않는다. */
export const CONTRACT_MARSHAL_MONTH_ROLE_KEYS = [
  "마샬_조출_1",
  "마샬_조출_2",
  "마샬_후출_1",
] as const;

export const MARSHAL_MONTH_DUTY_ROLE_KEYS = CONTRACT_MARSHAL_MONTH_ROLE_KEYS;

export type MarshalMonthDutyRoleKey = (typeof CONTRACT_MARSHAL_MONTH_ROLE_KEYS)[number];

export type OpsDutyMarshalSource = "monthly" | "stored" | "sheet" | "none";

export type MonthlyMarshalDutyRow = {
  roleKey: string;
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

const MARSHAL_MONTH_ROLE_KEY_RE = /^마샬_(조출|후출)_([1-9]\d*)$/;

export function isMarshalMonthDutyRoleKey(value: unknown): boolean {
  return MARSHAL_MONTH_ROLE_KEY_RE.test(String(value || "").trim());
}

export function isContractMarshalRoleKey(value: unknown): boolean {
  return CONTRACT_MARSHAL_MONTH_ROLE_KEYS.includes(
    String(value || "").trim() as MarshalMonthDutyRoleKey
  );
}

/** 8-key editor/Sheet에 없는 FINALIZED extra slot (PM1+, AM2+). */
export function isMonthlyExtraMarshalRoleKey(value: unknown): boolean {
  const key = String(value || "").trim();
  return isMarshalMonthDutyRoleKey(key) && !isOpsDutyRoleKey(key);
}

export function opsDutyRoleFromMarshalMonthKey(
  roleKey: string
): Extract<DailyOpsDutyRole, "MARSHAL_AM" | "MARSHAL_PM"> | null {
  const match = String(roleKey || "").trim().match(MARSHAL_MONTH_ROLE_KEY_RE);
  if (!match) return null;
  return match[1] === "조출" ? "MARSHAL_AM" : "MARSHAL_PM";
}

/**
 * P2 slotIndex 0..7 → 마샬_조출_N / 마샬_후출_N.
 * 계약 3칸과 같은 이름을 쓰되, extra 칸은 OPS_DUTY_ROLE_KEYS에 추가하지 않는다.
 */
export function marshalMonthSlotToRoleKey(
  shift: unknown,
  slotIndex: unknown
): string | null {
  const normalized = String(shift ?? "").trim().toUpperCase();
  const index = Number(slotIndex);
  if (!Number.isInteger(index) || index < 0 || index > 7) return null;
  if (normalized === "AM" || normalized === "조출") return `마샬_조출_${index + 1}`;
  if (normalized === "PM" || normalized === "후출") return `마샬_후출_${index + 1}`;
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
    const role = opsDutyRoleFromMarshalMonthKey(roleKey);
    const caddyId = Number(slot.caddyId);
    const name = String(slot.name || slot.rawName || "").trim();
    if (!role || !Number.isInteger(caddyId) || caddyId < 1 || !name) continue;
    usedKeys.add(roleKey);
    rows.push({
      roleKey,
      role,
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
    (/MarshalMonthPlan|MarshalMonthSlot/.test(message) && /does not exist/i.test(message))
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

export function missingContractMarshalKeys(input: {
  storedRoleKeys?: readonly string[];
  monthlyRoleKeys?: readonly string[];
}): MarshalMonthDutyRoleKey[] {
  const have = new Set(
    [...(input.storedRoleKeys || []), ...(input.monthlyRoleKeys || [])].map((key) =>
      String(key || "").trim()
    )
  );
  return CONTRACT_MARSHAL_MONTH_ROLE_KEYS.filter((key) => !have.has(key));
}

/**
 * duty/leader: stored가 있으면 date-level stored (sheet duty/leader 차단).
 * marshal: key별로 stored marshal > sheet marshal.
 */
export function mergeLegacyDutyEntries(input: {
  stored: readonly {
    role: DailyOpsDutyRole | string;
    roleKey: string;
    rawName?: string | null;
    name?: string | null;
  }[];
  sheetEntries: readonly DutyExcelEntry[];
}): DutyExcelEntry[] {
  if (input.stored.length === 0) return [...input.sheetEntries];
  const storedEntries = dutyEntriesFromStored(input.stored);
  const storedKeys = new Set(storedEntries.map((entry) => entry.roleKey));
  const sheetMarshal = input.sheetEntries.filter(
    (entry) => isContractMarshalRoleKey(entry.roleKey) && !storedKeys.has(entry.roleKey)
  );
  return [...storedEntries, ...sheetMarshal];
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
    if (!isMarshalMonthDutyRoleKey(row.roleKey)) continue;
    if (!isOperationalCaddy(row)) continue;
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
  storedRoleKeys?: readonly string[];
  sheetMarshalRoleKeys?: readonly string[];
}): OpsDutyMarshalSource {
  if (input.monthlyRows.length > 0) return "monthly";
  const storedMarshal = (input.storedRoleKeys || []).some((key) =>
    isContractMarshalRoleKey(key)
  );
  if (storedMarshal) return "stored";
  const sheetMarshal = (input.sheetMarshalRoleKeys || []).some((key) =>
    isContractMarshalRoleKey(key)
  );
  if (sheetMarshal) return "sheet";
  return "none";
}

export function monthlyMarshalToDutyEntries(
  monthly: readonly MonthlyMarshalDutyRow[]
): DutyExcelEntry[] {
  return overlayMonthlyMarshalDutyEntries([], monthly);
}

export function marshalNonOperationalKeys(
  monthly: readonly MonthlyMarshalDutyRow[],
  caddies: readonly {
    id?: number;
    caddyId?: number;
    employmentStatus?: unknown;
    excludedReasons?: readonly string[] | null;
  }[]
): string[] {
  const byId = new Map(
    caddies.map((row) => [Number(row.id ?? row.caddyId), row] as const)
  );
  const keys: string[] = [];
  for (const row of monthly) {
    const current = byId.get(Number(row.caddyId));
    if (isOperationalCaddy(current || row)) continue;
    keys.push(row.roleKey);
  }
  return keys;
}
