"use client";

import { useEffect, useState } from "react";
import {
  CHAT_PUSH_ONBOARD_ENABLE,
  CHAT_PUSH_ONBOARD_IOS_HOME,
  CHAT_PUSH_ONBOARD_LATER,
  CHAT_PUSH_ONBOARD_TITLE,
  readChatPushOnboardDismissed,
  resolveChatPushOnboard,
  shouldRequestOsPermissionOnEnable,
  shouldSilentRebindWebPush,
  writeChatPushOnboardDismissed,
} from "@/lib/chatPushOnboarding";
import { nativePushPluginAvailable, readNativePushPermission, registerNativePushDevice } from "@/lib/nativePushBridge";
import { detectIosAndStandalone, vapidPublicKeyToBytes } from "@/lib/pushNotificationUi";

type Me = {
  authenticated: boolean;
  userId: number | null;
  mustChangePassword: boolean;
};

export default function ChatPushOnboarding() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"android" | "pwa" | "ios-safari" | "none">("none");
  const [userId, setUserId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const meRes = await fetch("/api/me", { credentials: "include", cache: "no-store" });
      const meJson = (await meRes.json().catch(() => null)) as {
        authenticated?: boolean;
        user?: { id?: number };
      } | null;
      const me: Me = {
        authenticated: meJson?.authenticated === true,
        userId: Number(meJson?.user?.id || 0) || null,
        mustChangePassword: false,
      };
      if (cancelled || !me.userId) return;
      const nativePlugin = await nativePushPluginAvailable();
      const nativePermission = nativePlugin ? await readNativePushPermission() : null;
      const detected = detectIosAndStandalone({
        userAgent: navigator.userAgent,
        displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
        iosNavigatorStandalone:
          (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
      });
      const permission =
        typeof Notification === "undefined"
          ? "unsupported"
          : (Notification.permission as "default" | "granted" | "denied");
      const dismissed = readChatPushOnboardDismissed(window.localStorage, me.userId);
      const decision = resolveChatPushOnboard({
        authenticated: me.authenticated,
        mustChangePassword: me.mustChangePassword,
        userId: me.userId,
        dismissed,
        nativePlugin,
        nativePermission,
        ios: detected.ios,
        standalone: detected.standalone,
        notificationPermission: permission,
      });
      if (cancelled) return;
      setUserId(me.userId);
      if (
        shouldSilentRebindWebPush({
          authenticated: me.authenticated,
          nativePlugin,
          notificationPermission: permission,
        })
      ) {
        await enableWebPush(false);
      }
      if (decision.kind === "none" || !decision.show) return;
      setKind(decision.kind);
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enableWebPush(requestOsPermission = true) {
    const keyRes = await fetch("/api/push/subscription", {
      credentials: "include",
      cache: "no-store",
    });
    const keyData = (await keyRes.json().catch(() => null)) as { vapidPublicKey?: string } | null;
    const bytes = vapidPublicKeyToBytes(keyData?.vapidPublicKey || "");
    if (!bytes || !("serviceWorker" in navigator)) return;
    if (requestOsPermission) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    } else if (Notification.permission !== "granted") {
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    });
    const json = sub.toJSON();
    await fetch("/api/push/subscription", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        platform: "ios",
        userAgent: navigator.userAgent,
      }),
    });
  }

  async function onEnable() {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === "android") await registerNativePushDevice();
      else if (kind === "pwa") await enableWebPush();
    } finally {
      if (userId) writeChatPushOnboardDismissed(window.localStorage, userId);
      setOpen(false);
      setBusy(false);
    }
  }

  function onLater() {
    if (userId) writeChatPushOnboardDismissed(window.localStorage, userId);
    setOpen(false);
  }

  if (!open || kind === "none") return null;
  const iosHome = kind === "ios-safari";
  return (
    <div className="vh-push-onboard" role="dialog" aria-label="알림 안내">
      <div className="vh-push-onboard-card">
        <h2>{iosHome ? "홈 화면에 추가" : CHAT_PUSH_ONBOARD_TITLE}</h2>
        <p>
          {iosHome
            ? CHAT_PUSH_ONBOARD_IOS_HOME
            : "채팅과 공지 소식을 바로 받아볼 수 있습니다."}
        </p>
        <div className="vh-push-onboard-actions">
          {iosHome ? (
            <button type="button" className="is-primary" onClick={onLater}>
              확인
            </button>
          ) : (
            <>
              <button
                type="button"
                className="is-primary"
                disabled={busy || !shouldRequestOsPermissionOnEnable(kind)}
                onClick={() => void onEnable()}
              >
                {CHAT_PUSH_ONBOARD_ENABLE}
              </button>
              <button type="button" className="is-later" disabled={busy} onClick={onLater}>
                {CHAT_PUSH_ONBOARD_LATER}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
