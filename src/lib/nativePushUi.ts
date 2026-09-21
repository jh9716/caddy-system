/**
 * Android Capacitor Native Push status. Separate from Web Push surfaces.
 * Never reuses the Web Push unsupported copy.
 */

export type NativePushPermission = "prompt" | "granted" | "denied" | "unknown";

export type NativePushSurface =
  | "available"
  | "permission-needed"
  | "registered"
  | "blocked"
  | "preparing";

export const NATIVE_PUSH_UI_TITLE = "알림 설정";
export const NATIVE_PUSH_UI_ENABLE = "알림 받기";
export const NATIVE_PUSH_UI_DISABLE = "이 기기 알림 해제";
export const NATIVE_PUSH_UI_AVAILABLE = "알림 사용 가능";
export const NATIVE_PUSH_UI_PERMISSION_NEEDED = "알림 권한 필요";
export const NATIVE_PUSH_UI_REGISTERED = "알림 등록됨";
export const NATIVE_PUSH_UI_BLOCKED = "알림 차단됨";
export const NATIVE_PUSH_UI_PREPARING = "알림 설정 준비 중";

export function resolveNativePushSurface(input: {
  pluginAvailable: boolean;
  permission: NativePushPermission;
  serverRegistered: boolean;
  tokenReady: boolean;
}): NativePushSurface {
  if (!input.pluginAvailable) return "preparing";
  if (input.permission === "denied") return "blocked";
  if (
    input.permission === "granted" &&
    input.tokenReady &&
    input.serverRegistered
  ) {
    return "registered";
  }
  if (input.permission === "prompt" || input.permission === "unknown") {
    return "permission-needed";
  }
  return "available";
}

export function nativePushSurfaceLabel(surface: NativePushSurface): string {
  switch (surface) {
    case "preparing":
      return NATIVE_PUSH_UI_PREPARING;
    case "blocked":
      return NATIVE_PUSH_UI_BLOCKED;
    case "registered":
      return NATIVE_PUSH_UI_REGISTERED;
    case "permission-needed":
      return NATIVE_PUSH_UI_PERMISSION_NEEDED;
    default:
      return NATIVE_PUSH_UI_AVAILABLE;
  }
}
