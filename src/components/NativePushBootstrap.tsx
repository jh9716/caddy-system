"use client";

import { useEffect } from "react";
import {
  bindNativePushListeners,
  rebindNativePushTokenOnSession,
} from "@/lib/nativePushBridge";

/** Tap routing + one session rebind of an already-granted OS token. */
export default function NativePushBootstrap() {
  useEffect(() => {
    void bindNativePushListeners();
    void rebindNativePushTokenOnSession();
  }, []);
  return null;
}
