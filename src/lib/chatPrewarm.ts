/**
 * List-view prewarm: at most one room socket + history, after Worker auth.
 * Directory membership snapshot is required to pick a room; the Worker
 * history frame is required to mark ready. Not a stale list-cache paint.
 */
export const CHAT_PREWARM_MAX_ROOMS = 1;

export type ChatPrewarmPickRoom = { roomId: string };

export function pickChatPrewarmRoom(input: {
  directorySnapshotReady: boolean;
  sessionEnded: boolean;
  rooms: ChatPrewarmPickRoom[];
  lastOpenedRoomId?: string | null;
}): string | null {
  if (input.sessionEnded) return null;
  if (input.directorySnapshotReady !== true) return null;
  if (!Array.isArray(input.rooms) || input.rooms.length === 0) return null;
  const last = String(input.lastOpenedRoomId || "").trim();
  if (last && input.rooms.some((row) => row.roomId === last)) return last;
  const first = String(input.rooms[0]?.roomId || "").trim();
  return first || null;
}

export function canAdoptChatPrewarm(input: {
  prewarmRoomId: string | null | undefined;
  targetRoomId: string | null | undefined;
  ready: boolean;
  socketOpen: boolean;
  sessionEnded: boolean;
}): boolean {
  if (input.sessionEnded) return false;
  if (input.ready !== true || input.socketOpen !== true) return false;
  const pre = String(input.prewarmRoomId || "").trim();
  const target = String(input.targetRoomId || "").trim();
  return Boolean(pre && target && pre === target);
}

export function shouldHoldChatReadWhilePrewarm(input: {
  prewarming: boolean;
  viewIsRoom: boolean;
}): boolean {
  return input.prewarming === true && input.viewIsRoom !== true;
}

export function shouldDropPrewarmOnDirectory(input: {
  prewarmRoomId: string | null | undefined;
  memberRoomIds: Iterable<string>;
}): boolean {
  const pre = String(input.prewarmRoomId || "").trim();
  if (!pre) return false;
  for (const id of input.memberRoomIds) {
    if (String(id || "").trim() === pre) return false;
  }
  return true;
}

export function shouldStartChatPrewarm(input: {
  viewIsList: boolean;
  directorySnapshotReady: boolean;
  sessionEnded: boolean;
  hasTarget: boolean;
  currentRoomId: string | null | undefined;
  inflightOrReady: boolean;
}): boolean {
  if (!input.viewIsList || !input.directorySnapshotReady || input.sessionEnded) return false;
  if (!input.hasTarget) return false;
  if (input.inflightOrReady && input.currentRoomId) return false;
  return true;
}

/**
 * Worker history (not 101, not the room list) is the ready signal.
 * Production Workers have no earlier authorized frame.
 */
export function chatPrewarmReadyFromFrame(type: string, messages: unknown): boolean {
  return type === "history" && Array.isArray(messages);
}
