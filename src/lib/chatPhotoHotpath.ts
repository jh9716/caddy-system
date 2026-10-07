/**
 * Chat photo prepare/finalize hot-path timing and architecture notes.
 *
 * Production Neon: ap-southeast-1 (Singapore).
 * Vercel Node default without `regions` is iad1 (Washington, D.C.).
 * Official pin: vercel.json `"regions": ["sin1"]` (Singapore, ap-southeast-1).
 * Do not use deprecated Next `preferredRegion` / Edge runtime.
 *
 * Blob PUT is a separate client→Vercel Blob ingress hop. Function region
 * does not move that store. If Korea 640KB PUT stays ~3s after API/DB
 * fixes, next storage candidate is Cloudflare R2 (Worker already in use).
 * This module does not migrate storage.
 *
 * Round trips stay prepare → PUT → finalize → WS. Finalize validation
 * must complete before a claim is issued. Unverified objects must not
 * be published to recipients. Worker-side READY check is a later option
 * and is not implemented here.
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
  "dbFind",
  "blobInspect",
  "blobHeadFallback",
  "dbUpdate",
  "claimSign",
] as const;

export type ChatPhotoHotpathStep = (typeof CHAT_PHOTO_HOTPATH_SAFE_STEPS)[number];

export type ChatPhotoHotpathSummary = {
  route: "prepare" | "finalize";
  region: string;
  cold: boolean;
  totalMs: number;
  steps: Partial<Record<ChatPhotoHotpathStep, number>>;
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

export function createChatPhotoHotpathClock() {
  const steps: Partial<Record<ChatPhotoHotpathStep, number>> = {};
  const started = nowMs();
  let last = started;
  return {
    mark(name: string) {
      if (!isSafeChatPhotoHotpathStep(name)) return;
      const at = nowMs();
      steps[name] = roundMs(at - last);
      last = at;
    },
    summary(route: "prepare" | "finalize"): ChatPhotoHotpathSummary {
      return {
        route,
        region: chatPhotoFunctionRegion(),
        cold: consumeChatPhotoFunctionCold(),
        totalMs: roundMs(nowMs() - started),
        steps,
      };
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
  return {
    route: row.route,
    region: typeof row.region === "string" && row.region.trim() ? row.region.trim() : "local",
    cold: row.cold === true,
    totalMs: roundMs(totalMs),
    steps,
  };
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
