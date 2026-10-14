import { requestChatSessionReset } from "@/lib/chatSessionReset";
import { clearClientResourceCache } from "@/lib/clientResourceCache";
import { deactivateNativePushOnLogout } from "@/lib/nativePushBridge";
import { deactivateWebPushOnLogout } from "@/lib/webPushLogout";

/** Current device: native token + this browser web push, then cookie logout. */
export async function logoutCurrentDevice(): Promise<void> {
  requestChatSessionReset("logout");
  clearClientResourceCache();
  await deactivateNativePushOnLogout("current");
  await deactivateWebPushOnLogout("current");
  await fetch("/api/logout", { method: "POST", credentials: "include" });
}

/** This account on every device, then logout-all. */
export async function logoutAllDevices(): Promise<Response> {
  requestChatSessionReset("logout");
  clearClientResourceCache();
  await deactivateNativePushOnLogout("all");
  await deactivateWebPushOnLogout("all");
  return fetch("/api/auth/logout-all", {
    method: "POST",
    credentials: "include",
  });
}
