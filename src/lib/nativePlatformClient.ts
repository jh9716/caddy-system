"use client";

import { Capacitor } from "@capacitor/core";
import { isCapacitorNativePlatform } from "@/lib/nativePlatform";

/** Official Capacitor runtime check. False on web / PWA / SSR. */
export function readCapacitorNativePlatform(): boolean {
  try {
    return isCapacitorNativePlatform({
      isNativePlatform: Capacitor.isNativePlatform() === true,
    });
  } catch {
    return false;
  }
}
