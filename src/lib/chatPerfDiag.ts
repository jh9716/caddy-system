/**
 * Preview 전용 채팅 진입 속도 진단 (?chatPerf=1).
 * - 운영 빌드에서는 쿼리가 있어도 항상 비활성.
 * - ms 숫자와 일반 라벨만 메모리에 보관. 토큰·방 ID·사용자 ID·메시지·URL 은 저장하지 않는다.
 * - 네트워크 전송 없음. 모든 함수는 예외를 밖으로 던지지 않는다(비활성 시 즉시 반환).
 */
import { resolveChatAppEnv, type ChatAppEnvInput } from "./chatAppEnv";

export type ChatPerfEntryKind = "first" | "switch" | "reentry" | "deeplink";

export type ChatPerfRecord = {
  n: number;
  kind: ChatPerfEntryKind;
  tokenMs: number | null;
  tokenFetched: boolean;
  tapToOpenMs: number | null;
  openToHistoryMs: number | null;
  historyToRenderMs: number | null;
  tapToVisibleMs: number | null;
  ok: boolean;
};

export type ChatPerfListRecord = { n: number; tokenMs: number | null; connectToListMs: number | null };

/** Preview Worker 가 보낸 서버 구간(ms). 허용 키·정수만. */
export const CHAT_PERF_SERVER_KEYS = ["tok", "sc", "scApp", "scDb", "scCold", "mem", "sign", "edge", "doAssert", "doAccept", "doHist"] as const;
export type ChatPerfServerRecord = { n: number; t: Partial<Record<(typeof CHAT_PERF_SERVER_KEYS)[number], number>> };

export type ChatPerfState = { entries: ChatPerfRecord[]; list: ChatPerfListRecord[]; server: ChatPerfServerRecord[] };

/** 순수: perf 프레임의 t 에서 허용 키의 0~600000 정수만 남긴다. */
export function sanitizeServerPerf(raw: unknown): ChatPerfServerRecord["t"] {
  const out: ChatPerfServerRecord["t"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of CHAT_PERF_SERVER_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 600000) out[k] = v;
  }
  return out;
}

/** 순수: 서버 구간 한 줄 텍스트. */
export function serverPerfLine(r: ChatPerfServerRecord): string {
  const t = r.t;
  const g = (k: keyof typeof t) => (t[k] == null ? "-" : String(t[k]));
  return `서버#${r.n} 토큰검증 ${g("tok")} | session-check왕복 ${g("sc")} (함수 ${g("scApp")} / DB ${g("scDb")} / cold ${g("scCold")}) | 멤버 ${g("mem")} | 서명 ${g("sign")} | Worker합계 ${g("edge")} | DO검증 ${g("doAssert")} | DO수락 ${g("doAccept")} | DO history ${g("doHist")}`;
}

export const CHAT_PERF_MAX = 5;

/** 순수 판정: preview 환경 + chatPerf=1 일 때만 true. */
export function isChatPerfAllowed(env: ChatAppEnvInput, search: string | null | undefined): boolean {
  try {
    if (resolveChatAppEnv(env) !== "preview") return false;
    const q = new URLSearchParams(String(search || ""));
    return q.get("chatPerf") === "1";
  } catch {
    return false;
  }
}

export function diffMs(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b) || b < a) return null;
  return Math.round(b - a);
}

export function classifyEntry(opts: {
  hasPrevious: boolean;
  sameAsPrevious: boolean;
  deepLink: boolean;
}): ChatPerfEntryKind {
  if (opts.deepLink) return "deeplink";
  if (!opts.hasPrevious) return "first";
  return opts.sameAsPrevious ? "reentry" : "switch";
}

type Pending = {
  kind: ChatPerfEntryKind;
  tap: number;
  tokenStart: number | null;
  tokenEnd: number | null;
  tokenFetched: boolean;
  open: number | null;
  history: number | null;
  commit: number | null;
};

export function buildRecord(n: number, p: Pending, visible: number | null, ok: boolean): ChatPerfRecord {
  return {
    n,
    kind: p.kind,
    tokenMs: diffMs(p.tokenStart, p.tokenEnd),
    tokenFetched: p.tokenFetched,
    tapToOpenMs: diffMs(p.tap, p.open),
    openToHistoryMs: diffMs(p.open, p.history),
    historyToRenderMs: diffMs(p.history, p.commit),
    tapToVisibleMs: diffMs(p.tap, visible),
    ok,
  };
}

// ---- 메모리 상태 (탭 세션 한정) ----
let enabled = false;
let state: ChatPerfState = { entries: [], list: [], server: [] };
let serverSeq = 0;
let pending: Pending | null = null;
let seq = 0;
let listSeq = 0;
let listPending: { tokenStart: number | null; tokenEnd: number | null; connect: number | null } | null = null;
let tokenFetchStart: number | null = null;
let tokenFetchEnd: number | null = null;
const listeners = new Set<() => void>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function emit() {
  state = { entries: state.entries.slice(), list: state.list.slice(), server: state.server.slice() };
  listeners.forEach((l) => {
    try { l(); } catch { /* ignore */ }
  });
}
function safe(fn: () => void) {
  if (!enabled) return;
  try { fn(); } catch { /* 진단은 채팅 흐름에 영향 주지 않는다 */ }
}

/** 브라우저에서 1회 호출. 한 번 켜지면 같은 탭(메모리)에서는 앱 내 이동 후에도 유지. */
export function initChatPerf(): boolean {
  try {
    if (enabled) return true;
    if (typeof window === "undefined") return false;
    enabled = isChatPerfAllowed(
      {
        NEXT_PUBLIC_CHAT_APP_ENV: process.env.NEXT_PUBLIC_CHAT_APP_ENV,
        NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
        NODE_ENV: process.env.NODE_ENV,
      },
      window.location.search
    );
  } catch {
    enabled = false;
  }
  return enabled;
}
export function chatPerfEnabled() { return enabled; }
export function subscribeChatPerf(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function getChatPerfState(): ChatPerfState { return state; }

export const chatPerf = {
  tokenStart() { safe(() => { tokenFetchStart = now(); tokenFetchEnd = null; }); },
  tokenEnd() { safe(() => { tokenFetchEnd = now(); }); },
  listConnectStart() {
    safe(() => { listPending = { tokenStart: tokenFetchStart, tokenEnd: tokenFetchEnd, connect: now() }; });
  },
  listReceived() {
    safe(() => {
      if (!listPending) return;
      const rec = { n: ++listSeq, tokenMs: diffMs(listPending.tokenStart, listPending.tokenEnd), connectToListMs: diffMs(listPending.connect, now()) };
      listPending = null;
      state.list = [rec, ...state.list].slice(0, CHAT_PERF_MAX);
      emit();
    });
  },
  roomTap(kind: ChatPerfEntryKind) {
    safe(() => {
      pending = { kind, tap: now(), tokenStart: null, tokenEnd: null, tokenFetched: false, open: null, history: null, commit: null };
      tokenFetchStart = null; tokenFetchEnd = null;
    });
  },
  roomTokenReady() {
    safe(() => {
      if (!pending) return;
      pending.tokenFetched = tokenFetchStart != null && tokenFetchStart >= pending.tap;
      pending.tokenStart = pending.tokenFetched ? tokenFetchStart : pending.tap;
      pending.tokenEnd = pending.tokenFetched ? tokenFetchEnd : now();
    });
  },
  roomOpen() { safe(() => { if (pending && pending.open == null) pending.open = now(); }); },
  roomHistory() {
    safe(() => {
      if (!pending || pending.history != null) return;
      pending.history = now();
      const p = pending;
      // 2프레임 뒤 = 화면에 실제 그려진 시점(근사)
      requestAnimationFrame(() => requestAnimationFrame(() => chatPerf.finish(p, true)));
    });
  },
  roomCommitted() { safe(() => { if (pending && pending.history != null && pending.commit == null) pending.commit = now(); }); },
  roomFailed() { safe(() => { if (pending) chatPerf.finish(pending, false); }); },
  finish(p: Pending, ok: boolean) {
    safe(() => {
      if (pending !== p) return;
      if (p.commit == null && ok) p.commit = now();
      const rec = buildRecord(++seq, p, ok ? now() : null, ok);
      pending = null;
      state.entries = [rec, ...state.entries].slice(0, CHAT_PERF_MAX);
      emit();
    });
  },
  serverPerf(raw: unknown) {
    safe(() => {
      const t = sanitizeServerPerf(raw);
      if (Object.keys(t).length === 0) return;
      state.server = [{ n: ++serverSeq, t }, ...state.server].slice(0, CHAT_PERF_MAX);
      emit();
    });
  },
  clear() { safe(() => { state = { entries: [], list: [], server: [] }; emit(); }); },
};

const KIND_LABEL: Record<ChatPerfEntryKind, string> = { first: "첫 진입", switch: "방 전환", reentry: "재진입", deeplink: "링크/알림" };
export function kindLabel(k: ChatPerfEntryKind) { return KIND_LABEL[k]; }
const f = (v: number | null) => (v == null ? "-" : `${v}ms`);

/** 복사용 텍스트. ms 숫자와 일반 라벨만 포함. */
export function chatPerfText(s: ChatPerfState): string {
  const lines = ["[chatPerf]"];
  for (const e of s.entries) {
    lines.push(`#${e.n} ${kindLabel(e.kind)}${e.ok ? "" : "(실패)"} 토큰${e.tokenFetched ? "발급" : "재사용"} ${f(e.tokenMs)} | 탭→WS ${f(e.tapToOpenMs)} | WS→history ${f(e.openToHistoryMs)} | history→렌더 ${f(e.historyToRenderMs)} | 전체 ${f(e.tapToVisibleMs)}`);
  }
  for (const l of s.list) lines.push(`목록#${l.n} 토큰 ${f(l.tokenMs)} | 연결→목록 ${f(l.connectToListMs)}`);
  for (const r of s.server || []) lines.push(serverPerfLine(r));
  return lines.join("\n");
}
