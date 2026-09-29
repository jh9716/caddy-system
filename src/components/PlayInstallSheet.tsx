"use client";

import {
  PLAY_INSTALL_CLOSE,
  PLAY_INSTALL_CTA_LABEL,
  PLAY_INSTALL_MISSING_URL,
  PLAY_INSTALL_STEPS,
  PLAY_INSTALL_TITLE,
  PLAY_INSTALL_WEBAPP_LABEL,
  readGooglePlayTestUrl,
} from "@/lib/playInstall";

export default function PlayInstallSheet({
  onClose,
  onOpenWebApp,
  showWebAppOption,
}: {
  onClose: () => void;
  onOpenWebApp?: () => void;
  showWebAppOption: boolean;
}) {
  const playUrl = readGooglePlayTestUrl(
    process.env.NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL
  );

  function onPlayClick() {
    if (!playUrl) return;
    window.open(playUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div
      className="vh-install-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="vh-install-sheet vh-play-install-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vh-play-install-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="vh-play-install-title" className="vh-install-sheet-title">
          {PLAY_INSTALL_TITLE}
        </h2>
        <ol className="vh-install-sheet-steps">
          {PLAY_INSTALL_STEPS.map((step, i) => (
            <li key={step}>
              <span className="vh-install-sheet-num">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="vh-play-install-cta"
          onClick={onPlayClick}
          disabled={!playUrl}
        >
          {PLAY_INSTALL_CTA_LABEL}
        </button>
        {!playUrl ? (
          <p className="vh-play-install-missing" role="status">
            {PLAY_INSTALL_MISSING_URL}
          </p>
        ) : null}
        {showWebAppOption && onOpenWebApp ? (
          <button
            type="button"
            className="vh-play-install-webapp"
            onClick={onOpenWebApp}
          >
            {PLAY_INSTALL_WEBAPP_LABEL}
          </button>
        ) : null}
        <button type="button" className="vh-install-sheet-close" onClick={onClose}>
          {PLAY_INSTALL_CLOSE}
        </button>
      </div>
    </div>
  );
}
