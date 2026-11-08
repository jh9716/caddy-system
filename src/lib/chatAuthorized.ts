/**
 * Client handling of Worker `{type:"authorized"}`.
 * Production Workers without the frame stay fail-closed (wait for history).
 * No room id, token, or message body is logged.
 */
import { parseAuthorized } from "../../cloudflare/verthill-chat/src/protocol";
import { isChatSessionEnded } from "./chatSessionReset";

export { parseAuthorized };

/** Cache paint is allowed only after this tab received `{type:"authorized"}`. */
export function shouldPaintOnAuthorizedFrame(raw: unknown): boolean {
  if (isChatSessionEnded()) return false;
  return parseAuthorized(raw) != null;
}

/**
 * authorized + history in one Worker turn are often <8ms apart.
 * React 18 then commits once (history wins) — cache never appears on screen.
 */
export const AUTHORIZED_HISTORY_SEPARATE_PAINT_MS = 8;

export function authorizedHistoryWouldPaintSeparately(
  authorizedAt: number,
  historyAt: number
): boolean {
  if (!Number.isFinite(authorizedAt) || !Number.isFinite(historyAt)) return false;
  return historyAt - authorizedAt >= AUTHORIZED_HISTORY_SEPARATE_PAINT_MS;
}

export type AuthorizedFrameGap = {
  resumeToAuthorizedMs: number | null;
  authorizedToHistoryMs: number | null;
  wouldPaintSeparately: boolean;
};

export function measureAuthorizedHistoryGap(input: {
  resumeSentAt?: number | null;
  authorizedAt?: number | null;
  historyAt?: number | null;
}): AuthorizedFrameGap {
  const a = input.authorizedAt;
  const h = input.historyAt;
  const r = input.resumeSentAt;
  const authorizedToHistoryMs =
    typeof a === "number" && typeof h === "number" && Number.isFinite(a) && Number.isFinite(h)
      ? Math.max(0, h - a)
      : null;
  const resumeToAuthorizedMs =
    typeof r === "number" && typeof a === "number" && Number.isFinite(r) && Number.isFinite(a)
      ? Math.max(0, a - r)
      : null;
  return {
    resumeToAuthorizedMs,
    authorizedToHistoryMs,
    wouldPaintSeparately:
      authorizedToHistoryMs != null &&
      authorizedHistoryWouldPaintSeparately(0, authorizedToHistoryMs),
  };
}
