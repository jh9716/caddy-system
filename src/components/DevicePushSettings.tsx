"use client";

import { useEffect, useState } from "react";
import NativePushNotificationCard from "@/components/NativePushNotificationCard";
import PushNotificationCard from "@/components/PushNotificationCard";
import { readCapacitorNativePlatform } from "@/lib/nativePlatformClient";
import { shouldUseNativePushUi } from "@/lib/nativePlatform";
import type { PushNotificationSurface } from "@/lib/pushNotificationUi";

export default function DevicePushSettings({
  title,
  enableLabel,
  disableLabel,
  disableHint,
  statusText,
}: {
  title?: string;
  enableLabel?: string;
  disableLabel?: string;
  disableHint?: string;
  statusText?: (surface: PushNotificationSurface) => string;
} = {}) {
  const [ready, setReady] = useState(false);
  const [native, setNative] = useState(false);

  useEffect(() => {
    try {
      setNative(
        shouldUseNativePushUi({ isNativePlatform: readCapacitorNativePlatform() })
      );
    } catch {
      setNative(false);
    } finally {
      setReady(true);
    }
  }, []);

  // Wait for official Capacitor check so native never paints Web Push unsupported copy.
  if (!ready) return null;

  if (native) {
    return <NativePushNotificationCard title={title} />;
  }
  return (
    <PushNotificationCard
      title={title}
      enableLabel={enableLabel}
      disableLabel={disableLabel}
      disableHint={disableHint}
      statusText={statusText}
    />
  );
}
