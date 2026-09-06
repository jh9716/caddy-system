import type { DraftFlushStatus } from "@/lib/draftSaveFlush";

export type RecalcDraftSavePrep =
  | { ok: true; expectedVersion: number }
  | { ok: false; reason: "conflict" | "flush_error" };

/**
 * Recalc PUT must use the Draft version after this client's own autosave
 * has finished. Special-support PUT does not bump DailyBoardDraft.version.
 *
 * Preview 409 came from a pending/in-flight own Draft PUT (offSnapshot attach
 * or debounce) completing during preview POST. Recalc then reused the
 * pre-preview cached version and was misread as another editor.
 *
 * Protocol: drop obsolete pending autosave of the old board, wait for own
 * in-flight PUT, then PUT recalc with that flushed version. A mismatch after
 * that is a genuine concurrent write.
 */
export function resolveRecalcDraftSavePrep(
  flushStatus: DraftFlushStatus,
  cachedVersion: number
): RecalcDraftSavePrep {
  if (flushStatus === "conflict") return { ok: false, reason: "conflict" };
  if (flushStatus !== "ok") return { ok: false, reason: "flush_error" };
  return { ok: true, expectedVersion: cachedVersion };
}

export async function prepareRecalcDraftExpectedVersion(input: {
  discardObsoletePending?: () => void;
  flushOwnSaves: () => Promise<{ status: DraftFlushStatus } | DraftFlushStatus>;
  getCachedVersion: () => number;
}): Promise<RecalcDraftSavePrep> {
  input.discardObsoletePending?.();
  const flushed = await input.flushOwnSaves();
  const status = typeof flushed === "string" ? flushed : flushed.status;
  return resolveRecalcDraftSavePrep(status, input.getCachedVersion());
}

/** Recalc 진행 중에는 구 작업본 autosave를 새로 넣지 않는다. */
export function shouldAcceptRecalcDraftQueue(recalcInFlight: boolean): boolean {
  return !recalcInFlight;
}

export function isDraftVersionConflict(
  expectedVersion: number,
  actualVersion: number
): boolean {
  return expectedVersion !== actualVersion;
}
