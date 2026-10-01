/**
 * Notice push channel overlap.
 *
 * Shared implementation lives in pushChannelOverlap.ts so board / course
 * report can reuse the same success-based Android-web skip.
 *
 * PushSubscription (web) and DevicePushToken (native FCM) share only userId.
 * There is no installationId / deviceId, so same physical device cannot be
 * joined exactly. Do not disable every web mapping for a user.
 *
 * Dedupe is based on actual native delivery success, not token presence:
 * - Skip Android-classified web only for users with at least one native "sent".
 * - Native failed / gone / skipped → keep that user's Android web (fallback).
 * - Desktop / iOS / unknown web always stay (PC browser + Android app).
 *
 * Preview assumes enabled native tokens will "sent" and reuses the same
 * select helper. It never sends FCM or Web Push.
 */

import {
  nativeUserIdsFromTokens,
  selectWebPushMappingsAfterNativeSuccess,
  type WebPushChannelRow,
} from "@/lib/pushChannelOverlap";

export {
  isAndroidWebPushSubscription,
  nativeUserIdsFromTokens,
  type WebPushChannelRow as NoticeWebPushRow,
  filterWebPushForNativeOverlap as filterNoticeWebPushForNativeOverlap,
  selectWebPushMappingsAfterNativeSuccess as selectNoticeWebPushMappings,
} from "@/lib/pushChannelOverlap";

export type NoticePushPreviewChannelCounts = {
  eligibleUsers: number;
  subscribedUsers: number;
  subscriptions: number;
  nativeTokens: number;
  nativeUsers: number;
  webSubscriptions: number;
  webUsers: number;
  noSubscription: number;
};

/**
 * Preview assumes every enabled native token will "sent".
 * Same overlap helper as send: Android web is dropped only for those users.
 * Native failure → extra web fallback is a send-time difference, not preview.
 */
export function planNoticePushPreviewChannels(input: {
  eligibleUsers: number;
  webMappings: readonly WebPushChannelRow[];
  nativeTokens: readonly { userId: number }[];
}): {
  expectedNativeUserIds: number[];
  expectedWebMappings: WebPushChannelRow[];
  counts: NoticePushPreviewChannelCounts;
} {
  const expectedNativeUserIds = nativeUserIdsFromTokens(input.nativeTokens);
  const expectedWebMappings = selectWebPushMappingsAfterNativeSuccess(
    input.webMappings,
    expectedNativeUserIds
  );
  const nativeTokens = input.nativeTokens.length;
  const nativeUsers = expectedNativeUserIds.length;
  const webSubscriptions = expectedWebMappings.length;
  const webUsers = new Set(expectedWebMappings.map((row) => row.userId)).size;
  const reachable = new Set<number>([
    ...expectedNativeUserIds,
    ...expectedWebMappings.map((row) => row.userId),
  ]);
  const subscribedUsers = reachable.size;
  return {
    expectedNativeUserIds,
    expectedWebMappings,
    counts: {
      eligibleUsers: input.eligibleUsers,
      subscribedUsers,
      subscriptions: nativeTokens + webSubscriptions,
      noSubscription: Math.max(0, input.eligibleUsers - subscribedUsers),
      nativeTokens,
      nativeUsers,
      webSubscriptions,
      webUsers,
    },
  };
}
