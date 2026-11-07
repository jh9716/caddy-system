/**
 * Parked room WebSocket reuse. Production default is off.
 * Flip PRODUCTION_CHAT_WS_REUSE_ENABLED only after explicit production approval.
 * Tests may pass { productionEnabled: true } without changing that const or any secret.
 *
 * ON deploy is that const flip only. Immediate OFF after ON: set server env
 * CHAT_WS_REUSE_RUNTIME=0 (not NEXT_PUBLIC_; no rebuild). Unset env follows the const.
 */
import { resolveChatAppEnv, type ChatAppEnv, type ChatAppEnvInput } from "./chatAppEnv";

export const CHAT_WS_REUSE_TTL_MS = 20000;
/** Parked resume: wait for server {type:"resume"} then history. session-check 2500ms + membership + history. */
export const CHAT_WS_RESUME_TIMEOUT_MS = 4000;
export const CHAT_WS_REUSE_RUNTIME_PATH = "/api/chat/ws-reuse";
export const CHAT_WS_REUSE_RUNTIME_ENV = "CHAT_WS_REUSE_RUNTIME";

/**
 * Hard off for production until an explicit enable. Not an env/secret flag.
 * When true, resolveChatWsReuse enables reuse only for production (and local-as-production) builds.
 */
export const PRODUCTION_CHAT_WS_REUSE_ENABLED: boolean = false;

export function resolveChatWsReuse(
  env: ChatAppEnvInput,
  opts?: { productionEnabled?: boolean }
): { enabled: boolean } {
  try {
    if (opts?.productionEnabled === false) return { enabled: false };
    if (opts?.productionEnabled === true) return { enabled: true };
    if (PRODUCTION_CHAT_WS_REUSE_ENABLED !== true) return { enabled: false };
    return { enabled: resolveChatAppEnv(env) === "production" };
  } catch {
    return { enabled: false };
  }
}

/** Kill switch after compile-ON. Unset/unknown follows compile. 0/false/off forces off. */
export function resolveChatWsReuseRuntime(input: {
  compileEnabled: boolean;
  appEnv: ChatAppEnv | string;
  runtime?: string | null;
}): boolean {
  if (input.compileEnabled !== true) return false;
  if (input.appEnv !== "production") return false;
  const v = String(input.runtime ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

export function parseWsReuseRuntimeResponse(data: unknown): boolean {
  return Boolean(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      (data as { enabled?: unknown }).enabled === true
  );
}

/** Park only when compile gate and runtime kill switch both allow. */
export function shouldParkChatWsReuse(input: {
  compileEnabled: boolean;
  runtimeEnabled: boolean;
}): boolean {
  return input.compileEnabled === true && input.runtimeEnabled === true;
}

/**
 * Apply a runtime poll. Anything other than boolean true drops a parked socket
 * so CHAT_WS_REUSE_RUNTIME=0 closes reuse without waiting for TTL.
 */
export function applyWsReuseRuntimeEnabled(enabled: boolean): {
  runtimeEnabled: boolean;
  dropParked: boolean;
} {
  const runtimeEnabled = enabled === true;
  return { runtimeEnabled, dropParked: !runtimeEnabled };
}

export type ParkedSocketMeta = { roomId: string; token: string; exp: number };

export const RESUME_SKIP_CODES = [
  "ok",
  "no_park",
  "no_resume",
  "ws_ref",
  "socket_closed",
  "park_expired",
  "room_mismatch",
  "token_mismatch",
  "token_expiring",
  "superseded",
  "resume_null",
  "resume_auth",
  "resume_timeout",
] as const;
export type ResumeSkipCode = (typeof RESUME_SKIP_CODES)[number];

export function isResumeSkipCode(v: unknown): v is ResumeSkipCode {
  return typeof v === "string" && (RESUME_SKIP_CODES as readonly string[]).includes(v);
}

export type ParkedResumeRequest = {
  roomId: string;
  token: string;
  nowSec: number;
  socketOpen: boolean;
  parkedAt?: number | null;
  nowMs?: number;
  hasResume?: boolean;
  wsRefMatch?: boolean;
};

/**
 * Parked resume eligibility failure. null = candidate (server still rechecks session + membership).
 */
export function classifyParkedResumeSkip(
  parked: ParkedSocketMeta | null | undefined,
  req: ParkedResumeRequest
): ResumeSkipCode | null {
  if (!parked) return "no_park";
  if (req.hasResume === false) return "no_resume";
  if (req.wsRefMatch === false) return "ws_ref";
  if (!req.socketOpen) return "socket_closed";
  if (isParkExpired(req.parkedAt, typeof req.nowMs === "number" ? req.nowMs : NaN)) return "park_expired";
  if (!parked.roomId || parked.roomId !== req.roomId) return "room_mismatch";
  if (!parked.token || parked.token !== req.token) return "token_mismatch";
  if (!Number.isFinite(parked.exp) || parked.exp - 30 <= req.nowSec) return "token_expiring";
  return null;
}

/**
 * Wall-clock park expiry. Backgrounded mobile timers can fire late; elapsed time is authoritative.
 * Missing start or a backwards clock is fail-closed (expired).
 */
export function isParkExpired(
  parkedAt: number | null | undefined,
  nowMs: number,
  ttlMs: number = CHAT_WS_REUSE_TTL_MS
): boolean {
  if (typeof parkedAt !== "number" || !Number.isFinite(parkedAt) || !Number.isFinite(nowMs)) return true;
  const elapsed = nowMs - parkedAt;
  return elapsed < 0 || elapsed > ttlMs;
}

/** Reuse candidate: same room + token, socket OPEN, park within TTL, token not within 30s of expiry. */
export function canResumeParked(
  parked: ParkedSocketMeta | null | undefined,
  req: {
    roomId: string;
    token: string;
    nowSec: number;
    socketOpen: boolean;
    parkedAt?: number | null;
    nowMs?: number;
  }
): boolean {
  return classifyParkedResumeSkip(parked, req) === null;
}

/**
 * Frames received while waiting for parked resume history.
 * history → apply; error → drop socket; message/sync → hold until history; other → ignore for the wait.
 */
export function parkedResumeClientGate(type: string): "history" | "fail" | "hold" | "other" {
  if (type === "history") return "history";
  if (type === "error") return "fail";
  if (type === "message" || type === "sync") return "hold";
  return "other";
}

export function classifyParkedResumeWaitResult(opts: {
  gotHistory: boolean;
  gotError: boolean;
  closed: boolean;
  timedOut: boolean;
}): Extract<ResumeSkipCode, "ok" | "resume_auth" | "resume_timeout"> {
  if (opts.gotHistory) return "ok";
  if (opts.timedOut && !opts.gotError && !opts.closed) return "resume_timeout";
  return "resume_auth";
}
