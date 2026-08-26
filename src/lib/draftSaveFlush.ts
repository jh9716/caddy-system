/**
 * Draft autosave drain. Publish must wait until in-flight + pending saves finish
 * so a click during the 1.5s debounce cannot confirm a stale version.
 */

export type DraftFlushStatus = "ok" | "conflict" | "error";

export async function drainDraftSaves(input: {
  hasPending: () => boolean;
  isInFlight: () => boolean;
  flushOnce: () => Promise<DraftFlushStatus | "skipped">;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<DraftFlushStatus> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  const timeoutMs = input.timeoutMs ?? 15000;
  const started = now();

  while (input.isInFlight() || input.hasPending()) {
    if (now() - started > timeoutMs) return "error";
    if (input.isInFlight()) {
      await sleep(20);
      continue;
    }
    if (!input.hasPending()) break;
    const result = await input.flushOnce();
    if (result === "skipped") {
      await sleep(20);
      continue;
    }
    if (result !== "ok") return result;
  }
  return "ok";
}
