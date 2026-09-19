/**
 * Admin device push registration copy. Safe for client.
 * Does not change caddy/leader PushNotificationCard defaults.
 */
import type { PushNotificationSurface } from "@/lib/pushNotificationUi";

export const ADMIN_PUSH_UI_TITLE = "알림 설정";
export const ADMIN_PUSH_UI_ENABLE = "이 기기 알림 받기";
export const ADMIN_PUSH_UI_DISABLE = "알림 해제";
export const ADMIN_PUSH_UI_STATUS_PREFIX = "현재 상태: ";
export const ADMIN_PUSH_UI_REGISTERED = "등록됨";
export const ADMIN_PUSH_UI_UNREGISTERED = "등록 안 됨";
export const ADMIN_PUSH_UI_DENIED = "브라우저 권한 차단";

export function adminPushSurfaceStatus(surface: PushNotificationSurface): string {
  switch (surface) {
    case "on":
      return `${ADMIN_PUSH_UI_STATUS_PREFIX}${ADMIN_PUSH_UI_REGISTERED}`;
    case "blocked":
      return `${ADMIN_PUSH_UI_STATUS_PREFIX}${ADMIN_PUSH_UI_DENIED}`;
    case "preparing":
    case "unsupported":
    case "ios-add-to-home":
      return "";
    default:
      return `${ADMIN_PUSH_UI_STATUS_PREFIX}${ADMIN_PUSH_UI_UNREGISTERED}`;
  }
}
