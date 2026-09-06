/**
 * Date-local caddyPool / unavailable canonicalization.
 * Pool is a roster baseline. Temporary exclusions are applied at compute time.
 * previous.unavailableCaddyIds is never an authoritative SoT by itself.
 */

import {
  eligibleRegularReflowCaddies,
  parseAssignShiftPart,
  regularCaddyPoolFromAvailabilityRows,
  splitCaddyPools,
  type AutoAssignCaddy,
  type SpareByShift,
  type UnavailableFromShiftRow,
} from "@/lib/autoAssignEngine";
import {
  isInactiveEmploymentAvailability,
  type AvailabilityResult,
  type AvailabilityRow,
} from "@/lib/availabilityEngine";
import type { ShiftPart } from "@/lib/reservationParser";

export type RosterBaselineRow = {
  id: number;
  name: string;
  team: string;
  teamOrder?: number;
  caddyType?: string | null;
  extraFlags?: string[] | null;
  employmentStatus?: string | null;
  thirdBandSubgroup?: string | null;
  excludedReasons?: readonly string[] | null;
};

export const OFF_SHEET_UNRESOLVED_CODE = "OFF_SHEET_UNRESOLVED";
export const OFF_SHEET_UNRESOLVED_USER_MESSAGE =
  "휴무 정보를 확인하지 못해 저장하지 못했습니다. 다시 시도해 주세요.";

export function uniquePositiveIds(ids: Iterable<unknown>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function mergeCaddyRoster(
  ...groups: Array<readonly AutoAssignCaddy[] | null | undefined>
): AutoAssignCaddy[] {
  const byId = new Map<number, AutoAssignCaddy>();
  for (const group of groups) {
    for (const caddy of group || []) {
      if (!caddy || !(caddy.id > 0)) continue;
      if (!byId.has(caddy.id)) byId.set(caddy.id, { ...caddy });
    }
  }
  return [...byId.values()];
}

/** Keep existing rows, then add any baseline members the stored pool lost. Never shrink. */
export function mergeRosterBaseline(
  existing: readonly AutoAssignCaddy[] | null | undefined,
  baseline: readonly AutoAssignCaddy[] | null | undefined
): AutoAssignCaddy[] {
  return mergeCaddyRoster(existing, baseline);
}

export function rosterBaselineFromAvailability(
  availability: Pick<AvailabilityResult, "available" | "special" | "excluded">
): AutoAssignCaddy[] {
  const rows = [
    ...(availability.available?.all || []),
    ...(availability.special || []),
    ...(availability.excluded || []),
  ];
  return rosterBaselineFromAvailabilityRows(rows);
}

export function rosterBaselineFromAvailabilityRows(
  rows: readonly RosterBaselineRow[]
): AutoAssignCaddy[] {
  return regularCaddyPoolFromAvailabilityRows(
    (rows || []).filter((row) => !isInactiveEmploymentAvailability(row))
  );
}

/**
 * Confirmed unavailable = current-date SoT only.
 * pending SICK/NOSHOW ids are projection-only until persist.
 */
export function resolveCanonicalUnavailableIds(input: {
  dailyUnavailableIds?: Iterable<unknown>;
  pendingRemoveCaddyIds?: Iterable<unknown>;
  previousUnavailableIds?: Iterable<unknown>;
}): number[] {
  void input.previousUnavailableIds;
  return uniquePositiveIds([
    ...(input.dailyUnavailableIds || []),
    ...(input.pendingRemoveCaddyIds || []),
  ]);
}

export function pendingRemoveCaddyIdsFromEvents(
  events: ReadonlyArray<{ type?: string; caddyId?: unknown }> | null | undefined
): number[] {
  return uniquePositiveIds(
    (events || [])
      .filter((event) => event?.type === "REMOVE_CADDY")
      .map((event) => event.caddyId)
  );
}

/** Assigned + spare ids currently on the confirmed board. */
export function placedCaddyIdsFromBoard(input: {
  assignments?: Array<{ caddy?: { id?: number } | null } | null> | null;
  sparesByShift?: Array<{
    spare1?: { caddyId?: number } | null;
    spare2?: { caddyId?: number } | null;
  } | null> | null;
}): Set<number> {
  const ids = new Set<number>();
  for (const row of input.assignments || []) {
    const id = Number(row?.caddy?.id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  for (const spare of input.sparesByShift || []) {
    const s1 = Number(spare?.spare1?.caddyId);
    const s2 = Number(spare?.spare2?.caddyId);
    if (Number.isInteger(s1) && s1 > 0) ids.add(s1);
    if (Number.isInteger(s2) && s2 > 0) ids.add(s2);
  }
  return ids;
}

export function parseUnavailableFromShift(value: unknown): ShiftPart {
  return parseAssignShiftPart(value) ?? "1부";
}

export function toUnavailableShiftEntries(
  rows:
    | Iterable<
        | UnavailableFromShiftRow
        | { caddyId?: unknown; effectiveFromShift?: unknown }
        | number
        | null
        | undefined
      >
    | null
    | undefined
): UnavailableFromShiftRow[] {
  const out: UnavailableFromShiftRow[] = [];
  const seen = new Set<number>();
  for (const raw of rows || []) {
    if (raw == null) continue;
    let id: number;
    let from: ShiftPart;
    if (typeof raw === "object") {
      id = Number(raw.caddyId);
      from = parseUnavailableFromShift(raw.effectiveFromShift);
    } else {
      id = Number(raw);
      from = "1부";
    }
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    out.push({ caddyId: id, effectiveFromShift: from });
  }
  return out;
}

export function mergeUnavailableShiftEntries(
  ...groups: Array<
    | Iterable<
        | UnavailableFromShiftRow
        | { caddyId?: unknown; effectiveFromShift?: unknown }
        | number
        | null
        | undefined
      >
    | null
    | undefined
  >
): UnavailableFromShiftRow[] {
  const byId = new Map<number, ShiftPart>();
  for (const group of groups) {
    for (const row of toUnavailableShiftEntries(group)) {
      byId.set(row.caddyId, row.effectiveFromShift);
    }
  }
  return [...byId.entries()].map(([caddyId, effectiveFromShift]) => ({
    caddyId,
    effectiveFromShift,
  }));
}

/**
 * Shift-aware leftover overlay.
 * All-day (1부) leftover still painted must not pull HOUSE forward.
 * Partial sick (2부/3부) stays unavailable from that shift even if still
 * placed on an earlier shift.
 */
export function overlayUnavailableKeepingShift(input: {
  dailyUnavailable?: Iterable<
    | UnavailableFromShiftRow
    | { caddyId?: unknown; effectiveFromShift?: unknown }
    | number
    | null
    | undefined
  > | null;
  pendingRemove?: Iterable<
    | UnavailableFromShiftRow
    | { caddyId?: unknown; effectiveFromShift?: unknown }
    | number
    | null
    | undefined
  > | null;
  placedIds: Iterable<unknown>;
}): UnavailableFromShiftRow[] {
  const placed = new Set(uniquePositiveIds(input.placedIds));
  return mergeUnavailableShiftEntries(
    input.dailyUnavailable,
    input.pendingRemove
  ).filter(
    (row) => !(placed.has(row.caddyId) && row.effectiveFromShift === "1부")
  );
}

/**
 * Live DailyCaddyUnavailable overlay for click/persist reflow.
 * Still-placed HOUSE stay on the board; leftover live SICK rows do not
 * pull-forward until a REMOVE_CADDY event (this click / pending intents).
 * ID-only input is all-day (1부): still-placed ids are dropped.
 */
export function overlayUnavailableIdsKeepingPlaced(input: {
  dailyUnavailableIds?: Iterable<unknown>;
  pendingRemoveCaddyIds?: Iterable<unknown>;
  placedIds: Iterable<unknown>;
}): number[] {
  const placed = new Set(uniquePositiveIds(input.placedIds));
  return resolveCanonicalUnavailableIds({
    dailyUnavailableIds: input.dailyUnavailableIds,
    pendingRemoveCaddyIds: input.pendingRemoveCaddyIds,
  }).filter((id) => !placed.has(id));
}

/** True when unused looks like (baseline − assigned), not engine leftover. */
export function isRosterSizedUnused(input: {
  rosterBaselineCount: number;
  assignedCount: number;
  unusedCount: number;
}): boolean {
  const { rosterBaselineCount, assignedCount, unusedCount } = input;
  if (unusedCount <= 0 || rosterBaselineCount <= 0) return false;
  const covered = assignedCount + unusedCount;
  return (
    covered >= Math.floor(rosterBaselineCount * 0.8) &&
    unusedCount >= Math.max(20, Math.floor(assignedCount * 0.2))
  );
}

export function isRosterSizedPool(
  poolCount: number,
  rosterBaselineCount: number
): boolean {
  if (poolCount <= 0 || rosterBaselineCount <= 0) return false;
  return poolCount >= Math.max(40, Math.floor(rosterBaselineCount * 0.8));
}

/**
 * Click-path compute pool from the already-confirmed snapshot.
 * Never uses a full roster baseline (휴무 included) as reflow candidates.
 * extraUsable may only append unused people — it must not replace assigned order.
 */
export function snapshotComputePool(input: {
  rosterBaseline: readonly AutoAssignCaddy[];
  assigned: readonly AutoAssignCaddy[];
  spareIds?: Iterable<unknown>;
  engineUnused?: readonly AutoAssignCaddy[] | null;
  extraUsable?: readonly AutoAssignCaddy[] | null;
  unavailableIds?: Iterable<unknown>;
  opsDutyIds?: Iterable<unknown>;
  specialSkipIds?: Iterable<unknown>;
  offSheetIds?: Iterable<unknown>;
}): AutoAssignCaddy[] {
  const exclusions = {
    unavailableIds: input.unavailableIds,
    opsDutyIds: input.opsDutyIds,
    specialSkipIds: input.specialSkipIds,
    offSheetIds: input.offSheetIds,
  };
  const extra = eligibleRegularReflowCaddies([...(input.extraUsable || [])]);
  const unused = eligibleRegularReflowCaddies([...(input.engineUnused || [])]);
  const unusedPolluted = isRosterSizedUnused({
    rosterBaselineCount: input.rosterBaseline.length,
    assignedCount: input.assigned.length,
    unusedCount: unused.length,
  });
  const assigned = eligibleRegularReflowCaddies([...(input.assigned || [])]);
  const byId = new Map<number, AutoAssignCaddy>();
  for (const caddy of [...input.rosterBaseline, ...assigned, ...unused, ...extra]) {
    if (caddy?.id > 0 && !byId.has(caddy.id)) byId.set(caddy.id, caddy);
  }
  const spares: AutoAssignCaddy[] = [];
  for (const raw of uniquePositiveIds(input.spareIds || [])) {
    const found = byId.get(raw);
    if (found) spares.push(found);
  }
  const seed = unusedPolluted
    ? mergeCaddyRoster(assigned, spares, extra)
    : mergeCaddyRoster(assigned, unused, spares, extra);
  return usableComputePool({
    rosterBaseline: seed,
    ...exclusions,
  });
}

export function usableComputePool(input: {
  rosterBaseline: readonly AutoAssignCaddy[];
  unavailableIds?: Iterable<unknown>;
  opsDutyIds?: Iterable<unknown>;
  specialSkipIds?: Iterable<unknown>;
  offSheetIds?: Iterable<unknown>;
}): AutoAssignCaddy[] {
  const skip = new Set(
    uniquePositiveIds([
      ...(input.unavailableIds || []),
      ...(input.opsDutyIds || []),
      ...(input.specialSkipIds || []),
      ...(input.offSheetIds || []),
    ])
  );
  return eligibleRegularReflowCaddies([...(input.rosterBaseline || [])]).filter(
    (caddy) => !skip.has(caddy.id)
  );
}

export function recoverComputePool(input: {
  clientPool: readonly AutoAssignCaddy[] | null | undefined;
  sotUsable: readonly AutoAssignCaddy[] | null | undefined;
  offSheetMatched: boolean;
  unavailableIds?: Iterable<unknown>;
  opsDutyIds?: Iterable<unknown>;
  specialSkipIds?: Iterable<unknown>;
}): AutoAssignCaddy[] {
  const skip = new Set(
    uniquePositiveIds([
      ...(input.unavailableIds || []),
      ...(input.opsDutyIds || []),
      ...(input.specialSkipIds || []),
    ])
  );
  const sot = eligibleRegularReflowCaddies([...(input.sotUsable || [])]).filter(
    (caddy) => !skip.has(caddy.id)
  );
  const client = eligibleRegularReflowCaddies([...(input.clientPool || [])]).filter(
    (caddy) => !skip.has(caddy.id)
  );
  if (!input.offSheetMatched) return client;
  const sotIds = new Set(sot.map((caddy) => caddy.id));
  return mergeCaddyRoster(
    client.filter((caddy) => sotIds.has(caddy.id)),
    sot
  );
}

export function recoverRosterBaseline(input: {
  clientPool: readonly AutoAssignCaddy[] | null | undefined;
  sotBaseline: readonly AutoAssignCaddy[] | null | undefined;
  offSheetMatched: boolean;
}): AutoAssignCaddy[] {
  const client = [...(input.clientPool || [])];
  if (!input.offSheetMatched) return mergeCaddyRoster(client);
  return mergeRosterBaseline(client, input.sotBaseline);
}

export type SpareBalance = {
  usableCandidates: number;
  requiredTeams: number;
  remainder: number;
  expectedUnassigned: number;
  expectSpare1: boolean;
  expectSpare2: boolean;
};

export function spareBalance(usableCandidates: number, requiredTeams: number): SpareBalance {
  const remainder = usableCandidates - requiredTeams;
  return {
    usableCandidates,
    requiredTeams,
    remainder,
    expectedUnassigned: remainder < 0 ? Math.abs(remainder) : 0,
    expectSpare1: remainder >= 1,
    expectSpare2: remainder >= 2,
  };
}

export function houseUsableCount(pool: readonly AutoAssignCaddy[]): number {
  return splitCaddyPools([...(pool || [])]).house.length;
}

export function assertSpareMatchesBalance(input: {
  shift: ShiftPart;
  usableHouse: number;
  requiredTeams: number;
  assigned: number;
  unassigned: number;
  spare1: { caddyId?: number } | null | undefined;
  spare2: { caddyId?: number } | null | undefined;
}): string[] {
  const errors: string[] = [];
  const bal = spareBalance(input.usableHouse, input.requiredTeams);
  if (input.unassigned !== bal.expectedUnassigned) {
    errors.push(
      `${input.shift} unassigned ${input.unassigned} != expected ${bal.expectedUnassigned}`
    );
  }
  if (input.assigned !== input.requiredTeams - bal.expectedUnassigned) {
    errors.push(
      `${input.shift} assigned ${input.assigned} != ${input.requiredTeams - bal.expectedUnassigned}`
    );
  }
  if (bal.expectSpare1 && !(input.spare1 && Number(input.spare1.caddyId) > 0)) {
    errors.push(`${input.shift} spare1 missing while R=${bal.remainder}`);
  }
  if (!bal.expectSpare1 && input.spare1) {
    errors.push(`${input.shift} spare1 present while R=${bal.remainder}`);
  }
  if (bal.expectSpare2 && !(input.spare2 && Number(input.spare2.caddyId) > 0)) {
    errors.push(`${input.shift} spare2 missing while R=${bal.remainder}`);
  }
  if (!bal.expectSpare2 && input.spare2) {
    errors.push(`${input.shift} spare2 present while R=${bal.remainder}`);
  }
  return errors;
}

export function spareForShift(
  spares: readonly SpareByShift[] | null | undefined,
  shift: ShiftPart
): SpareByShift | undefined {
  return (spares || []).find((row) => row.shift === shift);
}

export function availabilityRowsToCaddies(
  rows: readonly AvailabilityRow[] | readonly AutoAssignCaddy[] | null | undefined
): AutoAssignCaddy[] {
  return regularCaddyPoolFromAvailabilityRows(
    (rows || []).map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team,
      teamOrder: Number(row.teamOrder) || 0,
      caddyType: row.caddyType,
      extraFlags: "extraFlags" in row ? row.extraFlags ?? null : null,
      employmentStatus:
        "employmentStatus" in row ? row.employmentStatus ?? undefined : undefined,
      thirdBandSubgroup:
        "thirdBandSubgroup" in row ? row.thirdBandSubgroup ?? null : null,
    }))
  );
}
