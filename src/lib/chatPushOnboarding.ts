import type { NativePushPermission } from "@/lib/nativePushUi";

export const CHAT_PUSH_ONBOARD_TITLE = "채팅과 공지 알림을 받아보세요";
export const CHAT_PUSH_ONBOARD_ENABLE = "알림 켜기";
export const CHAT_PUSH_ONBOARD_LATER = "나중에";
export const CHAT_PUSH_ONBOARD_IOS_HOME =
  "홈 화면에 추가하면 채팅·공지 알림을 받을 수 있습니다";

export type ChatPushOnboardKind = "android" | "pwa" | "ios-safari" | "none";

export type ChatPushOnboardDecision =
  | { kind: "none" }
  | { kind: "android" | "pwa" | "ios-safari"; show: boolean };

export function chatPushOnboardStorageKey(userId: number): string {
  return `vh-push-onboard-v1:${userId}`;
}

export function readChatPushOnboardDismissed(
  storage: { getItem(key: string): string | null } | null,
  userId: number
): boolean {
  if (!storage || !Number.isInteger(userId) || userId <= 0) return false;
  try {
    return storage.getItem(chatPushOnboardStorageKey(userId)) === "dismissed";
  } catch {
    return false;
  }
}

export function writeChatPushOnboardDismissed(
  storage: { setItem(key: string, value: string): void } | null,
  userId: number
): void {
  if (!storage || !Number.isInteger(userId) || userId <= 0) return;
  try {
    storage.setItem(chatPushOnboardStorageKey(userId), "dismissed");
  } catch {
    // ignore
  }
}

export function resolveChatPushOnboard(input: {
  authenticated: boolean;
  mustChangePassword: boolean;
  userId: number | null;
  dismissed: boolean;
  nativePlugin: boolean;
  nativePermission: NativePushPermission | null;
  ios: boolean;
  standalone: boolean;
  notificationPermission: "default" | "granted" | "denied" | "unsupported";
}): ChatPushOnboardDecision {
  if (!input.authenticated || input.mustChangePassword) return { kind: "none" };
  if (!Number.isInteger(input.userId) || (input.userId ?? 0) <= 0) return { kind: "none" };
  if (input.nativePlugin) {
    if (input.nativePermission === "granted" || input.nativePermission === "denied") {
      return { kind: "android", show: false };
    }
    return { kind: "android", show: !input.dismissed };
  }
  if (input.ios && !input.standalone) {
    return { kind: "ios-safari", show: !input.dismissed };
  }
  if (input.standalone) {
    if (
      input.notificationPermission === "granted" ||
      input.notificationPermission === "denied" ||
      input.notificationPermission === "unsupported"
    ) {
      return { kind: "pwa", show: false };
    }
    return { kind: "pwa", show: !input.dismissed };
  }
  return { kind: "none" };
}

export function shouldRequestOsPermissionOnEnable(kind: ChatPushOnboardKind): boolean {
  return kind === "android" || kind === "pwa";
}

export function shouldSilentRebindWebPush(input: {
  authenticated: boolean;
  nativePlugin: boolean;
  notificationPermission: "default" | "granted" | "denied" | "unsupported";
}): boolean {
  return (
    input.authenticated === true &&
    input.nativePlugin === false &&
    input.notificationPermission === "granted"
  );
}
