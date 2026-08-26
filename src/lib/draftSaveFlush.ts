/**
 * Draft autosave drain. Publish must wait until in-flight + pending saves finish
 * so a click during the 1.5s debounce cannot confirm a stale version.
 *
 * Does NOT wait for the debounce timer. Callers must clear the timer first,
 * then this flushes any pending payload immediately (or skips if nothing to save).
 */

export type DraftFlushStatus = "ok" | "conflict" | "error";

export type DrainDraftSavesTimings = {
  totalMs: number;
  /** Debounce timer clear only — never a 1.5s wait. */
  pendingDebounceFlushMs: number;
  inFlightWaitMs: number;
  extraFlushMs: number;
  extraFlushRan: boolean;
  skippedSave: boolean;
  pollSleepMs: number;
};

export type DrainDraftSavesResult = {
  status: DraftFlushStatus;
  timings: DrainDraftSavesTimings;
};

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export async function drainDraftSaves(input: {
  hasPending: () => boolean;
  isInFlight: () => boolean;
  flushOnce: () => Promise<DraftFlushStatus | "skipped">;
  /** Await the in-flight PUT promise when present. Prefer this over polling. */
  waitForInFlight?: () => Promise<void>;
  clearDebounceTimer?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<DrainDraftSavesResult> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? defaultNow;
  const timeoutMs = input.timeoutMs ?? 15000;
  const started = now();
  let pollSleepMs = 0;

  const emptyTimings = (status: DraftFlushStatus): DrainDraftSavesResult => ({
    status,
    timings: {
      totalMs: now() - started,
      pendingDebounceFlushMs: 0,
      inFlightWaitMs: 0,
      extraFlushMs: 0,
      extraFlushRan: false,
      skippedSave: true,
      pollSleepMs,
    },
  });

  const timedOut = () => now() - started > timeoutMs;

  const tClear0 = now();
  input.clearDebounceTimer?.();
  const pendingDebounceFlushMs = now() - tClear0;

  const tIn0 = now();
  while (input.isInFlight()) {
    if (timedOut()) return emptyTimings("error");
    if (input.waitForInFlight) {
      await input.waitForInFlight();
      if (input.isInFlight()) {
        const tSleep = now();
        await sleep(20);
        pollSleepMs += now() - tSleep;
      }
      continue;
    }
    const tSleep = now();
    await sleep(20);
    pollSleepMs += now() - tSleep;
  }
  const inFlightWaitMs = now() - tIn0;

  let extraFlushRan = false;
  const tFlush0 = now();
  while (input.hasPending()) {
    if (timedOut()) {
      return {
        status: "error",
        timings: {
          totalMs: now() - started,
          pendingDebounceFlushMs,
          inFlightWaitMs,
          extraFlushMs: now() - tFlush0,
          extraFlushRan,
          skippedSave: !extraFlushRan,
          pollSleepMs,
        },
      };
    }
    if (input.isInFlight()) {
      if (input.waitForInFlight) {
        await input.waitForInFlight();
        if (input.isInFlight()) {
          const tSleep = now();
          await sleep(20);
          pollSleepMs += now() - tSleep;
        }
        continue;
      }
      const tSleep = now();
      await sleep(20);
      pollSleepMs += now() - tSleep;
      continue;
    }
    extraFlushRan = true;
    const result = await input.flushOnce();
    if (result === "skipped") {
      const tSleep = now();
      await sleep(20);
      pollSleepMs += now() - tSleep;
      continue;
    }
    if (result !== "ok") {
      return {
        status: result,
        timings: {
          totalMs: now() - started,
          pendingDebounceFlushMs,
          inFlightWaitMs,
          extraFlushMs: now() - tFlush0,
          extraFlushRan,
          skippedSave: false,
          pollSleepMs,
        },
      };
    }
  }
  const extraFlushMs = now() - tFlush0;

  return {
    status: "ok",
    timings: {
      totalMs: now() - started,
      pendingDebounceFlushMs,
      inFlightWaitMs,
      extraFlushMs,
      extraFlushRan,
      skippedSave: !extraFlushRan,
      pollSleepMs,
    },
  };
}
