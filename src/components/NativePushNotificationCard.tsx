"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  nativeTokenDisableInit,
  nativeTokenRequestInit,
  nativeTokenStatusHeaders,
  nativePushPluginAvailable,
  NATIVE_PUSH_TOKEN_PATH,
  readMemoryNativePushToken,
  registerNativePushDevice,
  readNativePushPermission,
} from "@/lib/nativePushBridge";
import {
  NATIVE_PUSH_UI_DISABLE,
  NATIVE_PUSH_UI_ENABLE,
  NATIVE_PUSH_UI_TITLE,
  nativePushSurfaceLabel,
  resolveNativePushSurface,
  type NativePushPermission,
  type NativePushSurface,
} from "@/lib/nativePushUi";

type StatusResponse = {
  configured?: boolean;
  registered?: boolean;
  enabled?: boolean;
  error?: string;
  message?: string;
};

export default function NativePushNotificationCard({
  title = NATIVE_PUSH_UI_TITLE,
}: {
  title?: string;
} = {}) {
  const [pluginAvailable, setPluginAvailable] = useState(false);
  const [permission, setPermission] = useState<NativePushPermission>("unknown");
  const [tokenReady, setTokenReady] = useState(false);
  const [serverRegistered, setServerRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const available = await nativePushPluginAvailable();
    setPluginAvailable(available);
    if (!available) {
      setPermission("unknown");
      setTokenReady(false);
      setServerRegistered(false);
      return;
    }
    const perm = await readNativePushPermission();
    setPermission(perm);
    const token = readMemoryNativePushToken();
    setTokenReady(Boolean(token));
    if (!token) {
      setServerRegistered(false);
      return;
    }
    const res = await fetch(NATIVE_PUSH_TOKEN_PATH, {
      credentials: "include",
      cache: "no-store",
      headers: nativeTokenStatusHeaders(token),
    });
    const data = (await res.json().catch(() => ({}))) as StatusResponse;
    setServerRegistered(data.registered === true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const surface: NativePushSurface = useMemo(
    () =>
      resolveNativePushSurface({
        pluginAvailable,
        permission,
        serverRegistered,
        tokenReady,
      }),
    [pluginAvailable, permission, serverRegistered, tokenReady]
  );

  async function onEnable() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await registerNativePushDevice();
      setPermission(next.permission);
      let token = readMemoryNativePushToken();
      if (!token && next.permission === "granted") {
        await new Promise((r) => setTimeout(r, 400));
        token = readMemoryNativePushToken();
      }
      setTokenReady(Boolean(token));
      if (next.permission === "denied") return;
      if (!token) {
        setError("알림 설정 준비 중");
        return;
      }
      const res = await fetch(NATIVE_PUSH_TOKEN_PATH, nativeTokenRequestInit(token));
      if (!res.ok) {
        setError("알림을 등록하지 못했습니다.");
        await refresh();
        return;
      }
      await refresh();
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
      const token = readMemoryNativePushToken();
      if (token) {
        const res = await fetch(NATIVE_PUSH_TOKEN_PATH, nativeTokenDisableInit(token));
        if (!res.ok && res.status !== 404) {
          setError("알림을 해제하지 못했습니다.");
        }
      }
      await refresh();
    } catch {
      setError("알림을 해제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const showEnable = surface === "available" || surface === "permission-needed";
  const showDisable = surface === "registered";

  return (
    <section aria-label={title} style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#163028" }}>{title}</div>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4d5a52" }}>
        {nativePushSurfaceLabel(surface)}
      </p>
      {showEnable && (
        <button type="button" onClick={() => void onEnable()} disabled={busy} style={buttonStyle}>
          {NATIVE_PUSH_UI_ENABLE}
        </button>
      )}
      {showDisable && (
        <button
          type="button"
          onClick={() => void onDisable()}
          disabled={busy}
          style={secondaryButtonStyle}
        >
          {NATIVE_PUSH_UI_DISABLE}
        </button>
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
