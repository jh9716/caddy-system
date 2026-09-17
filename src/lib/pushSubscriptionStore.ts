/**
 * PushSubscription persistence. No send. No caddyId snapshot.
 * local/production writes only through this module + the user-owned API.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeUrlSafeBase64 } from "@/lib/pushVapid";

export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_USER_AGENT_LENGTH = 256;
export const MAX_PLATFORM_LENGTH = 32;

export class PushSubscriptionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message);
    this.name = "PushSubscriptionError";
  }
}

export function isPushStoreMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /does not exist|PushSubscription/i.test(msg) && /relation|table/i.test(msg);
}

function asText(v: unknown): string {
  return String(v ?? "").trim();
}

export function validatePushEndpoint(raw: unknown): string {
  const endpoint = asText(raw);
  if (!endpoint) {
    throw new PushSubscriptionError("invalid_subscription", "endpoint가 필요합니다.", 400);
  }
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new PushSubscriptionError("invalid_subscription", "endpoint가 너무 깁니다.", 400);
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushSubscriptionError("invalid_subscription", "endpoint가 올바르지 않습니다.", 400);
  }
  if (url.protocol !== "https:") {
    throw new PushSubscriptionError("invalid_subscription", "endpoint는 https 여야 합니다.", 400);
  }
  if (!url.hostname) {
    throw new PushSubscriptionError("invalid_subscription", "endpoint가 올바르지 않습니다.", 400);
  }
  return endpoint;
}

function validateKey(raw: unknown, field: "p256dh" | "auth", minBytes: number, maxBytes: number): string {
  const value = asText(raw);
  if (!value) {
    throw new PushSubscriptionError("invalid_subscription", `${field}가 필요합니다.`, 400);
  }
  const bytes = decodeUrlSafeBase64(value);
  if (!bytes || bytes.length < minBytes || bytes.length > maxBytes) {
    throw new PushSubscriptionError("invalid_subscription", `${field}가 올바르지 않습니다.`, 400);
  }
  return value;
}

export function parsePushSubscriptionInput(body: unknown): {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  platform: string | null;
} {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const keys =
    rec.keys && typeof rec.keys === "object"
      ? (rec.keys as Record<string, unknown>)
      : rec;
  const endpoint = validatePushEndpoint(rec.endpoint);
  const p256dh = validateKey(keys.p256dh ?? rec.p256dh, "p256dh", 32, 128);
  const auth = validateKey(keys.auth ?? rec.auth, "auth", 12, 32);
  let userAgent = asText(rec.userAgent);
  if (userAgent.length > MAX_USER_AGENT_LENGTH) {
    userAgent = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  }
  let platform = asText(rec.platform).toLowerCase();
  if (!platform) platform = "";
  if (platform && !["ios", "android", "desktop", "other"].includes(platform)) {
    platform = "other";
  }
  if (platform.length > MAX_PLATFORM_LENGTH) platform = platform.slice(0, MAX_PLATFORM_LENGTH);
  return {
    endpoint,
    p256dh,
    auth,
    userAgent: userAgent || null,
    platform: platform || null,
  };
}

export async function userHasEnabledPushSubscription(
  db: PrismaClient,
  userId: number
): Promise<boolean> {
  const n = await db.pushSubscription.count({
    where: { userId, enabled: true },
  });
  return n > 0;
}

/**
 * Same endpoint → one row. Reassigns to the current user so the previous
 * account does not keep receiving on this browser/PWA.
 */
export async function upsertPushSubscriptionForUser(
  db: PrismaClient,
  userId: number,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    platform: string | null;
  }
): Promise<{ userId: number }> {
  await db.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      platform: input.platform,
      enabled: true,
    },
    update: {
      userId,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      platform: input.platform,
      enabled: true,
    },
  });
  return { userId };
}

/** Hard delete this user's row for the endpoint (PII minimization). */
export async function deletePushSubscriptionForUser(
  db: PrismaClient,
  userId: number,
  endpoint: string
): Promise<{ deleted: number }> {
  const result = await db.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
  return { deleted: result.count };
}
