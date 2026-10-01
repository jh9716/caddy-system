/**
 * Pending draft flush on tab hide / pagehide.
 * Chromium rejects keepalive:true above ~64 KiB (TypeError).
 * Production-like draft PUT bodies are often 80–150 KiB+, so leave PUT
 * stays keepalive:false. Chrome 148 still delivers that pagehide fetch
 * on reload / same-origin navigation / tab close. Do not await. No 409 retry.
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
