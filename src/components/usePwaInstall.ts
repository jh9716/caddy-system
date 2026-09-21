"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isAndroidDevice,
  isIosDevice,
  isPwaInstalled,
  isSamsungInternet,
  isStandaloneDisplay,
  resolvePwaInstallAction,
  resolvePwaInstallSurface,
  type PwaInstallAction,
  type PwaInstallSurface,
} from "@/lib/pwaInstall";

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function usePwaInstall() {
  const [standalone, setStandalone] = useState(false);
  const [appInstalled, setAppInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [samsung, setSamsung] = useState(false);
  const [android, setAndroid] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [prompting, setPrompting] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const ua = window.navigator.userAgent;
    setStandalone(
      isStandaloneDisplay({
        displayModeStandalone: media.matches,
        iosNavigatorStandalone: nav.standalone === true,
      })
    );
    setIos(isIosDevice(ua));
    setSamsung(isSamsungInternet(ua));
    setAndroid(isAndroidDevice(ua));

    const onChange = () => {
      const nextNav = window.navigator as Navigator & { standalone?: boolean };
      setStandalone(
        isStandaloneDisplay({
          displayModeStandalone: media.matches,
          iosNavigatorStandalone: nextNav.standalone === true,
        })
      );
    };
    media.addEventListener("change", onChange);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    const onInstalled = () => {
      setDeferred(null);
      setAppInstalled(true);
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const installed = isPwaInstalled({ standalone, appInstalled });

  const surface: PwaInstallSurface = useMemo(
    () =>
      resolvePwaInstallSurface({
        standalone: installed,
        ios,
        samsung,
        android,
        hasBeforeInstallPrompt: deferred != null,
      }),
    [installed, ios, samsung, android, deferred]
  );

  const action: PwaInstallAction = resolvePwaInstallAction(surface);

  const promptInstall = useCallback(async () => {
    if (!deferred || prompting) return;
    setPrompting(true);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") {
        setAppInstalled(true);
      }
    } catch {
      // Fail-soft: existing web UI stays usable without install.
    } finally {
      setDeferred(null);
      setPrompting(false);
    }
  }, [deferred, prompting]);

  return {
    surface,
    action,
    installed,
    standalone,
    prompting,
    canPrompt: deferred != null && !prompting,
    promptInstall,
  };
}
