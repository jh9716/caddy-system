export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000] as const;
export const RECONNECT_FAIL_MS = 15_000;
export const TOKEN_EXPIRED_CLOSE = 4008;

export type ChatReconnectStatus = "ok" | "reconnecting" | "failed";

export function nextReconnectDelay(attempt: number, random = Math.random): number {
  const idx = Math.max(0, Math.min(RECONNECT_DELAYS_MS.length - 1, Math.floor(attempt)));
  const base = RECONNECT_DELAYS_MS[idx]!;
  const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, random())));
  return base + jitter;
}

export function shouldRefreshTokenOnClose(code: number): boolean {
  return code === TOKEN_EXPIRED_CLOSE;
}

export function chatReconnectStatus(input: {
  connected: boolean;
  failingSinceMs: number | null;
  nowMs?: number;
}): ChatReconnectStatus {
  if (input.connected) return "ok";
  if (input.failingSinceMs == null) return "reconnecting";
  const now = input.nowMs ?? Date.now();
  return now - input.failingSinceMs >= RECONNECT_FAIL_MS ? "failed" : "reconnecting";
}

export function shouldIgnoreStaleSocket(currentGen: number, socketGen: number): boolean {
  return currentGen !== socketGen;
}
