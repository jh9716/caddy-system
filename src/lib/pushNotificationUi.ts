/**
 * /caddy 알림 설정 카드 상태. permission은 클릭 후에만 요청한다.
 */
import { isIosDevice, isStandaloneDisplay } from "@/lib/pwaInstall";

export type PushPermission = "default" | "granted" | "denied" | "unsupported";

export type PushNotificationSurface =
  | "preparing"
  | "unsupported"
  | "ios-add-to-home"
  | "blocked"
  | "on"
  | "off";

export const PUSH_UI_TITLE = "알림 설정";
export const PUSH_UI_ENABLE = "알림 받기";
export const PUSH_UI_DISABLE = "알림 끄기";
export const PUSH_UI_ON = "알림 사용 중";
export const PUSH_UI_OFF = "알림 꺼짐";
export const PUSH_UI_BLOCKED = "브라우저에서 차단됨";
export const PUSH_UI_UNSUPPORTED = "이 기기는 지원하지 않음";
export const PUSH_UI_PREPARING = "알림 설정 준비 중";
export const PUSH_UI_IOS_ADD_TO_HOME =
  "VERTHILL을 홈 화면에 추가한 뒤 알림을 설정해 주세요.";

export function resolvePushNotificationSurface(input: {
  configured: boolean;
  standalone: boolean;
  ios: boolean;
  notificationSupported: boolean;
  pushManagerSupported: boolean;
  permission: PushPermission;
  localSubscription: boolean;
}): PushNotificationSurface {
  if (!input.configured) return "preparing";
  if (input.ios && !input.standalone) return "ios-add-to-home";
  if (
    !input.notificationSupported ||
    !input.pushManagerSupported ||
    input.permission === "unsupported"
  ) {
    return "unsupported";
  }
  if (input.permission === "denied") return "blocked";
  if (input.localSubscription && input.permission === "granted") return "on";
  return "off";
}

export function pushSurfaceLabel(surface: PushNotificationSurface): string {
  switch (surface) {
    case "preparing":
      return PUSH_UI_PREPARING;
    case "unsupported":
      return PUSH_UI_UNSUPPORTED;
    case "ios-add-to-home":
      return PUSH_UI_IOS_ADD_TO_HOME;
    case "blocked":
      return PUSH_UI_BLOCKED;
    case "on":
      return PUSH_UI_ON;
    default:
      return PUSH_UI_OFF;
  }
}

export function shouldRequestPermissionOnEnable(surface: PushNotificationSurface): boolean {
  return surface === "off";
}

export function detectIosAndStandalone(input: {
  userAgent: string;
  displayModeStandalone: boolean;
  iosNavigatorStandalone: boolean;
}): { ios: boolean; standalone: boolean } {
  return {
    ios: isIosDevice(input.userAgent),
    standalone: isStandaloneDisplay({
      displayModeStandalone: input.displayModeStandalone,
      iosNavigatorStandalone: input.iosNavigatorStandalone,
    }),
  };
}

/** Client helper: VAPID public key → Uint8Array for PushManager.subscribe. */
export function vapidPublicKeyToBytes(publicKey: string): Uint8Array | null {
  const raw = String(publicKey ?? "").trim();
  if (!raw) return null;
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    if (typeof atob !== "function") {
      const buf = Buffer.from(b64, "base64");
      if (buf.length !== 65 || buf[0] !== 0x04) return null;
      return new Uint8Array(buf);
    }
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (out.length !== 65 || out[0] !== 0x04) return null;
    return out;
  } catch {
    return null;
  }
}
