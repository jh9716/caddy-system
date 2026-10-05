"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect } from "react";
import {
  applyAndroidSystemBack,
  peekAndroidBackOverlays,
  resolveAndroidSystemBack,
  shouldRegisterAndroidSystemBack,
} from "@/lib/androidSystemBack";
import { readCapacitorNativePlatform } from "@/lib/nativePlatformClient";

/** Android Capacitor hardware/gesture back only. No-op on web / iOS / SSR. */
export default function AndroidSystemBackBootstrap() {
  useEffect(() => {
    if (
      !shouldRegisterAndroidSystemBack({
        isNativePlatform: readCapacitorNativePlatform(),
        platform: Capacitor.getPlatform(),
      })
    ) {
      return;
    }

    let removed = false;
    let handlePromise: Promise<{ remove: () => Promise<void> }> | undefined;

    // Dynamic import keeps @capacitor/app out of the Next server/web graph.
    void import("@capacitor/app").then(({ App }) => {
      if (removed) return;
      handlePromise = App.addListener("backButton", (event) => {
        const overlays = peekAndroidBackOverlays();
        const pathname =
          typeof window !== "undefined" ? window.location.pathname || "/" : "/";
        applyAndroidSystemBack(
          resolveAndroidSystemBack({
            drawerOpen: overlays.drawerOpen,
            chatOverlayOpen: overlays.chatOverlayOpen,
            inChatRoom: overlays.inChatRoom,
            pathname,
            canGoBack: event.canGoBack === true,
          }),
          {
            closeDrawer: () => overlays.closeDrawer?.(),
            closeChatOverlay: () => overlays.closeChatOverlay?.(),
            leaveChatRoom: () => overlays.leaveChatRoom?.(),
            historyBack: () => {
              if (typeof window !== "undefined") window.history.back();
            },
          }
        );
      });
      void handlePromise.then((listener) => {
        if (removed) void listener.remove();
      });
    });

    return () => {
      removed = true;
      void handlePromise?.then((listener) => listener.remove());
    };
  }, []);

  return null;
}
