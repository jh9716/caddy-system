/**
 * Server SoT loader for caddyPool / unavailable.
 * Production writes: none. Off-sheet miss does not expand the pool.
 * Persist fetch/timeout cannot confirm today's OFF SoT: fail closed.
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
  peekOffDateSnapshot,
  rememberOffSheetsForDate,
} from "@/lib/offSheetFetch";
import { offNamesForDate } from "@/lib/offSheetParser";
import { listDailyOpsDutyCaddyIds, loadStoredDutyEntries } from "@/lib/dailyOpsDutyService";
import { listDailySpecialDutyRecords } from "@/lib/dailySpecialDutyService";
import {
  OFF_SHEET_UNRESOLVED_CODE,
  OFF_SHEET_UNRESOLVED_USER_MESSAGE,
  recoverComputePool,
  recoverRosterBaseline,
  resolveCanonicalUnavailableIds,
  rosterBaselineFromAvailability,
  uniquePositiveIds,
  usableComputePool,
  type RosterBaselineRow,
} from "@/lib/caddyPoolCanonical";
import {
  isUsableOffSnapshot,
  OffSnapshotRequiredError,
  offNamesFromCaddyIds,
  type DraftOffSnapshot,
} from "@/lib/offSnapshot";
import {
  regularCaddyPoolFromAvailabilityRows,
  type AutoAssignCaddy,
} from "@/lib/autoAssignEngine";

export type CanonicalOffSheetMode = "cache" | "fetch" | "cache-or-fetch" | "snapshot";

/** Persist may wait 1–4s for OFF SoT. UI does not wait; do not treat 4s as miss. */
export const OFF_SHEET_RESOLVE_TIMEOUT_MS = 15_000;

export class OffSheetUnresolvedError extends Error {
  status = 503;
  code = OFF_SHEET_UNRESOLVED_CODE;
  constructor(message = OFF_SHEET_UNRESOLVED_USER_MESSAGE) {
    super(message);
    this.name = "OffSheetUnresolvedError";
  }
}

export function isOffSheetUnresolvedError(
  error: unknown
): error is OffSheetUnresolvedError {
  return error instanceof OffSheetUnresolvedError;
}

export function offSheetResolveTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  if (process.env.NODE_ENV !== "production") {
    const fromEnv = Number(process.env.OFF_SHEET_RESOLVE_TIMEOUT_MS);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
      return Math.floor(fromEnv);
    }
  }
  return OFF_SHEET_RESOLVE_TIMEOUT_MS;
}

export type CanonicalReflowState = {
  rosterBaseline: AutoAssignCaddy[];
  computePool: AutoAssignCaddy[];
  unavailableIds: number[];
  opsDutyIds: number[];
  specialSkipIds: number[];
  offSheetMatched: boolean;
  offSheetSource: "cache" | "miss" | "fetch" | "skipped" | "snapshot";
  offResolveMs?: number;
};

export type LoadCanonicalReflowOptions = {
  offSheetMode?: CanonicalOffSheetMode;
  /** Recover compute from this pool. Roster baseline still uses clientPool. */
  computeClientPool?: readonly AutoAssignCaddy[] | null;
  /** Date-matched Draft OFF snapshot. Mutation uses this and never hits Google. */
  offSnapshot?: DraftOffSnapshot | null;
};

export type CanonicalOffSheetResult = {
  matched: boolean;
  names: string[];
  source: CanonicalReflowState["offSheetSource"];
  resolveMs: number;
};

const offDateInflight = new Map<string, Promise<CanonicalOffSheetResult>>();

export function resetOffDateInflightForTests() {
  if (process.env.NODE_ENV === "production") return;
  offDateInflight.clear();
}

export function peekOffDateInflightCountForTests(): number {
  if (process.env.NODE_ENV === "production") return 0;
  return offDateInflight.size;
}

function fromOffSheets(
  ymd: string,
  sheets: Awaited<ReturnType<typeof fetchPublishedOffSheets>>,
  source: CanonicalReflowState["offSheetSource"]
): Omit<CanonicalOffSheetResult, "resolveMs"> {
  const parsed = offNamesForDate(sheets, ymd);
  const matched = parsed.matchedSheetDates.includes(ymd);
  const result = {
    matched,
    names: matched ? parsed.names : [],
    source,
  };
  rememberOffSheetsForDate(ymd, sheets);
  return result;
}

async function fetchOffSheetsForDate(
  ymd: string,
  timeoutMs: number
): Promise<Awaited<ReturnType<typeof fetchPublishedOffSheets>>> {
  const dateMatched = peekCachedOffSheetsForDate(ymd) !== null;
  const staleWorkbook = peekCachedOffSheets() !== null && !dateMatched;
  return fetchPublishedOffSheets({
    force: staleWorkbook,
    timeoutMs,
  });
}

export async function resolveCanonicalOffSheet(
  ymd: string,
  mode: CanonicalOffSheetMode = "fetch",
  opts?: { timeoutMs?: number }
): Promise<CanonicalOffSheetResult> {
  const started = Date.now();
  const year = Number(ymd.slice(0, 4));
  if (!Number.isInteger(year) || year >= 2090) {
    return { matched: false, names: [], source: "skipped", resolveMs: 0 };
  }

  const withMs = (
    result: Omit<CanonicalOffSheetResult, "resolveMs">
  ): CanonicalOffSheetResult => ({
    ...result,
    resolveMs: Date.now() - started,
  });

  if (mode === "cache" || mode === "cache-or-fetch") {
    const snap = peekOffDateSnapshot(ymd);
    if (snap) {
      return withMs({
        matched: snap.matched,
        names: snap.names,
        source: "cache",
      });
    }
    const cached = peekCachedOffSheetsForDate(ymd);
    if (cached) {
      return withMs(fromOffSheets(ymd, cached, "cache"));
    }
    if (mode === "cache") {
      return withMs({ matched: false, names: [], source: "miss" });
    }
  }

  const existing = offDateInflight.get(ymd);
  if (existing) {
    try {
      const shared = await existing;
      return withMs({
        matched: shared.matched,
        names: shared.names,
        source: shared.source === "fetch" ? "fetch" : shared.source,
      });
    } catch (error) {
      if (offDateInflight.get(ymd) === existing) offDateInflight.delete(ymd);
      if (isOffSheetUnresolvedError(error)) throw error;
      throw new OffSheetUnresolvedError();
    }
  }

  const pending = (async () => {
    try {
      const sheets = await fetchOffSheetsForDate(
        ymd,
        offSheetResolveTimeoutMs(opts?.timeoutMs)
      );
      return withMs(fromOffSheets(ymd, sheets, "fetch"));
    } catch (error) {
      if (isOffSheetUnresolvedError(error)) throw error;
      throw new OffSheetUnresolvedError();
    }
  })();
  offDateInflight.set(ymd, pending);
  try {
    return await pending;
  } finally {
    if (offDateInflight.get(ymd) === pending) offDateInflight.delete(ymd);
  }
}

export async function prewarmCanonicalOffSheet(ymd: string): Promise<CanonicalOffSheetResult> {
  return resolveCanonicalOffSheet(ymd, "cache-or-fetch");
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
  let offResolveMs = 0;
  const offSnapshot = opts?.offSnapshot;
  if (isUsableOffSnapshot(offSnapshot, ymd)) {
    offSheetMatched = true;
    offNames = offNamesFromCaddyIds(caddies, offSnapshot.caddyIds);
    offSheetSource = "snapshot";
  } else if (opts?.offSheetMode === "snapshot") {
    throw new OffSnapshotRequiredError();
  } else {
    const resolvedOff = await resolveCanonicalOffSheet(
      ymd,
      opts?.offSheetMode ?? "fetch"
    );
    offSheetMatched = resolvedOff.matched;
    offNames = resolvedOff.names;
    offSheetSource = resolvedOff.source;
    offResolveMs = resolvedOff.resolveMs;
  }

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
    offResolveMs,
  };
}
