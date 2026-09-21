/**
 * Native DevicePushToken fan-out. Actual FCM HTTP is fail-closed.
 * This PR does not send production FCM. Tests inject sendFn.
 */
import type { PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "@/lib/boardPushRecipients";
import { isDevicePushStoreMissing } from "@/lib/nativePushToken";
import type { WebPushPayload } from "@/lib/webPushSender";

export type NativePushTokenRow = {
  id: number;
  userId: number;
  token: string;
  platform: "ANDROID";
};

export type NativePushDeliveryResult = {
  sent: number;
  failed: number;
  skipped: number;
  deliveries: number;
  reason?: "not_configured" | "send_disabled" | "store_missing";
};

export type NativePushSendFn = (
  token: string,
  payload: WebPushPayload
) => Promise<"sent" | "failed" | "gone">;

/** Same-origin url field reused by Android notification tap. */
export function buildNativePushDataPayload(payload: WebPushPayload): {
  title: string;
  body: string;
  url: string;
} {
  return {
    title: payload.title,
    body: payload.body,
    url: payload.url,
  };
}

export function isFcmSendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FCM_SEND_ENABLED === "1";
}

export function isFcmServerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const projectId = String(env.FIREBASE_PROJECT_ID ?? "").trim();
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL ?? "").trim();
  const privateKey = String(env.FIREBASE_PRIVATE_KEY ?? "").trim();
  return Boolean(projectId && clientEmail && privateKey);
}

export function hasDevicePushTokenDelegate(db: unknown): boolean {
  const rec = db as { devicePushToken?: { findMany?: unknown } } | null;
  return typeof rec?.devicePushToken?.findMany === "function";
}

export async function loadEnabledDevicePushTokens(
  db: PrismaClient,
  userIds: readonly number[]
): Promise<NativePushTokenRow[]> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  if (!hasDevicePushTokenDelegate(db)) return [];
  try {
    const rows = await db.devicePushToken.findMany({
      where: { userId: { in: ids }, enabled: true, platform: "ANDROID" },
      select: { id: true, userId: true, token: true, platform: true },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      token: row.token,
      platform: "ANDROID",
    }));
  } catch (e) {
    if (isDevicePushStoreMissing(e)) return [];
    throw e;
  }
}

export async function deliverNativePushTokens(
  db: PrismaClient,
  tokens: readonly NativePushTokenRow[],
  payload: WebPushPayload,
  options?: { sendFn?: NativePushSendFn; concurrency?: number }
): Promise<NativePushDeliveryResult> {
  const empty = (
    extra?: Partial<NativePushDeliveryResult>
  ): NativePushDeliveryResult => ({
    sent: 0,
    failed: 0,
    skipped: tokens.length,
    deliveries: 0,
    ...extra,
  });

  if (tokens.length === 0) return empty();
  if (!options?.sendFn && !isFcmSendEnabled()) {
    return empty({ reason: "send_disabled" });
  }
  if (!options?.sendFn && !isFcmServerConfigured()) {
    return empty({ reason: "not_configured" });
  }
  if (!options?.sendFn) {
    return empty({ reason: "send_disabled" });
  }

  let sent = 0;
  let failed = 0;
  await mapWithConcurrency(tokens, options.concurrency ?? 4, async (row) => {
    const result = await options.sendFn!(row.token, payload);
    if (result === "sent") {
      sent += 1;
    } else {
      if (hasDevicePushTokenDelegate(db)) {
        await db.devicePushToken.update({
          where: { id: row.id },
          data: { lastFailureAt: new Date() },
        });
      }
      failed += 1;
    }
  });
  return { sent, failed, skipped: 0, deliveries: tokens.length };
}
