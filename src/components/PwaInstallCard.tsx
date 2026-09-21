"use client";

import { useState, type CSSProperties } from "react";
import {
  PWA_INSTALL_BUTTON,
  PWA_INSTALL_CTA_LABEL,
  PWA_INSTALL_STANDALONE_LABEL,
  PWA_INSTALL_TITLE,
  pwaInstallBody,
} from "@/lib/pwaInstall";
import PwaInstallHintSheet from "@/components/PwaInstallHintSheet";
import { usePwaInstall } from "@/components/usePwaInstall";

export default function PwaInstallCard() {
  const { surface, action, installed, prompting, promptInstall } =
    usePwaInstall();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (surface === "hidden") return null;

  if (installed || surface === "standalone") {
    return (
      <section aria-label={PWA_INSTALL_STANDALONE_LABEL} style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#163028" }}>
          {PWA_INSTALL_STANDALONE_LABEL}
        </div>
      </section>
    );
  }

  async function onPrimaryClick() {
    if (action === "prompt") {
      await promptInstall();
      return;
    }
    if (action === "sheet") {
      setSheetOpen(true);
    }
  }

  return (
    <section aria-label={PWA_INSTALL_TITLE} style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#163028" }}>
        {PWA_INSTALL_TITLE}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4d5a52" }}>
        {pwaInstallBody(surface)}
      </p>
      {action !== "hide" && (
        <button
          type="button"
          onClick={() => void onPrimaryClick()}
          disabled={prompting}
          style={buttonStyle}
        >
          {action === "prompt" ? PWA_INSTALL_BUTTON : PWA_INSTALL_CTA_LABEL}
        </button>
      )}
      {sheetOpen && action === "sheet" ? (
        <PwaInstallHintSheet
          surface={surface}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
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
