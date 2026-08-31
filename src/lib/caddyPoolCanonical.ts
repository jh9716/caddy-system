/**
 * Date-local caddyPool / unavailable canonicalization.
 * Pool is a roster baseline. Temporary exclusions are applied at compute time.
 * previous.unavailableCaddyIds is never an authoritative SoT by itself.
 */

import {
  eligibleRegularReflowCaddies,
  regularCaddyPoolFromAvailabilityRows,
  splitCaddyPools,
  type AutoAssignCaddy,
  type SpareByShift,
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
