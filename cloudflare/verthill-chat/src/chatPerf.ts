/**
 * Preview 전용 채팅 WS 구간 계측. ms 정수·colo·0/1 플래그만.
 * 토큰·방 ID·사용자 ID·URL·Secret 은 넣지 않는다.
 * 운영(CHAT_TOKEN_AUDIENCE 미설정/"production")에서는 호출부가 이 모듈을 쓰지 않는다.
 */
import { isPreviewWorker, type NextAppEnv } from "./nextApp";

export const CHAT_PERF_PING = "vh-perf-ping";
export const CHAT_PERF_PONG = "vh-perf-pong";
export const CHAT_PERF_HEADER = "x-vh-chat-perf";

export const CHAT_PERF_KEYS = [
  "tok",
  "sc",
  "scApp",
  "scDb",
  "scCold",
  "mem",
  "sign",
  "edge",
  "doAssert",
  "doAccept",
  "doHist",
  "doFirst",
  "doAge",
] as const;

export type ChatPerfKey = (typeof CHAT_PERF_KEYS)[number];
export type ChatPerfT = Partial<Record<ChatPerfKey, number>>;

const MAX_MS = 600000;

export function roundPerfMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(MAX_MS, Math.round(ms)));
}

export function emptyChatPerf(): ChatPerfT {
  return {};
}

export function isPreviewChatPerf(env: NextAppEnv): boolean {
  return isPreviewWorker(env);
}

/** colo 는 대문자 3글자만. */
export function previewColo(cf: unknown): string | undefined {
  if (!cf || typeof cf !== "object") return undefined;
  const colo = (cf as { colo?: unknown }).colo;
  return typeof colo === "string" && /^[A-Z]{3}$/.test(colo) ? colo : undefined;
}

export function sanitizeChatPerf(raw: unknown): ChatPerfT {
  const out: ChatPerfT = {};
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const k of CHAT_PERF_KEYS) {
    const v = rec[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MS) out[k] = v;
  }
  return out;
}

export function encodeChatPerfHeader(t: ChatPerfT): string {
  return JSON.stringify(sanitizeChatPerf(t));
}

export function readChatPerfHeader(headers: Headers): ChatPerfT {
  const raw = headers.get(CHAT_PERF_HEADER);
  if (!raw) return {};
  try {
    return sanitizeChatPerf(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Preview Next session-check 의 Server-Timing.
 * app;dur=N, db;dur=N, cold;dur=0|1 만 읽는다. 그 외 메트릭·토큰은 무시.
 */
export function parseSessionCheckServerTiming(header: string | null | undefined): {
  scApp?: number;
  scDb?: number;
  scCold?: number;
} {
  const out: { scApp?: number; scDb?: number; scCold?: number } = {};
  const s = String(header || "");
  if (!s) return out;
  for (const part of s.split(",")) {
    const m = /^\s*(app|db|cold);dur=(\d+(?:\.\d+)?)\s*$/i.exec(part);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    const n = roundPerfMs(Number(m[2]));
    if (name === "app") out.scApp = n;
    else if (name === "db") out.scDb = n;
    else if (name === "cold") out.scCold = n === 0 ? 0 : 1;
  }
  return out;
}

export function previewPerfFrame(
  t: ChatPerfT,
  colo?: string | undefined
): { type: "perf"; t: ChatPerfT; colo?: string } {
  const frame: { type: "perf"; t: ChatPerfT; colo?: string } = {
    type: "perf",
    t: sanitizeChatPerf(t),
  };
  if (colo && /^[A-Z]{3}$/.test(colo)) frame.colo = colo;
  return frame;
}

export function isPreviewPerfPing(env: NextAppEnv, message: string): boolean {
  return isPreviewChatPerf(env) && message === CHAT_PERF_PING;
}
