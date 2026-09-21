"use client";

import {
  PWA_INSTALL_CTA_LABEL,
  PWA_INSTALL_SHEET_CLOSE,
  pwaInstallHintSteps,
  type PwaInstallSurface,
} from "@/lib/pwaInstall";

export default function PwaInstallHintSheet({
  surface,
  onClose,
}: {
  surface: PwaInstallSurface;
  onClose: () => void;
}) {
  const steps = pwaInstallHintSteps(surface);
  if (steps.length === 0) return null;

  return (
    <div
      className="vh-install-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="vh-install-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vh-install-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="vh-install-sheet-title" className="vh-install-sheet-title">
          {PWA_INSTALL_CTA_LABEL}
        </h2>
        <ol className="vh-install-sheet-steps">
          {steps.map((step, i) => (
            <li key={step}>
              <span className="vh-install-sheet-num">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="vh-install-sheet-close" onClick={onClose}>
          {PWA_INSTALL_SHEET_CLOSE}
        </button>
      </div>
    </div>
  );
}
