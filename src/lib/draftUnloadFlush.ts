/**
 * Pending draft flush on tab hide / pagehide.
 * Draft JSON is typically far above Chromium's 64 KiB keepalive limit.
 * Do not use keepalive or sendBeacon. Do not await on unload. No 409 retry.
 */

export type DraftLeavePending = { date: string };

export type DraftLeaveFlushDecision =
  | {
      action: "skip";
      reason:
        | "hydrating"
        | "no-pending"
        | "date-mismatch"
        | "in-flight";
    }
  | { action: "flush" };

export function decideDraftLeaveFlush(input: {
  hydrating: boolean;
  pending: DraftLeavePending | null;
  currentDate: string;
  inFlight: boolean;
}): DraftLeaveFlushDecision {
  if (input.hydrating) return { action: "skip", reason: "hydrating" };
  if (input.inFlight) return { action: "skip", reason: "in-flight" };
  if (!input.pending) return { action: "skip", reason: "no-pending" };
  if (input.pending.date !== input.currentDate) {
    return { action: "skip", reason: "date-mismatch" };
  }
  return { action: "flush" };
}

export function draftLeavePutKeepalive(): false {
  return false;
}

export function shouldRetryDraftLeaveConflict(): false {
  return false;
}
