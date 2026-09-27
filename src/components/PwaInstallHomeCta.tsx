"use client";

import { useState } from "react";
import {
  PWA_INSTALL_CTA_LABEL,
  shouldShowHomeInstallCta,
} from "@/lib/pwaInstall";
import {
  resolveHomeInstallPrimary,
  shouldOfferWebAppInstall,
} from "@/lib/playInstall";
import PlayInstallSheet from "@/components/PlayInstallSheet";
import PwaInstallHintSheet from "@/components/PwaInstallHintSheet";
import { usePwaInstall } from "@/components/usePwaInstall";

export default function PwaInstallHomeCta() {
  const { surface, action, installed, prompting, promptInstall, isNativePlatform } =
    usePwaInstall();
  const [playOpen, setPlayOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!shouldShowHomeInstallCta({ surface, installed, isNativePlatform })) return null;

  const primary = resolveHomeInstallPrimary(surface);

  function onClick() {
    if (primary === "pwa-sheet") {
      setSheetOpen(true);
      return;
    }
    if (primary === "play") {
      setPlayOpen(true);
    }
  }

  async function onOpenWebApp() {
    if (action === "prompt") {
      await promptInstall();
    }
    if (shouldOfferWebAppInstall(action)) {
      setPlayOpen(false);
      setSheetOpen(true);
    }
  }

  return (
    <>
      <button
        type="button"
        className="vh-home-install"
        onClick={onClick}
        disabled={prompting}
      >
        {PWA_INSTALL_CTA_LABEL}
      </button>
      {playOpen && primary === "play" ? (
        <PlayInstallSheet
          onClose={() => setPlayOpen(false)}
          onOpenWebApp={() => void onOpenWebApp()}
          showWebAppOption={shouldOfferWebAppInstall(action)}
        />
      ) : null}
      {sheetOpen && shouldOfferWebAppInstall(action) ? (
        <PwaInstallHintSheet
          surface={surface}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}
