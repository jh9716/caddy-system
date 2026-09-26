/**
 * Notice push channel overlap.
 *
 * PushSubscription (web) and DevicePushToken (native FCM) share only userId.
 * There is no installationId / deviceId, so same physical device cannot be
 * joined exactly. Do not disable every web mapping for a user.
 *
 * Safe heuristic:
 * - If that user has an enabled Android native token AND native send can run,
 *   skip only Android-classified web mappings for that user.
 * - Desktop / iOS / unknown web stay (PC browser + Android app both receive).
 * - Android web without a native token still receives Web Push.
 */

import { canAttemptNativePushSend } from "@/lib/fcmCredentials";
import { isAndroidDevice } from "@/lib/pwaInstall";

export type NoticeWebPushRow = {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string | null;
  userAgent?: string | null;
};

export function isAndroidWebPushSubscription(sub: {
  platform?: string | null;
  userAgent?: string | null;
}): boolean {
  const platform = String(sub.platform ?? "").trim().toLowerCase();
  if (platform === "android") return true;
  if (platform === "ios" || platform === "desktop") return false;
  const ua = String(sub.userAgent ?? "");
  return ua.length > 0 && isAndroidDevice(ua);
}

export function nativeUserIdsFromTokens(
  tokens: readonly { userId: number }[]
): number[] {
  return [...new Set(tokens.map((row) => row.userId))];
}

export function filterNoticeWebPushForNativeOverlap(
  subscriptions: readonly NoticeWebPushRow[],
  nativeUserIds: readonly number[]
): NoticeWebPushRow[] {
  const native = new Set(
    nativeUserIds.filter((id) => Number.isInteger(id) && id > 0)
  );
  if (native.size === 0) return [...subscriptions];
  return subscriptions.filter((sub) => {
    if (!native.has(sub.userId)) return true;
    return !isAndroidWebPushSubscription(sub);
  });
}

export function selectNoticeWebPushMappings<T extends NoticeWebPushRow>(
  subscriptions: readonly T[],
  nativeTokens: readonly { userId: number }[],
  options?: { nativeSendFn?: unknown }
): T[] {
  if (
    nativeTokens.length === 0 ||
    !canAttemptNativePushSend({ sendFn: options?.nativeSendFn })
  ) {
    return [...subscriptions];
  }
  return filterNoticeWebPushForNativeOverlap(
    subscriptions,
    nativeUserIdsFromTokens(nativeTokens)
  ) as T[];
}
