/**
 * Notice push channel overlap.
 *
 * PushSubscription (web) and DevicePushToken (native FCM) share only userId.
 * There is no installationId / deviceId, so same physical device cannot be
 * joined exactly. Do not disable every web mapping for a user.
 *
 * Dedupe is based on actual native delivery success, not token presence:
 * - Skip Android-classified web only for users with at least one native "sent".
 * - Native failed / gone / skipped → keep that user's Android web (fallback).
 * - Desktop / iOS / unknown web always stay (PC browser + Android app).
 */

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
  succeededNativeUserIds: readonly number[]
): NoticeWebPushRow[] {
  const nativeOk = new Set(
    succeededNativeUserIds.filter((id) => Number.isInteger(id) && id > 0)
  );
  if (nativeOk.size === 0) return [...subscriptions];
  return subscriptions.filter((sub) => {
    if (!nativeOk.has(sub.userId)) return true;
    return !isAndroidWebPushSubscription(sub);
  });
}

export function selectNoticeWebPushMappings<T extends NoticeWebPushRow>(
  subscriptions: readonly T[],
  succeededNativeUserIds: readonly number[]
): T[] {
  return filterNoticeWebPushForNativeOverlap(
    subscriptions,
    succeededNativeUserIds
  ) as T[];
}
