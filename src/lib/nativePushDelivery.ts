/**
 * Native DevicePushToken fan-out. Actual FCM HTTP v1 is fail-closed
 * unless FCM_SEND_ENABLED=1 and service-account env parse. Tests inject
 * sendFn or fetchFn — no live Firebase from unit tests.
 */
import type { PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "@/lib/boardPushRecipients";
import {
  isFcmSendEnabled,
  isFcmServerConfigured,
} from "@/lib/fcmCredentials";
import { sendFcmHttpV1, type FcmFetchFn } from "@/lib/fcmHttpV1";
import {
  disableDevicePushTokenById,
  isDevicePushStoreMissing,
  touchDevicePushTokenFailure,
} from "@/lib/nativePushToken";
import { safeReturnPath } from "@/lib/safeReturnPath";
import type { WebPushPayload } from "@/lib/webPushSender";

export {
  isFcmSendEnabled,
  isFcmServerConfigured,
  canAttemptNativePushSend,
  hasPushDeliveryTargets,
} from "@/lib/fcmCredentials";

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
  removedStale: number;
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
  tag?: string;
} {
  const url = safeReturnPath(payload.url) ?? "";
  return {
    title: payload.title,
    body: payload.body,
    url,
    ...(payload.tag ? { tag: payload.tag } : {}),
  };
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
  options?: {
    sendFn?: NativePushSendFn;
    fetchFn?: FcmFetchFn;
    env?: NodeJS.ProcessEnv;
    concurrency?: number;
  }
): Promise<NativePushDeliveryResult> {
  const env = options?.env ?? process.env;
  const empty = (
    extra?: Partial<NativePushDeliveryResult>
  ): NativePushDeliveryResult => ({
    sent: 0,
    failed: 0,
    skipped: tokens.length,
    deliveries: 0,
    removedStale: 0,
    ...extra,
  });

  if (tokens.length === 0) return empty();
  if (!options?.sendFn && !isFcmSendEnabled(env)) {
    return empty({ reason: "send_disabled" });
  }
  if (!options?.sendFn && !isFcmServerConfigured(env)) {
    return empty({ reason: "not_configured" });
  }

  const send: NativePushSendFn =
    options.sendFn ??
    ((token, body) =>
      sendFcmHttpV1(token, body, { env, fetchFn: options.fetchFn }));

  let sent = 0;
  let failed = 0;
  let removedStale = 0;
  await mapWithConcurrency(tokens, options.concurrency ?? 4, async (row) => {
    const result = await send(row.token, payload);
    if (result === "sent") {
      sent += 1;
      return;
    }
    if (!hasDevicePushTokenDelegate(db)) {
      if (result === "gone") removedStale += 1;
      else failed += 1;
      return;
    }
    try {
      if (result === "gone") {
        await disableDevicePushTokenById(db, row.id);
        removedStale += 1;
      } else {
        await touchDevicePushTokenFailure(db, row.id);
        failed += 1;
      }
    } catch (e) {
      if (!isDevicePushStoreMissing(e)) throw e;
      failed += 1;
    }
  });
  return {
    sent,
    failed,
    skipped: 0,
    deliveries: tokens.length,
    removedStale,
  };
}
