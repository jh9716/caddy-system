/**
 * Chat photo prepare/finalize hot-path timing and architecture notes.
 *
 * Production Neon: ap-southeast-1 (Singapore).
 * Vercel Node default without `regions` is iad1 (Washington, D.C.).
 * Official pin: vercel.json `"regions": ["sin1"]` (Singapore, ap-southeast-1).
 * Do not use deprecated Next `preferredRegion` / Edge runtime.
 *
 * Blob PUT is a separate client→Vercel Blob ingress hop. Function region
 * does not move that store. Chat-only opt-in `CHAT_PHOTO_STORAGE=r2` issues
 * a local HMAC grant and PUTs to the existing verthill-chat Worker / R2.
 * Unset keeps the Vercel Blob fallback. CourseReport / Notice stay on Blob.
 *
 * Round trips stay prepare → PUT → finalize → WS. Finalize validation
 * must complete before a claim is issued. Unverified objects must not
 * be published to recipients. A Worker-signed upload receipt lets the
 * normal R2 finalize skip /internal/media/inspect. Missing/invalid
 * receipts still inspect.
 *
 * Logs are numeric only: no URLs, tokens, claims, storage keys, or user PII.
 */

export const CHAT_PHOTO_HOTPATH_SAFE_STEPS = [
  "auth",
  "roomAccess",
  "count",
  "maintenance",
  "create",
  "countAfter",
  "signedPut",
  "grantSign",
  "dbFind",
  "blobInspect",
  "blobHeadFallback",
  "r2Inspect",
  "receiptVerify",
  "dbUpdate",
  "claimSign",
] as const;

export const CHAT_PHOTO_HOTPATH_SAFE_FLAGS = [
  "roomAccessFastPath",
  "finalizeInspectSkipped",
] as const;

export type ChatPhotoHotpathStep = (typeof CHAT_PHOTO_HOTPATH_SAFE_STEPS)[number];
export type ChatPhotoHotpathFlag = (typeof CHAT_PHOTO_HOTPATH_SAFE_FLAGS)[number];

export type ChatPhotoHotpathSummary = {
  route: "prepare" | "finalize";
  region: string;
  cold: boolean;
  totalMs: number;
  steps: Partial<Record<ChatPhotoHotpathStep, number>>;
  flags?: Partial<Record<ChatPhotoHotpathFlag, boolean>>;
};

type ChatPhotoHotpathGlobal = typeof globalThis & {
  __caddyChatPhotoFnWarm?: boolean;
};

export function chatPhotoFunctionRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region = String(env.VERCEL_REGION || "").trim();
  return region || "local";
}

export function consumeChatPhotoFunctionCold(): boolean {
  const g = globalThis as ChatPhotoHotpathGlobal;
  const cold = !g.__caddyChatPhotoFnWarm;
  g.__caddyChatPhotoFnWarm = true;
  return cold;
}

export function isSafeChatPhotoHotpathStep(name: string): name is ChatPhotoHotpathStep {
  return (CHAT_PHOTO_HOTPATH_SAFE_STEPS as readonly string[]).includes(name);
}

export function isSafeChatPhotoHotpathFlag(name: string): name is ChatPhotoHotpathFlag {
  return (CHAT_PHOTO_HOTPATH_SAFE_FLAGS as readonly string[]).includes(name);
}

export function createChatPhotoHotpathClock() {
  const steps: Partial<Record<ChatPhotoHotpathStep, number>> = {};
  const flags: Partial<Record<ChatPhotoHotpathFlag, boolean>> = {};
  const started = nowMs();
  let last = started;
  return {
    mark(name: string) {
      if (!isSafeChatPhotoHotpathStep(name)) return;
      const at = nowMs();
      steps[name] = roundMs(at - last);
      last = at;
    },
    flag(name: string, value: boolean) {
      if (!isSafeChatPhotoHotpathFlag(name)) return;
      flags[name] = value;
    },
    summary(route: "prepare" | "finalize"): ChatPhotoHotpathSummary {
      const out: ChatPhotoHotpathSummary = {
        route,
        region: chatPhotoFunctionRegion(),
        cold: consumeChatPhotoFunctionCold(),
        totalMs: roundMs(nowMs() - started),
        steps,
      };
      if (Object.keys(flags).length > 0) out.flags = flags;
      return out;
    },
  };
}

export function logChatPhotoHotpath(summary: ChatPhotoHotpathSummary): void {
  console.info("[chat-photo-hotpath]", JSON.stringify(summary));
}

export function parseChatPhotoHotpath(value: unknown): ChatPhotoHotpathSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.route !== "prepare" && row.route !== "finalize") return null;
  const totalMs = Number(row.totalMs);
  if (!Number.isFinite(totalMs)) return null;
  const steps: Partial<Record<ChatPhotoHotpathStep, number>> = {};
  if (row.steps && typeof row.steps === "object") {
    for (const [key, raw] of Object.entries(row.steps as Record<string, unknown>)) {
      if (!isSafeChatPhotoHotpathStep(key)) continue;
      const ms = Number(raw);
      if (Number.isFinite(ms)) steps[key] = roundMs(ms);
    }
  }
  const flags: Partial<Record<ChatPhotoHotpathFlag, boolean>> = {};
  if (row.flags && typeof row.flags === "object") {
    for (const [key, raw] of Object.entries(row.flags as Record<string, unknown>)) {
      if (!isSafeChatPhotoHotpathFlag(key)) continue;
      if (raw === true) flags[key] = true;
    }
  }
  const parsed: ChatPhotoHotpathSummary = {
    route: row.route,
    region: typeof row.region === "string" && row.region.trim() ? row.region.trim() : "local",
    cold: row.cold === true,
    totalMs: roundMs(totalMs),
    steps,
  };
  if (Object.keys(flags).length > 0) parsed.flags = flags;
  return parsed;
}

export function shouldRunBackgroundChatPhotoCleanup(random = Math.random()): boolean {
  return random < 0.1;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms * 10) / 10);
}
