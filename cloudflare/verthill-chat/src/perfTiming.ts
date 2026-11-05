/**
 * Preview 전용 WS 연결 구간 계측 (ms 숫자만).
 * - CHAT_TOKEN_AUDIENCE=preview Worker 에서만 동작. 운영 Worker 는 모든 함수가 no-op.
 * - 기록 대상: 구간별 소요시간(정수 ms)과 cold(0/1)뿐. 사용자·방 ID, 토큰, 메시지, 헤더 값, 쿼리스트링 금지.
 * - 인증 흐름은 바꾸지 않는다: 시간만 재고, 실패해도 무시(try/catch).
 * - 결과는 WebSocket 첫 history 뒤 {type:"perf", t:{...}} 프레임으로 보낸다 (기존 클라이언트는 모르는 type 을 무시).
 * 주의: Workers 의 Date.now() 는 I/O 사이에서만 진행 → CPU 구간(서명 검증 등)은 0 으로 보일 수 있음. 네트워크 왕복 측정이 목적.
 */
import { isPreviewWorker, type NextAppEnv } from "./nextApp";

export const WS_PERF_HEADER = "x-chat-ws-perf";
const KEYS = ["tok", "sc", "scApp", "scDb", "scCold", "mem", "sign", "edge"] as const;
const DO_KEYS = ["doAssert", "doAccept", "doHist"] as const;
export type PerfKey = (typeof KEYS)[number];
export type PerfMarks = Partial<Record<PerfKey, number>>;
const MAX_MS = 600000;

export function perfEnabled(env: NextAppEnv): boolean {
  try { return isPreviewWorker(env); } catch { return false; }
}

function clampMs(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_MS ? n : null;
}

/** session-check 응답의 Server-Timing(app;dur=, db;dur=, cold;dur=) 에서 숫자만. */
export function parseSessionServerTiming(raw: string | null): Pick<PerfMarks, "scApp" | "scDb" | "scCold"> {
  const out: Pick<PerfMarks, "scApp" | "scDb" | "scCold"> = {};
  if (!raw || raw.length > 256) return out;
  for (const part of raw.split(",")) {
    const m = /^\s*(app|db|cold)\s*;\s*dur=([0-9]{1,6}(?:\.[0-9]+)?)\s*$/.exec(part);
    if (!m) continue;
    const v = clampMs(m[2]);
    if (v == null) continue;
    if (m[1] === "app") out.scApp = v;
    else if (m[1] === "db") out.scDb = v;
    else out.scCold = v > 0 ? 1 : 0;
  }
  return out;
}

/** 허용 키 + 정수 ms 만 남긴 짧은 문자열 (DO 전달용 헤더 값). */
export function encodePerf(m: PerfMarks): string {
  const parts: string[] = [];
  for (const k of KEYS) {
    const v = clampMs(m[k]);
    if (v != null) parts.push(`${k}=${v}`);
  }
  return parts.join(";");
}

export function decodePerf(raw: string | null): PerfMarks {
  const out: PerfMarks = {};
  if (!raw || raw.length > 200) return out;
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=");
    if (!(KEYS as readonly string[]).includes(k)) continue;
    const n = clampMs(v);
    if (n != null) out[k as PerfKey] = n;
  }
  return out;
}

/** perf 프레임 본문: 숫자만. */
export function perfFrame(edge: PerfMarks, dO: Partial<Record<(typeof DO_KEYS)[number], number>>): string {
  const t: Record<string, number> = {};
  for (const k of KEYS) { const v = clampMs(edge[k]); if (v != null) t[k] = v; }
  for (const k of DO_KEYS) { const v = clampMs(dO[k]); if (v != null) t[k] = v; }
  return JSON.stringify({ type: "perf", v: 1, t });
}
