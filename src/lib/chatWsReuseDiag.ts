/**
 * Admin-only, default-off WebSocket reuse diagnostics.
 * Counts park/resume/new-socket events in this tab. No room ids, tokens,
 * messages, cookies, or user identifiers. Nothing is posted to a server
 * or written to the app database.
 *
 * SPA navigations keep the in-memory store. A full reload hydrates
 * aggregate counts from sessionStorage. Logout/session reset wipes both.
 */
import { subscribeChatSessionReset } from "./chatSessionReset";

export const CHAT_WS_REUSE_DIAG_STORAGE_KEY = "vh.chatWsReuseDiag.v2";
export const CHAT_WS_REUSE_DIAG_STORAGE_VERSION = 2;
export const CHAT_WS_REUSE_DIAG_MAX_LATENCIES = 80;
/** Below this n, p50/p95 and reuse rate are reference-only — not a confirmed win. */
export const CHAT_WS_REUSE_DIAG_MIN_COMPARE_SAMPLES = 5;

export const CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS = [
  "token",
  "roomId",
  "room",
  "message",
  "messages",
  "cookie",
  "cookies",
  "password",
  "userId",
  "username",
  "displayName",
  "authorization",
] as const;

export type ChatWsReuseDiagFailCode =
  | "ok"
  | "no_park"
  | "no_resume"
  | "ws_ref"
  | "socket_closed"
  | "park_expired"
  | "room_mismatch"
  | "token_mismatch"
  | "token_expiring"
  | "superseded"
  | "resume_null"
  | "resume_auth"
  | "resume_timeout"
  | "compile_off"
  | "runtime_off"
  | "socket_not_open"
  | "park_false";

export type ChatWsReuseDiagSnapshot = {
  running: boolean;
  startedAt: number | null;
  newWs: number;
  newWsOnReentry: number;
  parkAttempts: number;
  parkOk: number;
  parkSkip: number;
  resumeAttempts: number;
  resumeOk: number;
  resumeFail: number;
  failReasons: Record<string, number>;
  /** Reentry latencies that succeeded via parked resume + history. */
  resumeMs: number[];
  /** Reentry latencies that opened a new room WebSocket. First entry is excluded. */
  newWsMs: number[];
  /** All reentry latencies (resumeMs ∪ newWsMs). First entry is excluded. */
  reentryMs: number[];
  ttlExpired: number;
};

export type ChatWsReuseDiagLatencyStat = {
  n: number;
  p50: number | null;
  p95: number | null;
  sufficient: boolean;
};

type PersistedSnapshot = ChatWsReuseDiagSnapshot & { v: 2 };

const EMPTY: ChatWsReuseDiagSnapshot = {
  running: false,
  startedAt: null,
  newWs: 0,
  newWsOnReentry: 0,
  parkAttempts: 0,
  parkOk: 0,
  parkSkip: 0,
  resumeAttempts: 0,
  resumeOk: 0,
  resumeFail: 0,
  failReasons: {},
  resumeMs: [],
  newWsMs: [],
  reentryMs: [],
  ttlExpired: 0,
};

let state: ChatWsReuseDiagSnapshot = cloneSnapshot(EMPTY);
let awaitingReentry = false;
let reentryStartedAt: number | null = null;
const listeners = new Set<() => void>();
let storageBound = false;

function cloneSnapshot(s: ChatWsReuseDiagSnapshot): ChatWsReuseDiagSnapshot {
  return {
    ...s,
    failReasons: { ...s.failReasons },
    resumeMs: s.resumeMs.slice(),
    newWsMs: s.newWsMs.slice(),
    reentryMs: s.reentryMs.slice(),
  };
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

export function isChatWsReuseDiagRecording(): boolean {
  return state.running === true;
}

export function canRecordChatWsReuseDiag(role: string | null | undefined): boolean {
  return role === "admin" && state.running === true;
}

export function percentileMs(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  if (!Number.isFinite(p) || p <= 0) return values[0] ?? null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function reuseSuccessRate(snapshot: ChatWsReuseDiagSnapshot): number | null {
  const den = snapshot.resumeOk + snapshot.newWsOnReentry;
  if (den <= 0) return null;
  return snapshot.resumeOk / den;
}

export function reuseSuccessRateParts(snapshot: ChatWsReuseDiagSnapshot): {
  ok: number;
  newWsOnReentry: number;
  den: number;
  rate: number | null;
  sufficient: boolean;
} {
  const ok = snapshot.resumeOk;
  const newWsOnReentry = snapshot.newWsOnReentry;
  const den = ok + newWsOnReentry;
  return {
    ok,
    newWsOnReentry,
    den,
    rate: den > 0 ? ok / den : null,
    sufficient: den >= CHAT_WS_REUSE_DIAG_MIN_COMPARE_SAMPLES,
  };
}

export function isDiagSampleSufficient(n: number): boolean {
  return n >= CHAT_WS_REUSE_DIAG_MIN_COMPARE_SAMPLES;
}

export function diagLatencyStat(values: readonly number[]): ChatWsReuseDiagLatencyStat {
  return {
    n: values.length,
    p50: percentileMs(values, 50),
    p95: percentileMs(values, 95),
    sufficient: isDiagSampleSufficient(values.length),
  };
}

export function getChatWsReuseDiagSnapshot(): ChatWsReuseDiagSnapshot {
  return cloneSnapshot(state);
}

function emit() {
  persist();
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // listeners must not break chat
    }
  }
}

function isIdleSnapshot(s: ChatWsReuseDiagSnapshot): boolean {
  return (
    s.running === false &&
    s.newWs === 0 &&
    s.newWsOnReentry === 0 &&
    s.parkAttempts === 0 &&
    s.parkOk === 0 &&
    s.parkSkip === 0 &&
    s.resumeAttempts === 0 &&
    s.resumeOk === 0 &&
    s.resumeFail === 0 &&
    s.ttlExpired === 0 &&
    s.resumeMs.length === 0 &&
    s.newWsMs.length === 0 &&
    s.reentryMs.length === 0 &&
    Object.keys(s.failReasons).length === 0
  );
}

function persist() {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (isIdleSnapshot(state)) {
      sessionStorage.removeItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
      return;
    }
    const payload: PersistedSnapshot = { v: CHAT_WS_REUSE_DIAG_STORAGE_VERSION, ...cloneSnapshot(state) };
    const json = JSON.stringify(payload);
    for (const key of CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS) {
      if (json.includes(`"${key}"`)) return;
    }
    sessionStorage.setItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY, json);
  } catch {
    // private mode / quota — keep memory only
  }
}

function isSafePersisted(raw: unknown): raw is PersistedSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if ((CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS as readonly string[]).includes(key)) return false;
  }
  if (rec.v !== CHAT_WS_REUSE_DIAG_STORAGE_VERSION) return false;
  if (typeof rec.running !== "boolean") return false;
  return true;
}

function hydrateFromStorage() {
  if (typeof sessionStorage === "undefined") return;
  try {
    const raw = sessionStorage.getItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isSafePersisted(parsed)) return;
    state = {
      ...cloneSnapshot(EMPTY),
      running: parsed.running === true,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      newWs: num(parsed.newWs),
      newWsOnReentry: num(parsed.newWsOnReentry),
      parkAttempts: num(parsed.parkAttempts),
      parkOk: num(parsed.parkOk),
      parkSkip: num(parsed.parkSkip),
      resumeAttempts: num(parsed.resumeAttempts),
      resumeOk: num(parsed.resumeOk),
      resumeFail: num(parsed.resumeFail),
      failReasons: asCountMap(parsed.failReasons),
      resumeMs: asMsList(parsed.resumeMs),
      newWsMs: asMsList(parsed.newWsMs),
      reentryMs: asMsList(parsed.reentryMs),
      ttlExpired: num(parsed.ttlExpired),
    };
  } catch {
    // ignore corrupt storage
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function asCountMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if ((CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS as readonly string[]).includes(k)) continue;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) out[k] = Math.floor(val);
  }
  return out;
}

function asMsList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0)
    .slice(0, CHAT_WS_REUSE_DIAG_MAX_LATENCIES);
}

function bumpFail(code: string) {
  state.failReasons[code] = (state.failReasons[code] || 0) + 1;
}

function pushMs(list: number[], ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  list.push(Math.round(ms));
  if (list.length > CHAT_WS_REUSE_DIAG_MAX_LATENCIES) list.shift();
}

function consumeRoomSelectMs(): { ms: number; reentry: boolean } | null {
  if (reentryStartedAt == null) return null;
  const ms = Math.max(0, nowMs() - reentryStartedAt);
  const reentry = awaitingReentry;
  reentryStartedAt = null;
  awaitingReentry = false;
  return { ms, reentry };
}

export function startChatWsReuseDiag(input?: { adminAllowed?: boolean }): boolean {
  if (input?.adminAllowed !== true) return false;
  bindSessionResetOnce();
  if (!state.running) {
    state.running = true;
    state.startedAt = nowMs();
  }
  emit();
  return true;
}

export function stopChatWsReuseDiag(): void {
  state.running = false;
  awaitingReentry = false;
  reentryStartedAt = null;
  emit();
}

export function resetChatWsReuseDiag(): void {
  const keepRunning = state.running === true;
  state = cloneSnapshot(EMPTY);
  awaitingReentry = false;
  reentryStartedAt = null;
  if (keepRunning) {
    state.running = true;
    state.startedAt = nowMs();
  } else if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  emit();
}

export function handleChatWsReuseDiagSessionReset(): void {
  state = cloneSnapshot(EMPTY);
  awaitingReentry = false;
  reentryStartedAt = null;
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  emit();
}

export function markChatWsReuseDiagLeftRoom(): void {
  if (!state.running) return;
  awaitingReentry = true;
  reentryStartedAt = null;
}

export function markChatWsReuseDiagRoomSelect(): void {
  if (!state.running) return;
  reentryStartedAt = nowMs();
}

export function noteChatWsReuseDiagParkAttempt(): void {
  if (!state.running) return;
  state.parkAttempts += 1;
  emit();
}

export function noteChatWsReuseDiagParkOk(): void {
  if (!state.running) return;
  state.parkOk += 1;
  emit();
}

export function noteChatWsReuseDiagParkSkip(code: ChatWsReuseDiagFailCode): void {
  if (!state.running) return;
  state.parkSkip += 1;
  bumpFail(code);
  emit();
}

export function noteChatWsReuseDiagResumeAttempt(): void {
  if (!state.running) return;
  state.resumeAttempts += 1;
  emit();
}

/** Call only after parked resume received a history frame. */
export function noteChatWsReuseDiagResumeOk(): void {
  if (!state.running) return;
  state.resumeOk += 1;
  const timed = consumeRoomSelectMs();
  if (timed?.reentry) {
    pushMs(state.resumeMs, timed.ms);
    pushMs(state.reentryMs, timed.ms);
  }
  emit();
}

export function noteChatWsReuseDiagResumeSkip(code: ChatWsReuseDiagFailCode): void {
  if (!state.running) return;
  bumpFail(code);
  emit();
}

export function noteChatWsReuseDiagResumeFail(code: ChatWsReuseDiagFailCode): void {
  if (!state.running) return;
  state.resumeFail += 1;
  bumpFail(code);
  emit();
}

export function noteChatWsReuseDiagTtlExpired(): void {
  if (!state.running) return;
  state.ttlExpired += 1;
  bumpFail("park_expired");
  emit();
}

export function noteChatWsReuseDiagNewRoomSocket(): void {
  if (!state.running) return;
  state.newWs += 1;
  if (awaitingReentry) state.newWsOnReentry += 1;
  emit();
}

export function noteChatWsReuseDiagNewWsHistory(): void {
  if (!state.running) return;
  const timed = consumeRoomSelectMs();
  if (!timed?.reentry) return;
  pushMs(state.newWsMs, timed.ms);
  pushMs(state.reentryMs, timed.ms);
  emit();
}

export function subscribeChatWsReuseDiag(listener: () => void): () => void {
  bindSessionResetOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function bindSessionResetOnce() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  subscribeChatSessionReset(() => {
    handleChatWsReuseDiagSessionReset();
  });
}

export function resetChatWsReuseDiagForTests(): void {
  state = cloneSnapshot(EMPTY);
  awaitingReentry = false;
  reentryStartedAt = null;
  listeners.clear();
  storageBound = false;
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export function hydrateChatWsReuseDiagFromStorageForTests(): void {
  hydrateFromStorage();
}

if (typeof window !== "undefined") {
  hydrateFromStorage();
  bindSessionResetOnce();
}
