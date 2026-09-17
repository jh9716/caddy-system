"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  PWA_INSTALL_ANDROID_BODY,
  PWA_INSTALL_BUTTON,
  PWA_INSTALL_IOS_BODY,
  PWA_INSTALL_STANDALONE_LABEL,
  PWA_INSTALL_TITLE,
  isIosDevice,
  isStandaloneDisplay,
  resolvePwaInstallSurface,
} from "@/lib/pwaInstall";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaInstallCard() {
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [prompting, setPrompting] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const nav = window.navigator as Navigator & { standalone?: boolean };
    setStandalone(
      isStandaloneDisplay({
        displayModeStandalone: media.matches,
        iosNavigatorStandalone: nav.standalone === true,
      })
    );
    setIos(isIosDevice(window.navigator.userAgent));

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
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const surface = useMemo(
    () =>
      resolvePwaInstallSurface({
        standalone,
        ios,
        hasBeforeInstallPrompt: deferred != null,
      }),
    [standalone, ios, deferred]
  );

  async function onInstallClick() {
    if (!deferred || prompting) return;
    setPrompting(true);
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      // Fail-soft: existing web UI stays usable without install.
    } finally {
      setDeferred(null);
      setPrompting(false);
    }
  }

  if (surface === "hidden") return null;

  if (surface === "standalone") {
    return (
      <section
        aria-label={PWA_INSTALL_STANDALONE_LABEL}
        style={cardStyle}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "#163028" }}>
          {PWA_INSTALL_STANDALONE_LABEL}
        </div>
      </section>
    );
  }

  return (
    <section aria-label={PWA_INSTALL_TITLE} style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#163028" }}>
        {PWA_INSTALL_TITLE}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4d5a52" }}>
        {surface === "ios-hint" ? PWA_INSTALL_IOS_BODY : PWA_INSTALL_ANDROID_BODY}
      </p>
      {surface === "android-prompt" && (
        <button
          type="button"
          onClick={() => void onInstallClick()}
          disabled={prompting}
          style={buttonStyle}
        >
          {PWA_INSTALL_BUTTON}
        </button>
      )}
    </section>
  );
}

const cardStyle: CSSProperties = {
  marginTop: 16,
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
