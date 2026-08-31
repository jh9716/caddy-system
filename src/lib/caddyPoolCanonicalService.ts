/**
 * Server SoT loader for caddyPool / unavailable.
 * Production writes: none. Off-sheet miss does not expand the pool.
 */

import { prisma as defaultPrisma } from "@/lib/prisma";
import { parseYmd } from "@/lib/availabilityEngine";
import { computeAvailability } from "@/lib/availabilityEngine";
import {
  applyDailyExternalExclusions,
} from "@/lib/dailyAvailabilityOverlay";
import {
  fetchPublishedOffSheets,
  peekCachedOffSheets,
  peekCachedOffSheetsForDate,
} from "@/lib/offSheetFetch";
import { offNamesForDate } from "@/lib/offSheetParser";
import { listDailyOpsDutyCaddyIds, loadStoredDutyEntries } from "@/lib/dailyOpsDutyService";
import { listDailySpecialDutyRecords } from "@/lib/dailySpecialDutyService";
import {
  recoverComputePool,
  recoverRosterBaseline,
  resolveCanonicalUnavailableIds,
  rosterBaselineFromAvailability,
  uniquePositiveIds,
  usableComputePool,
  type RosterBaselineRow,
} from "@/lib/caddyPoolCanonical";
import {
  regularCaddyPoolFromAvailabilityRows,
  type AutoAssignCaddy,
} from "@/lib/autoAssignEngine";

export type CanonicalOffSheetMode = "cache" | "fetch" | "cache-or-fetch";

/** Persist may wait 1–4s for OFF SoT. UI does not wait; do not treat 4s as miss. */
export const OFF_SHEET_RESOLVE_TIMEOUT_MS = 15_000;

export type CanonicalReflowState = {
  rosterBaseline: AutoAssignCaddy[];
  computePool: AutoAssignCaddy[];
  unavailableIds: number[];
  opsDutyIds: number[];
  specialSkipIds: number[];
  offSheetMatched: boolean;
  offSheetSource: "cache" | "miss" | "fetch" | "skipped";
};

export type LoadCanonicalReflowOptions = {
  offSheetMode?: CanonicalOffSheetMode;
  /** Recover compute from this pool. Roster baseline still uses clientPool. */
  computeClientPool?: readonly AutoAssignCaddy[] | null;
};

export async function resolveCanonicalOffSheet(
  ymd: string,
  mode: CanonicalOffSheetMode = "fetch"
): Promise<{
  matched: boolean;
  names: string[];
  source: CanonicalReflowState["offSheetSource"];
}> {
  const year = Number(ymd.slice(0, 4));
  if (!Number.isInteger(year) || year >= 2090) {
    return { matched: false, names: [], source: "skipped" };
  }

  const fromSheets = (sheets: Awaited<ReturnType<typeof fetchPublishedOffSheets>>, source: CanonicalReflowState["offSheetSource"]) => {
    const parsed = offNamesForDate(sheets, ymd);
    const matched = parsed.matchedSheetDates.includes(ymd);
    return {
      matched,
      names: matched ? parsed.names : [],
      source,
    };
  };

  if (mode === "cache" || mode === "cache-or-fetch") {
    const cached = peekCachedOffSheetsForDate(ymd);
    if (cached) {
      return fromSheets(cached, "cache");
    }
    if (mode === "cache") {
      return { matched: false, names: [], source: "miss" };
    }
  }

  try {
    const staleWorkbook = peekCachedOffSheets() !== null;
    const sheets = await new Promise<Awaited<ReturnType<typeof fetchPublishedOffSheets>>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("off-sheet-timeout")),
          OFF_SHEET_RESOLVE_TIMEOUT_MS
        );
        fetchPublishedOffSheets({ force: staleWorkbook }).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          }
        );
      }
    );
    return fromSheets(sheets, "fetch");
  } catch {
    return { matched: false, names: [], source: "miss" };
  }
}

function asCaddyDb(db: unknown): {
  caddy: { findMany: (args: unknown) => Promise<RosterBaselineRow[]> };
  assignment: { findMany: (args: unknown) => Promise<Array<{
    caddyId: number;
    type: string;
    subType: string | null;
    startDate: Date;
    endDate: Date;
  }>> };
  scheduleExtraTag: { findMany: (args: unknown) => Promise<Array<{
    caddyId: number;
    tag: string;
    date: Date;
  }>> };
  dailyCaddyUnavailable: { findMany: (args: unknown) => Promise<Array<{ caddyId: number }>> };
} {
  return db as ReturnType<typeof asCaddyDb>;
}

export async function loadCanonicalReflowState(
  ymd: string,
  clientPool: readonly AutoAssignCaddy[] | null | undefined,
  db: unknown = defaultPrisma,
  opts?: LoadCanonicalReflowOptions
): Promise<CanonicalReflowState> {
  const prisma = asCaddyDb(db);
  const { start, end } = parseYmd(ymd);

  const [caddies, assignments, extraTags, unavailableRows, opsDutyIds, specialRows] =
    await Promise.all([
      prisma.caddy.findMany({
        select: {
          id: true,
          name: true,
          team: true,
          teamOrder: true,
          employmentStatus: true,
          caddyType: true,
          extraFlags: true,
          thirdBandSubgroup: true,
        },
        orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
      }),
      prisma.assignment.findMany({
        where: { startDate: { lte: end }, endDate: { gte: start } },
        select: {
          caddyId: true,
          type: true,
          subType: true,
          startDate: true,
          endDate: true,
        },
      }),
      prisma.scheduleExtraTag.findMany({
        where: { date: { gte: start, lte: end } },
        select: { caddyId: true, tag: true, date: true },
      }),
      prisma.dailyCaddyUnavailable.findMany({
        where: { date: start },
        select: { caddyId: true },
      }),
      listDailyOpsDutyCaddyIds(ymd).catch(() => [] as number[]),
      listDailySpecialDutyRecords(ymd).catch(() => [] as Array<{ caddyId: number }>),
    ]);

  const unavailableIds = resolveCanonicalUnavailableIds({
    dailyUnavailableIds: unavailableRows.map((row) => row.caddyId),
  });
  const specialSkipIds = uniquePositiveIds(specialRows.map((row) => row.caddyId));

  const baseAvailability = computeAvailability({
    date: ymd,
    caddies: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: Number(c.teamOrder) || 0,
      employmentStatus: String(c.employmentStatus),
      caddyType: c.caddyType,
      extraFlags: c.extraFlags ?? [],
      thirdBandSubgroup: c.thirdBandSubgroup ?? null,
    })),
    assignments,
    extraTags,
  });

  let offSheetMatched = false;
  let offNames: string[] = [];
  let offSheetSource: CanonicalReflowState["offSheetSource"] = "skipped";
  const resolvedOff = await resolveCanonicalOffSheet(
    ymd,
    opts?.offSheetMode ?? "fetch"
  );
  offSheetMatched = resolvedOff.matched;
  offNames = resolvedOff.names;
  offSheetSource = resolvedOff.source;

  let dutyEntries: Awaited<ReturnType<typeof loadStoredDutyEntries>> = [];
  try {
    dutyEntries = await loadStoredDutyEntries(ymd);
  } catch {
    dutyEntries = [];
  }

  const overlaid = applyDailyExternalExclusions({
    availability: baseAvailability,
    caddies,
    offNames,
    dutyEntries,
  });

  const sotBaseline = rosterBaselineFromAvailability(overlaid);
  const sotUsable = regularCaddyPoolFromAvailabilityRows(
    overlaid.available.all
  );
  const rosterBaseline = recoverRosterBaseline({
    clientPool,
    sotBaseline,
    offSheetMatched,
  });
  const computePool = recoverComputePool({
    clientPool: opts?.computeClientPool ?? clientPool,
    sotUsable: usableComputePool({
      rosterBaseline: sotUsable,
      unavailableIds,
      opsDutyIds,
      specialSkipIds,
    }),
    offSheetMatched,
    unavailableIds,
    opsDutyIds,
    specialSkipIds,
  });

  return {
    rosterBaseline,
    computePool,
    unavailableIds,
    opsDutyIds,
    specialSkipIds,
    offSheetMatched,
    offSheetSource,
  };
}
