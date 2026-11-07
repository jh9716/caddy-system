/**
 * Parked WebSocket resume: fail-closed verdict after session-check + membership.
 * History is sent only when this returns allow. No network here.
 */

export type ParkedResumeSession =
  | { ok: true }
  | { ok: false; status: number; error: string };

export type ParkedResumeAccess =
  | { ok: true }
  | { ok: false; code: "invalid_room" | "room_forbidden" };

export type ParkedResumeDenyClose = "stale_session" | "room_forbidden" | "unavailable";

export type ParkedResumeVerdict =
  | { action: "allow" }
  | { action: "deny"; close: ParkedResumeDenyClose };

/**
 * Combine session-check + room access. Fail-closed:
 * 503 / unconfigured / timeout → unavailable (do not send history, drop socket)
 * 401 / blocked / stale → stale_session
 * membership miss → room_forbidden
 */
export function parkedResumeVerdict(input: {
  session: ParkedResumeSession;
  access: ParkedResumeAccess;
}): ParkedResumeVerdict {
  if (!input.session.ok) {
    if (input.session.status === 503) return { action: "deny", close: "unavailable" };
    return { action: "deny", close: "stale_session" };
  }
  if (!input.access.ok) return { action: "deny", close: "room_forbidden" };
  return { action: "allow" };
}
