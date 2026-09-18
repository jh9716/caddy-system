import type { DailyBoardPublishedPayloadV1 } from "@/lib/dailyBoardPublished";

/** Unique assigned caddyIds from Published.placements only. Spares are ignored. */
export function uniqueAssignedCaddyIdsFromPublished(
  payload: Pick<DailyBoardPublishedPayloadV1, "placements"> | null | undefined
): number[] {
  const ids = new Set<number>();
  const rows = payload?.placements;
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    const id = row?.caddyId;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) {
      ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;
  const workers = Math.min(Math.max(1, limit), n);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= n) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
