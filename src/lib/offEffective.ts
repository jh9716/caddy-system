/**
 * 현장 휴무 overlay 순수 함수.
 * 우선순위: FORCE_OFF > FORCE_AVAILABLE > Spreadsheet/offSnapshot 원본.
 * DailyCaddyUnavailable / DailyOpsDutyOverride 와 섞지 않는다.
 */

import { uniquePositiveIds } from "@/lib/caddyPoolCanonical";
import {
  offCaddyIdsFromNames,
  offNamesFromCaddyIds,
} from "@/lib/offSnapshot";
import type { NameMatchCaddy } from "@/lib/dailyCaddyNameMatch";

export const DAILY_OFF_OVERRIDE_ACTIONS = [
  "FORCE_OFF",
  "FORCE_AVAILABLE",
] as const;

export type DailyOffOverrideAction =
  (typeof DAILY_OFF_OVERRIDE_ACTIONS)[number];

export type DailyOffOverrideWriteAction =
  | DailyOffOverrideAction
  | "RESTORE";

export type OffOverrideInput = {
  caddyId: number;
  action: DailyOffOverrideAction;
};

export type EffectiveOffKind = "sheet" | "force_off" | "force_available";

export type EffectiveOffPerson = {
  caddyId: number;
  kind: EffectiveOffKind;
};

export type EffectiveOffResult = {
  baseOffCaddyIds: number[];
  offCaddyIds: number[];
  forceOffIds: number[];
  forceAvailableIds: number[];
  sheetOffIds: number[];
  people: EffectiveOffPerson[];
};

export function isDailyOffOverrideAction(
  value: unknown
): value is DailyOffOverrideAction {
  return (
    value === "FORCE_OFF" || value === "FORCE_AVAILABLE"
  );
}

export function isDailyOffOverrideWriteAction(
  value: unknown
): value is DailyOffOverrideWriteAction {
  return isDailyOffOverrideAction(value) || value === "RESTORE";
}

export function resolveEffectiveOff(input: {
  baseOffCaddyIds?: readonly number[] | null;
  overrides?: readonly OffOverrideInput[] | null;
}): EffectiveOffResult {
  const baseOffCaddyIds = uniquePositiveIds(input.baseOffCaddyIds || []);
  const byCaddy = new Map<number, DailyOffOverrideAction>();
  for (const row of input.overrides || []) {
    const id = Number(row.caddyId);
    if (!Number.isInteger(id) || id < 1) continue;
    if (!isDailyOffOverrideAction(row.action)) continue;
    byCaddy.set(id, row.action);
  }

  const forceOffIds: number[] = [];
  const forceAvailableIds: number[] = [];
  for (const [caddyId, action] of byCaddy) {
    if (action === "FORCE_OFF") forceOffIds.push(caddyId);
    else forceAvailableIds.push(caddyId);
  }
  forceOffIds.sort((a, b) => a - b);
  forceAvailableIds.sort((a, b) => a - b);

  const forceOff = new Set(forceOffIds);
  const forceAvailable = new Set(forceAvailableIds);
  const effective = new Set(baseOffCaddyIds);
  for (const id of forceAvailableIds) effective.delete(id);
  for (const id of forceOffIds) effective.add(id);

  const offCaddyIds = uniquePositiveIds(effective);
  const sheetOffIds = baseOffCaddyIds.filter(
    (id) => !forceOff.has(id) && !forceAvailable.has(id)
  );

  const people: EffectiveOffPerson[] = [
    ...sheetOffIds.map((caddyId) => ({ caddyId, kind: "sheet" as const })),
    ...forceOffIds.map((caddyId) => ({ caddyId, kind: "force_off" as const })),
    ...forceAvailableIds.map((caddyId) => ({
      caddyId,
      kind: "force_available" as const,
    })),
  ];

  return {
    baseOffCaddyIds,
    offCaddyIds,
    forceOffIds,
    forceAvailableIds,
    sheetOffIds,
    people,
  };
}

export function effectiveOffNamesFromBase(input: {
  caddies: readonly (NameMatchCaddy & { name: string })[];
  offNames?: readonly string[] | null;
  baseOffCaddyIds?: readonly number[] | null;
  overrides?: readonly OffOverrideInput[] | null;
}): { names: string[]; effective: EffectiveOffResult } {
  const baseOffCaddyIds =
    input.baseOffCaddyIds != null
      ? uniquePositiveIds(input.baseOffCaddyIds)
      : offCaddyIdsFromNames(input.offNames || [], input.caddies);
  const effective = resolveEffectiveOff({
    baseOffCaddyIds,
    overrides: input.overrides,
  });
  return {
    names: offNamesFromCaddyIds(input.caddies, effective.offCaddyIds),
    effective,
  };
}
