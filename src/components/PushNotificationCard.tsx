"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  PUSH_UI_DISABLE,
  PUSH_UI_DISABLE_HINT,
  PUSH_UI_ENABLE,
  PUSH_UI_TITLE,
  PushNotificationSurface,
  detectIosAndStandalone,
  pushSurfaceLabel,
  resolvePushNotificationSurface,
  vapidPublicKeyToBytes,
  type PushPermission,
} from "@/lib/pushNotificationUi";
import {
  SAME_DEVICE_PREPARE_ERROR,
  SAME_DEVICE_PREPARE_MESSAGE,
} from "@/lib/pushSubscriptionErrors";

type StatusResponse = {
  configured?: boolean;
  vapidPublicKey?: string | null;
  subscriptionExists?: boolean;
  enabled?: boolean;
  error?: string;
  message?: string;
};

function readPermission(): PushPermission {
  if (typeof Notification === "undefined") return "unsupported";
  const p = Notification.permission;
  if (p === "granted" || p === "denied" || p === "default") return p;
  return "unsupported";
}

export default function PushNotificationCard({
  title = PUSH_UI_TITLE,
  enableLabel = PUSH_UI_ENABLE,
  disableLabel = PUSH_UI_DISABLE,
  disableHint = PUSH_UI_DISABLE_HINT,
  statusText,
}: {
  title?: string;
  enableLabel?: string;
  disableLabel?: string;
  disableHint?: string;
  statusText?: (surface: PushNotificationSurface) => string;
} = {}) {
  const [configured, setConfigured] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [permission, setPermission] = useState<PushPermission>("default");
  const [pushManagerSupported, setPushManagerSupported] = useState(false);
  const [notificationSupported, setNotificationSupported] = useState(false);
  const [localSubscription, setLocalSubscription] = useState(false);
  const [serverRegistered, setServerRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshLocal = useCallback(async () => {
    if (typeof window === "undefined") return;
    setNotificationSupported(typeof Notification !== "undefined");
    setPushManagerSupported(
      "serviceWorker" in navigator && "PushManager" in window
    );
    setPermission(readPermission());
    const detected = detectIosAndStandalone({
      userAgent: window.navigator.userAgent,
      displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
      iosNavigatorStandalone:
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    });
    setIos(detected.ios);
    setStandalone(detected.standalone);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setLocalSubscription(false);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setLocalSubscription(!!sub);
    } catch {
      setLocalSubscription(false);
    }
  }, []);

  const refreshServer = useCallback(async () => {
    let endpoint: string | undefined;
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        endpoint = sub?.endpoint || undefined;
      }
    } catch {
      endpoint = undefined;
    }
    const res = await fetch("/api/push/subscription", {
      credentials: "include",
      cache: "no-store",
      headers: endpoint ? { "x-push-endpoint": endpoint } : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as StatusResponse;
    if (res.status === 503 && data.error === "auth_unavailable") {
      setConfigured(false);
      setPublicKey(null);
      setServerRegistered(false);
      return;
    }
    if (res.status === 403) {
      setConfigured(false);
      setPublicKey(null);
      setServerRegistered(false);
      setError(typeof data.message === "string" ? data.message : "관리자 계정을 찾을 수 없습니다.");
      return;
    }
    setConfigured(data.configured === true);
    setPublicKey(typeof data.vapidPublicKey === "string" ? data.vapidPublicKey : null);
    setServerRegistered(data.subscriptionExists === true);
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshLocal();
      await refreshServer();
    })();
  }, [refreshLocal, refreshServer]);

  const surface: PushNotificationSurface = useMemo(
    () =>
      resolvePushNotificationSurface({
        configured,
        standalone,
        ios,
        notificationSupported,
        pushManagerSupported,
        permission,
        localSubscription,
        serverRegistered,
      }),
    [
      configured,
      standalone,
      ios,
      notificationSupported,
      pushManagerSupported,
      permission,
      localSubscription,
      serverRegistered,
    ]
  );

  async function onEnable() {
    if (busy || surface !== "off") return;
    setBusy(true);
    setError("");
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
      await refreshLocal();
      if (readPermission() !== "granted") {
        setPermission(readPermission());
        return;
      }
      if (!publicKey) {
        setError("알림 설정 준비 중");
        return;
      }
      const keyBytes = vapidPublicKeyToBytes(publicKey);
      if (!keyBytes) {
        setError("알림 설정 준비 중");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes,
        }));
      const createdNew = !existing;
      const json = sub.toJSON();
      const res = await fetch("/api/push/subscription", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          userAgent: navigator.userAgent,
          platform: ios ? "ios" : /Android/i.test(navigator.userAgent) ? "android" : "desktop",
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as StatusResponse;
        if (res.status !== 409 && createdNew) {
          try {
            await sub.unsubscribe();
          } catch {
            // keep local/server consistent on failed first register
          }
        }
        setError(
          res.status === 409 || errBody.error === SAME_DEVICE_PREPARE_ERROR
            ? typeof errBody.message === "string" && errBody.message
              ? errBody.message
              : SAME_DEVICE_PREPARE_MESSAGE
            : "알림을 등록하지 못했습니다."
        );
        await refreshLocal();
        await refreshServer();
        return;
      }
      await refreshLocal();
      await refreshServer();
    } catch {
      setError("알림을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let endpoint: string | null = null;
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        endpoint = sub?.endpoint ?? null;
      }
      if (endpoint) {
        const res = await fetch("/api/push/subscription", {
          method: "DELETE",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
        if (!res.ok && res.status !== 404) {
          setError("알림을 해제하지 못했습니다.");
          await refreshLocal();
          await refreshServer();
          return;
        }
      }
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
        }
      }
      await refreshLocal();
      await refreshServer();
    } catch {
      setError("알림을 해제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const showEnable = surface === "off";
  const showDisable = surface === "on";

  const status = statusText ? statusText(surface) : pushSurfaceLabel(surface);

  return (
    <section aria-label={title} style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#163028" }}>{title}</div>
      {status ? (
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4d5a52" }}>{status}</p>
      ) : (
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4d5a52" }}>
          {pushSurfaceLabel(surface)}
        </p>
      )}
      {showEnable && (
        <button
          type="button"
          onClick={() => void onEnable()}
          disabled={busy}
          style={buttonStyle}
        >
          {enableLabel}
        </button>
      )}
      {showDisable && (
        <>
          <button
            type="button"
            onClick={() => void onDisable()}
            disabled={busy}
            style={secondaryButtonStyle}
          >
            {disableLabel}
          </button>
          {disableHint ? (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "#6b7280" }}>{disableHint}</p>
          ) : null}
        </>
      )}
      {error ? (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9a3412" }}>{error}</p>
      ) : null}
    </section>
  );
}

const cardStyle: CSSProperties = {
  marginTop: 12,
  marginBottom: 8,
  padding: "12px 14px",
  border: "1px solid #e8e1d4",
  borderRadius: 12,
  background: "#fffcf7",
  maxWidth: 420,
};

const buttonStyle: CSSProperties = {
  marginTop: 10,
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid #163028",
  background: "#163028",
  color: "#fffcf7",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#fff",
  color: "#163028",
};
