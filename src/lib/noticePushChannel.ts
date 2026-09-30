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
 */

export {
  isAndroidWebPushSubscription,
  nativeUserIdsFromTokens,
  type WebPushChannelRow as NoticeWebPushRow,
  filterWebPushForNativeOverlap as filterNoticeWebPushForNativeOverlap,
  selectWebPushMappingsAfterNativeSuccess as selectNoticeWebPushMappings,
} from "@/lib/pushChannelOverlap";
