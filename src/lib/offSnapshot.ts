/**
 * Date-verified OFF snapshot on DailyBoardDraft.payload.
 * Optional JSON field — no Prisma migration.
 * SICK / NOSHOW / MOVE persist uses this only. Google HTTP stays on
 * 가용 캐디 불러오기 / date-init prewarm.
 */

import { uniquePositiveIds } from "@/lib/caddyPoolCanonical";
import {
  matchCaddyByExactName,
  resolveOffSheetNameTokens,
  type NameMatchCaddy,
} from "@/lib/dailyCaddyNameMatch";

export const OFF_SNAPSHOT_VERSION = 1 as const;

export const OFF_SNAPSHOT_REQUIRED_CODE = "OFF_SNAPSHOT_REQUIRED";
export const OFF_SNAPSHOT_REQUIRED_USER_MESSAGE =
  "휴무 정보를 먼저 다시 불러와 주세요.";

export type DraftOffSnapshot = {
  date: string;
  fetchedAt: string;
  version: typeof OFF_SNAPSHOT_VERSION;
  sourceHash: string;
  caddyIds: number[];
};

export class OffSnapshotRequiredError extends Error {
  status = 400;
  code = OFF_SNAPSHOT_REQUIRED_CODE;
  constructor(message = OFF_SNAPSHOT_REQUIRED_USER_MESSAGE) {
    super(message);
    this.name = "OffSnapshotRequiredError";
  }
}

export function isOffSnapshotRequiredError(
  error: unknown
): error is OffSnapshotRequiredError {
  return error instanceof OffSnapshotRequiredError;
}

export function offSnapshotSourceHash(caddyIds: readonly number[]): string {
  return `off:v${OFF_SNAPSHOT_VERSION}:${uniquePositiveIds(caddyIds)
    .slice()
    .sort((a, b) => a - b)
    .join(",")}`;
}

export function parseOffSnapshot(raw: unknown): DraftOffSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const date = String(o.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const version = Number(o.version);
  if (version !== OFF_SNAPSHOT_VERSION) return null;
  if (!Array.isArray(o.caddyIds)) return null;
  const caddyIds = uniquePositiveIds(o.caddyIds);
  const fetchedAt = String(o.fetchedAt ?? "").trim();
  if (!fetchedAt) return null;
  const sourceHash =
    typeof o.sourceHash === "string" && o.sourceHash.trim()
      ? o.sourceHash.trim()
      : offSnapshotSourceHash(caddyIds);
  return { date, fetchedAt, version: OFF_SNAPSHOT_VERSION, sourceHash, caddyIds };
}

export function isUsableOffSnapshot(
  snap: DraftOffSnapshot | null | undefined,
  date: string
): snap is DraftOffSnapshot {
  return !!snap && snap.date === date && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export function buildOffSnapshot(input: {
  date: string;
  caddyIds: Iterable<unknown>;
  fetchedAt?: string;
}): DraftOffSnapshot {
  const caddyIds = uniquePositiveIds(input.caddyIds);
  return {
    date: input.date,
    fetchedAt: input.fetchedAt || new Date().toISOString(),
    version: OFF_SNAPSHOT_VERSION,
    sourceHash: offSnapshotSourceHash(caddyIds),
    caddyIds,
  };
}

export function offCaddyIdsFromAvailability(data: {
  excluded?: Array<{ id?: unknown; excludedReasons?: unknown }> | null;
}): number[] {
  return uniquePositiveIds(
    (data.excluded || [])
      .filter(
        (row) =>
          Array.isArray(row.excludedReasons) &&
          row.excludedReasons.map(String).includes("휴무")
      )
      .map((row) => row.id)
  );
}

export function offCaddyIdsFromNames(
  names: readonly string[],
  caddies: readonly NameMatchCaddy[]
): number[] {
  const ids: number[] = [];
  for (const name of names) {
    for (const token of resolveOffSheetNameTokens(name, caddies)) {
      const match = matchCaddyByExactName(token, caddies);
      if (match.status === "matched") ids.push(match.caddyId);
    }
  }
  return uniquePositiveIds(ids);
}

export function offNamesFromCaddyIds(
  caddies: readonly { id: number; name: string }[],
  ids: readonly number[]
): string[] {
  const set = new Set(ids);
  return caddies.filter((c) => set.has(c.id)).map((c) => c.name);
}

export function pipelineMutationOffSnapshotBlock(draft: {
  date: string;
  offSnapshot?: DraftOffSnapshot | null;
}): string | null {
  return isUsableOffSnapshot(draft.offSnapshot, draft.date)
    ? null
    : OFF_SNAPSHOT_REQUIRED_USER_MESSAGE;
}
