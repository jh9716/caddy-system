/**
 * List-view prewarm: at most one room socket + history, after Worker auth.
 * Directory membership snapshot is required to pick a room; the Worker
 * history frame is required to mark ready. Not a stale list-cache paint.
 */
export const CHAT_PREWARM_MAX_ROOMS = 1;

export type ChatPrewarmPickRoom = { roomId: string };
export type ChatPrewarmWaiter = (ok: boolean) => void;

export type ChatPrewarmState = {
  roomId: string | null;
  ready: boolean;
  inflight: boolean;
  generation: number;
  waiters: ChatPrewarmWaiter[];
  timer: number | null;
};

export function createChatPrewarmState(): ChatPrewarmState {
  return { roomId: null, ready: false, inflight: false, generation: 0, waiters: [], timer: null };
}

export function settleChatPrewarmWaiters(
  state: ChatPrewarmState,
  ok: boolean,
  clearTimer: (id: number) => void
): void {
  if (state.timer != null) {
    try {
      clearTimer(state.timer);
    } catch {
      // ignore
    }
    state.timer = null;
  }
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) {
    try {
      waiter(ok);
    } catch {
      // one waiter must not block the rest
    }
  }
}

export function addChatPrewarmWaiter(state: ChatPrewarmState, waiter: ChatPrewarmWaiter): void {
  state.waiters.push(waiter);
}

export function armChatPrewarmTimeout(
  state: ChatPrewarmState,
  timeoutMs: number,
  schedule: (cb: () => void, ms: number) => number,
  onTimeout: () => void
): void {
  if (state.timer != null) return;
  state.timer = schedule(() => {
    state.timer = null;
    onTimeout();
  }, timeoutMs);
}

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

/**
 * History is the ready signal even if the user already switched view to room.
 * 101 / list cache / live message frames are not enough.
 */
export function shouldMarkChatPrewarmReady(input: {
  prewarmRoomId: string | null | undefined;
  historyRoomId: string | null | undefined;
  isHistory: boolean;
}): boolean {
  if (input.isHistory !== true) return false;
  const pre = String(input.prewarmRoomId || "").trim();
  const hist = String(input.historyRoomId || "").trim();
  return Boolean(pre && hist && pre === hist);
}

export function shouldHoldChatReadWhilePrewarm(input: {
  prewarming: boolean;
  viewIsRoom: boolean;
  ready?: boolean;
}): boolean {
  if (input.prewarming !== true) return false;
  if (input.viewIsRoom !== true) return true;
  return input.ready !== true;
}

export function shouldPaintPrewarmLines(input: { ready: boolean }): boolean {
  return input.ready === true;
}

export function isChatPrewarmSocketAlive(readyState: number | null | undefined): boolean {
  if (readyState == null) return false;
  return readyState === 0 || readyState === 1; // CONNECTING | OPEN
}

/**
 * Same-room click while prewarm is in flight: wait on that socket.
 * No WebSocket yet still counts as pending (startChatPrewarm scheduled).
 */
export function shouldReuseInflightPrewarmSocket(input: {
  prewarmRoomId: string | null | undefined;
  targetRoomId: string | null | undefined;
  inflight: boolean;
  ready: boolean;
  socketAlive: boolean;
  socketPending: boolean;
  sessionEnded: boolean;
}): boolean {
  if (input.sessionEnded) return false;
  if (!(input.inflight || input.ready)) return false;
  if (!input.socketAlive && !input.socketPending) return false;
  const pre = String(input.prewarmRoomId || "").trim();
  const target = String(input.targetRoomId || "").trim();
  return Boolean(pre && target && pre === target);
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

export function beginChatPrewarm(state: ChatPrewarmState, roomId: string): number {
  state.generation += 1;
  state.roomId = roomId;
  state.ready = false;
  state.inflight = true;
  return state.generation;
}

export function isChatPrewarmGenerationCurrent(state: ChatPrewarmState, generation: number): boolean {
  return state.generation === generation && state.roomId != null;
}
