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
/** entry: 같은 소켓(시도)으로 측정된 진입 기록 번호. 아직 진행 중이면 null. 다른 방/시도에는 절대 붙지 않는다. */
export type ChatPerfServerRecord = { n: number; attempt: number; entry: number | null; t: Partial<Record<(typeof CHAT_PERF_SERVER_KEYS)[number], number>> };

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

/**
 * 순수: perf 프레임을 어느 진입 기록에 연결할지 판정.
 * - attempt 는 소켓 생성 시점에 캡처한 시도 번호(전역 "현재" 값이 아님).
 * - 이미 끝난 시도면 그 기록 번호, 아직 진행 중인 같은 시도면 null(완료 시 채움), 그 외(지워졌거나 모르는 시도)는 버림.
 * - 같은 시도의 프레임은 1개만 받는다.
 */
export function resolveServerEntry(
  attempt: number | null | undefined,
  pendingAttempt: number | null | undefined,
  attemptToEntry: ReadonlyMap<number, number>,
  seenAttempts: ReadonlySet<number>
): { accept: boolean; entry: number | null } {
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt <= 0) return { accept: false, entry: null };
  if (seenAttempts.has(attempt)) return { accept: false, entry: null };
  const done = attemptToEntry.get(attempt);
  if (typeof done === "number") return { accept: true, entry: done };
  if (pendingAttempt === attempt) return { accept: true, entry: null };
  return { accept: false, entry: null };
}

/** 순수: 서버 구간 한 줄 텍스트. */
export function serverPerfLine(r: ChatPerfServerRecord): string {
  const t = r.t;
  const g = (k: keyof typeof t) => (t[k] == null ? "-" : String(t[k]));
  return `서버#${r.n}(진입#${r.entry ?? "-"}) 토큰검증 ${g("tok")} | session-check왕복 ${g("sc")} (함수 ${g("scApp")} / DB ${g("scDb")} / cold ${g("scCold")}) | 멤버 ${g("mem")} | 서명 ${g("sign")} | Worker합계 ${g("edge")} | DO검증 ${g("doAssert")} | DO수락 ${g("doAccept")} | DO history ${g("doHist")}`;
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
  attempt?: number;
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
let attemptSeq = 0;
const attemptToEntry = new Map<number, number>();
const seenAttempts = new Set<number>();
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
      pending = { attempt: ++attemptSeq, kind, tap: now(), tokenStart: null, tokenEnd: null, tokenFetched: false, open: null, history: null, commit: null };
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
      if (typeof p.attempt === "number") {
        attemptToEntry.set(p.attempt, rec.n);
        if (attemptToEntry.size > 50) attemptToEntry.delete(attemptToEntry.keys().next().value as number);
        state.server = state.server.map((sr) => (sr.attempt === p.attempt && sr.entry == null ? { ...sr, entry: rec.n } : sr));
      }
      state.entries = [rec, ...state.entries].slice(0, CHAT_PERF_MAX);
      emit();
    });
  },
  /** new WebSocket 직후 호출: 이 소켓이 속한 시도 번호(없으면 null). 소켓 클로저에 보관한다. */
  socketAttempt(): number | null {
    if (!enabled) return null;
    try { return pending?.attempt ?? null; } catch { return null; }
  },
  serverPerf(raw: unknown, attempt: number | null) {
    safe(() => {
      const t = sanitizeServerPerf(raw);
      if (Object.keys(t).length === 0) return;
      const r = resolveServerEntry(attempt, pending?.attempt ?? null, attemptToEntry, seenAttempts);
      if (!r.accept || attempt == null) return;
      seenAttempts.add(attempt);
      state.server = [{ n: ++serverSeq, attempt, entry: r.entry, t }, ...state.server].slice(0, CHAT_PERF_MAX);
      emit();
    });
  },
  clear() { safe(() => { state = { entries: [], list: [], server: [] }; attemptToEntry.clear(); emit(); }); },
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
