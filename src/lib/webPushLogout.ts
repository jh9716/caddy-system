/**
 * Fail-soft web PushSubscription cleanup on logout.
 * Current-device only unless scope=all. Does not change send pipelines.
 */
import {
  PUSH_SUBSCRIPTION_PATH,
  webPushLogoutDisableInit,
} from "@/lib/webPushLogoutHttp";

export {
  PUSH_SUBSCRIPTION_PATH,
  webPushLogoutDisableInit,
} from "@/lib/webPushLogoutHttp";

async function readCurrentPushEndpoint(): Promise<string | null> {
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

async function unsubscribeCurrentPushManager(): Promise<void> {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    // fail-soft
  }
}

export async function deactivateWebPushOnLogout(
  scope: "current" | "all" = "current"
): Promise<void> {
  try {
    if (scope === "all") {
      await fetch(PUSH_SUBSCRIPTION_PATH, webPushLogoutDisableInit(null, "all"));
      await unsubscribeCurrentPushManager();
      return;
    }
    const endpoint = await readCurrentPushEndpoint();
    if (!endpoint) return;
    await fetch(
      PUSH_SUBSCRIPTION_PATH,
      webPushLogoutDisableInit(endpoint, "current")
    );
    await unsubscribeCurrentPushManager();
  } catch {
    // fail-soft: session clear still proceeds
  }
}
