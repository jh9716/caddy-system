"use client";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect } from "react";
import {
  applyAndroidSystemBack,
  peekAndroidBackOverlays,
  resolveAndroidSystemBack,
  shouldRegisterAndroidSystemBack,
} from "@/lib/androidSystemBack";
import { readCapacitorNativePlatform } from "@/lib/nativePlatformClient";

/** Android Capacitor hardware/gesture back only. No-op on web / iOS. */
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
    const handle = App.addListener("backButton", (event) => {
      const overlays = peekAndroidBackOverlays();
      const pathname =
        typeof window !== "undefined" ? window.location.pathname || "/" : "/";
      applyAndroidSystemBack(
        resolveAndroidSystemBack({
          drawerOpen: overlays.drawerOpen,
          inChatRoom: overlays.inChatRoom,
          pathname,
          canGoBack: event.canGoBack === true,
        }),
        {
          closeDrawer: () => overlays.closeDrawer?.(),
          leaveChatRoom: () => overlays.leaveChatRoom?.(),
          historyBack: () => {
            if (typeof window !== "undefined") window.history.back();
          },
        }
      );
    });

    void handle.then((listener) => {
      if (removed) void listener.remove();
    });

    return () => {
      removed = true;
      void handle.then((listener) => listener.remove());
    };
  }, []);

  return null;
}
