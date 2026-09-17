import { PWA_SW_SCOPE, PWA_SW_URL } from "@/lib/pwaManifest";
import { shouldRegisterServiceWorker } from "@/lib/pwaInstall";

export type ServiceWorkerRegisterResult =
  | "registered"
  | "skipped"
  | "failed";

/**
 * Fail-soft SW registration. Production HTTPS (secure context) only.
 * Never logs response bodies, tokens, or personal data.
 */
export async function registerVerthillServiceWorker(): Promise<ServiceWorkerRegisterResult> {
  if (typeof window === "undefined") return "skipped";
  if (
    !shouldRegisterServiceWorker({
      hasServiceWorker: "serviceWorker" in navigator,
      isSecureContext: window.isSecureContext,
    })
  ) {
    return "skipped";
  }

  try {
    await navigator.serviceWorker.register(PWA_SW_URL, { scope: PWA_SW_SCOPE });
    return "registered";
  } catch {
    return "failed";
  }
}
