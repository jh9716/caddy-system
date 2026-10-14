/**
 * Chat token sessionVersion compare. Worker + Next share this rule:
 * token.sv must equal the current DB User.sessionVersion.
 * Missing user / unavailable current sv is fail-closed.
 */

export type ChatSessionEpochDecision =
  | { ok: true }
  | { ok: false; code: "stale_session" | "user_unavailable" };

export function parseChatSessionEpoch(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const sv = Number(raw);
  if (!Number.isInteger(sv) || sv < 0) return null;
  return sv;
}

export function evaluateChatSessionEpoch(input: {
  tokenSv: unknown;
  currentSv: unknown;
  chatBlocked?: boolean;
}): ChatSessionEpochDecision {
  const tokenSv = parseChatSessionEpoch(input.tokenSv);
  const currentSv = parseChatSessionEpoch(input.currentSv);
  if (tokenSv == null || currentSv == null) {
    return { ok: false, code: "user_unavailable" };
  }
  if (input.chatBlocked === true) {
    return { ok: false, code: "user_unavailable" };
  }
  if (currentSv !== tokenSv) {
    return { ok: false, code: "stale_session" };
  }
  return { ok: true };
}

/** Open-socket local cache: stored epoch newer than token → stale. Missing cache is unknown. */
export function isChatSessionEpochStale(
  tokenSv: number | null,
  storedSv: number | null | undefined
): boolean {
  if (storedSv == null) return false;
  if (tokenSv == null) return true;
  return storedSv > tokenSv;
}
