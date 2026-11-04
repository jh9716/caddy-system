"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PUSH_OPEN_MESSAGE_TYPE, openPushPathInApp } from "@/lib/chatFastEntry";
import {
  bindNativePushListeners,
  rebindNativePushTokenOnSession,
  setNativePushInAppAssign,
} from "@/lib/nativePushBridge";

/** Tap routing + one session rebind of an already-granted OS token. */
export default function NativePushBootstrap() {
  const router = useRouter();
  useEffect(() => {
    setNativePushInAppAssign((href) => openPushPathInApp(href, (path) => router.push(path)));
    return () => setNativePushInAppAssign(null);
  }, [router]);
  useEffect(() => {
    void bindNativePushListeners();
    void rebindNativePushTokenOnSession();
  }, []);
  useEffect(() => {
    // 웹 푸시: sw.js 가 열린 창에 경로 이동을 요청하면 새로고침 없이 이동하고 ack.
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; path?: string } | null;
      if (!data || data.type !== PUSH_OPEN_MESSAGE_TYPE) return;
      const ok = openPushPathInApp(data.path, (path) => router.push(path));
      try {
        ev.ports?.[0]?.postMessage({ ok });
      } catch {
        // sw falls back after timeout
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
  return null;
}
