/**
 * Admin 1-user test push. Writes lastSuccessAt / lastFailureAt / stale delete
 * only when deliverWebPush is actually invoked.
 */
import type { PrismaClient } from "@prisma/client";
import {
  NATIVE_TEST_PUSH_BODY,
  NATIVE_TEST_PUSH_TAG,
  NATIVE_TEST_PUSH_TITLE,
  NATIVE_TEST_PUSH_URL,
  TEST_PUSH_BODY,
  TEST_PUSH_CONFIRM,
  TEST_PUSH_TITLE,
  TEST_PUSH_URL,
} from "@/lib/webPushTestConstants";
import { deliverWebPushMappings } from "@/lib/pushDelivery";
import type { FcmFetchFn } from "@/lib/fcmHttpV1";
import {
  canAttemptNativePushSend,
  deliverNativePushTokens,
  hasDevicePushTokenDelegate,
  hasPushDeliveryTargets,
  loadEnabledDevicePushTokens,
  type NativePushSendFn,
} from "@/lib/nativePushDelivery";
import { isDevicePushStoreMissing } from "@/lib/nativePushToken";
import { isPushStoreMissing } from "@/lib/pushSubscriptionStore";
import { isWebPushSendConfigured, readWebPushSendCredentials } from "@/lib/pushVapid";
import { type WebPushSendFn } from "@/lib/webPushSender";

export class PushTestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "PushTestError";
  }
}

export type PushTestAggregate = {
  ok: boolean;
  sent: number;
  failed: number;
  removedStale: number;
  deliveries: number;
  error?: string;
};

const ALLOWED_ROLES = new Set(["caddy", "leader"]);

export type PushTestChannel = "web" | "native";

export function parseTestPushChannel(raw: unknown): PushTestChannel {
  if (raw == null || raw === "") return "web";
  if (raw === "web" || raw === "native") return raw;
  throw new PushTestError("invalid_channel", "channel이 올바르지 않습니다.", 400);
}

export function parseTestPushRequest(body: unknown): {
  userId: number | null;
  confirm: string;
  channel: PushTestChannel;
} {
  if (Array.isArray(body)) {
    throw new PushTestError("invalid_target", "한 명만 지정할 수 있습니다.", 400);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (rec.userIds != null || rec.targets != null || rec.users != null || Array.isArray(rec.userId)) {
    throw new PushTestError("invalid_target", "한 명만 지정할 수 있습니다.", 400);
  }
  const confirm = String(rec.confirm ?? "");
  if (confirm !== TEST_PUSH_CONFIRM) {
    throw new PushTestError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  const channel = parseTestPushChannel(rec.channel);
  if (channel === "native" && (rec.userId == null || rec.userId === "")) {
    return { userId: null, confirm, channel };
  }
  const n = typeof rec.userId === "number" ? rec.userId : Number(rec.userId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  return { userId: n, confirm, channel };
}

export async function countEnabledAndroidDeviceTokens(
  db: PrismaClient,
  userId: number
): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  if (!hasDevicePushTokenDelegate(db)) return 0;
  try {
    return await db.devicePushToken.count({
      where: { userId, enabled: true, platform: "ANDROID" },
    });
  } catch (e) {
    if (isDevicePushStoreMissing(e)) return 0;
    throw e;
  }
}

/**
 * Native FCM test for the signed-in admin only.
 * Does not read or send PushSubscription. One enabled Android token.
 * Success does not write DevicePushToken. FCM gate stays in deliverNativePushTokens.
 */
export async function sendNativeTestPushToSelf(
  db: PrismaClient,
  userId: number,
  options?: {
    sendFn?: NativePushSendFn;
    fetchFn?: FcmFetchFn;
    env?: NodeJS.ProcessEnv;
  }
): Promise<PushTestAggregate> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user || user.role !== "admin") {
    throw new PushTestError("invalid_target", "본인 Android 알림만 테스트할 수 있습니다.", 400);
  }
  if (!hasDevicePushTokenDelegate(db)) {
    return {
      ok: true,
      sent: 0,
      failed: 0,
      removedStale: 0,
      deliveries: 0,
      error: "no_native_token",
    };
  }

  let row: { id: number; userId: number; token: string; platform: "ANDROID" } | null;
  try {
    row = await db.devicePushToken.findFirst({
      where: { userId, enabled: true, platform: "ANDROID" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, userId: true, token: true, platform: true },
    });
  } catch (e) {
    if (isDevicePushStoreMissing(e)) {
      return {
        ok: true,
        sent: 0,
        failed: 0,
        removedStale: 0,
        deliveries: 0,
        error: "no_native_token",
      };
    }
    throw e;
  }
  if (!row) {
    return {
      ok: true,
      sent: 0,
      failed: 0,
      removedStale: 0,
      deliveries: 0,
      error: "no_native_token",
    };
  }

  const payload = {
    title: NATIVE_TEST_PUSH_TITLE,
    body: NATIVE_TEST_PUSH_BODY,
    url: NATIVE_TEST_PUSH_URL,
    tag: NATIVE_TEST_PUSH_TAG,
  };
  const delivered = await deliverNativePushTokens(db, [row], payload, {
    sendFn: options?.sendFn,
    fetchFn: options?.fetchFn,
    env: options?.env,
    concurrency: 1,
  });
  if (delivered.reason === "send_disabled" || delivered.reason === "not_configured") {
    return {
      ok: true,
      sent: 0,
      failed: 0,
      removedStale: 0,
      deliveries: 0,
      error: "fcm_send_disabled",
    };
  }
  return {
    ok: true,
    sent: delivered.sent,
    failed: delivered.failed,
    removedStale: delivered.removedStale,
    deliveries: delivered.deliveries,
  };
}

export async function sendTestPushToUser(
  db: PrismaClient,
  userId: number,
  confirm: string,
  options?: { sendFn?: WebPushSendFn; nativeSendFn?: NativePushSendFn }
): Promise<PushTestAggregate> {
  if (confirm !== TEST_PUSH_CONFIRM) {
    throw new PushTestError("invalid_confirm", "confirm이 필요합니다.", 400);
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PushTestError("invalid_target", "userId가 올바르지 않습니다.", 400);
  }
  if (!isWebPushSendConfigured()) {
    throw new PushTestError("push_not_configured", "알림 설정 준비 중", 503);
  }
  const creds = readWebPushSendCredentials();
  if (!creds) {
    throw new PushTestError("push_not_configured", "알림 설정 준비 중", 503);
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      caddy: { select: { employmentStatus: true } },
      pushSubscriptions: {
        where: { enabled: true },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      },
    },
  });
  if (!user) {
    throw new PushTestError("not_found", "대상을 찾을 수 없습니다.", 404);
  }
  if (!ALLOWED_ROLES.has(user.role)) {
    throw new PushTestError("invalid_target", "캐디 또는 조장만 테스트할 수 있습니다.", 400);
  }
  if (user.caddy && String(user.caddy.employmentStatus) === "RETIRED") {
    throw new PushTestError("retired", "퇴사한 캐디에게는 보낼 수 없습니다.", 400);
  }
  const nativeTokens = await loadEnabledDevicePushTokens(db, [userId]);
  if (!hasPushDeliveryTargets(user.pushSubscriptions.length, nativeTokens.length)) {
    return { ok: true, sent: 0, failed: 0, removedStale: 0, deliveries: 0, error: "no_subscription" };
  }

  const payload = { title: TEST_PUSH_TITLE, body: TEST_PUSH_BODY, url: TEST_PUSH_URL };
  let delivered = { sent: 0, failed: 0, removedStale: 0, deliveries: 0 };
  if (user.pushSubscriptions.length > 0) {
    delivered = await deliverWebPushMappings(
      db,
      user.pushSubscriptions.map((sub) => ({
        id: sub.id,
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
      })),
      payload,
      { sendFn: options?.sendFn, credentials: creds, concurrency: 1 }
    );
  } else if (!canAttemptNativePushSend({ sendFn: options?.nativeSendFn })) {
    return { ok: true, sent: 0, failed: 0, removedStale: 0, deliveries: 0 };
  }
  await deliverNativePushTokens(db, nativeTokens, payload, {
    sendFn: options?.nativeSendFn,
  });
  return {
    ok: true,
    sent: delivered.sent,
    failed: delivered.failed,
    removedStale: delivered.removedStale,
    deliveries: delivered.deliveries,
  };
}

export function isPushTestStoreMissing(e: unknown): boolean {
  return isPushStoreMissing(e);
}
