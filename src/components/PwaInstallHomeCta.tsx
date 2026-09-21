"use client";

import { useState } from "react";
import {
  PWA_INSTALL_CTA_LABEL,
  shouldShowHomeInstallCta,
} from "@/lib/pwaInstall";
import PwaInstallHintSheet from "@/components/PwaInstallHintSheet";
import { usePwaInstall } from "@/components/usePwaInstall";

export default function PwaInstallHomeCta() {
  const { surface, action, installed, prompting, promptInstall } =
    usePwaInstall();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!shouldShowHomeInstallCta({ surface, installed })) return null;

  async function onClick() {
    if (action === "prompt") {
      await promptInstall();
      return;
    }
    if (action === "sheet") {
      setSheetOpen(true);
    }
  }

  return (
    <>
      <button
        type="button"
        className="vh-home-install"
        onClick={() => void onClick()}
        disabled={prompting}
      >
        {PWA_INSTALL_CTA_LABEL}
      </button>
      {sheetOpen && action === "sheet" ? (
        <PwaInstallHintSheet
          surface={surface}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}
