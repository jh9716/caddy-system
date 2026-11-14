/**
 * Chat entry speed helpers (client).
 * Does not change Worker protocol, session-check, membership, or read receipts.
 *
 * User-perceived stages (not production telemetry by default):
 * A menu click → first chrome (ChatClient mount)
 * B menu click → room list rows
 * C list shown → prewarm history ready
 * D room click → WebSocket OPEN
 * E OPEN → history frame received
 * F history received → React commit
 * G room click → messages on screen
 *
 * Production `chatEntryTiming` stays off unless `?chatEntry=1` (step name + ms only).
 */

export function shouldPrefetchChatToken(input: {
  pathname: string;
  hasReusableToken: boolean;
}): boolean {
  if (input.hasReusableToken) return false;
  const path = String(input.pathname || "");
  if (path === "/chat" || path.startsWith("/chat/")) return false;
  return true;
}

export function shouldWarmChatWorkerOnShell(): boolean {
  return true;
}

/**
 * Skip the leave-path GET /api/chat/ws-reuse wait when this tab already knows
 * runtime is on. Unknown/false still awaits (fail-closed Instant Rollback).
 * Background poll + visibility still drop parks if runtime flips off.
 */
export { shouldAwaitParkRuntimeCheck } from "@/lib/chatWsReuse";

/** Same-tab memory list only. Not membership. Worker still revalidates. */
export function shouldPaintCachedRoomsNow(input: {
  sessionEnded: boolean;
  hasCachedToken: boolean;
  cachedRoomCount: number;
}): boolean {
  if (input.sessionEnded) return false;
  if (!input.hasCachedToken) return false;
  return input.cachedRoomCount > 0;
}

export type ChatEntryHopMs = {
  tokenPost: number;
  workerTls: number;
  directoryRooms: number;
  roomAuthorize: number;
  historyFrame: number;
};

/**
 * Sequential model of revisit click→shown. Unit tests / local comparison only.
 * Do not treat output as production measurement.
 */
export function modelChatRevisitClickToShown(input: {
  hops: ChatEntryHopMs;
  listDwellMs: number;
  workerTlsWarmed: boolean;
  tokenCached: boolean;
  lastOpenedHintPrewarm: boolean;
  snapshotWaitMs: number;
}): { listPaintMs: number; prewarmReadyAt: number; clickToShownMs: number } {
  const tls = input.workerTlsWarmed ? 0 : input.hops.workerTls;
  const token = input.tokenCached ? 0 : input.hops.tokenPost;
  if (!input.lastOpenedHintPrewarm) {
    const listPaintMs = token + input.hops.directoryRooms;
    const prewarmReadyAt =
      listPaintMs + input.snapshotWaitMs + tls + input.hops.roomAuthorize + input.hops.historyFrame;
    const clickAt = listPaintMs + input.listDwellMs;
    return {
      listPaintMs,
      prewarmReadyAt,
      clickToShownMs: Math.max(0, prewarmReadyAt - clickAt),
    };
  }
  const listPaintMs = 0;
  const prewarmReadyAt = tls + input.hops.roomAuthorize + input.hops.historyFrame;
  const clickAt = listPaintMs + input.listDwellMs;
  return {
    listPaintMs,
    prewarmReadyAt,
    clickToShownMs: Math.max(0, prewarmReadyAt - clickAt),
  };
}
