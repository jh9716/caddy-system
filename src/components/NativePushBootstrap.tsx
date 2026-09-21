"use client";

import { useEffect } from "react";
import { bindNativePushListeners } from "@/lib/nativePushBridge";

/** Foreground / background / cold-start tap → same-origin path. */
export default function NativePushBootstrap() {
  useEffect(() => {
    void bindNativePushListeners();
  }, []);
  return null;
}
