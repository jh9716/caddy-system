/**
 * Capacitor PushNotifications bridge. Token stays in memory only.
 * Never logs, never persists to web storage, never renders the token.
 */
import { PushNotifications } from "@capacitor/push-notifications";
import { readCapacitorNativePlatform } from "@/lib/nativePlatformClient";
import { assignNativePushPath, resolveNativePushOpenPath } from "@/lib/nativePushDeepLink";
import {
  NATIVE_PUSH_TOKEN_PATH,
  nativeTokenDisableInit,
} from "@/lib/nativePushHttp";
import type { NativePushPermission } from "@/lib/nativePushUi";

export {
  NATIVE_PUSH_TOKEN_PATH,
  nativeTokenDisableInit,
  nativeTokenRequestInit,
  nativeTokenStatusHeaders,
} from "@/lib/nativePushHttp";

let memoryToken: string | null = null;
let listenersBound = false;

const TOKEN_WAIT_MS = 1500;
const TOKEN_POLL_MS = 50;

export function readMemoryNativePushToken(): string | null {
  return memoryToken;
}

export function clearMemoryNativePushToken(): void {
  memoryToken = null;
}

export function rememberNativePushToken(token: string): void {
  const next = String(token ?? "").trim();
  memoryToken = next || null;
}

export async function nativePushPluginAvailable(): Promise<boolean> {
  if (!readCapacitorNativePlatform()) return false;
  return typeof PushNotifications?.requestPermissions === "function";
}

export async function readNativePushPermission(): Promise<NativePushPermission> {
  if (!(await nativePushPluginAvailable())) return "unknown";
  const status = await PushNotifications.checkPermissions();
  if (status.receive === "granted") return "granted";
  if (status.receive === "denied") return "denied";
  if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
    return "prompt";
  }
  return "unknown";
}

export async function deactivateNativePushOnLogout(
  scope: "current" | "all" = "current"
): Promise<void> {
  if (!readCapacitorNativePlatform()) return;
  const token = memoryToken;
  if (scope === "current" && !token) return;
  try {
    await fetch(NATIVE_PUSH_TOKEN_PATH, nativeTokenDisableInit(token, scope));
  } catch {
    // fail-soft: session clear still proceeds
  } finally {
    if (scope === "all" || token) clearMemoryNativePushToken();
  }
}

export async function bindNativePushListeners(input?: {
  assign?: (href: string) => void;
}): Promise<void> {
  if (listenersBound) return;
  if (!(await nativePushPluginAvailable())) return;
  listenersBound = true;
  const assign = input?.assign ?? ((href: string) => {
    if (typeof window !== "undefined") window.location.assign(href);
  });

  try {
    await PushNotifications.createChannel({
      id: "verthill",
      name: "VERTHILL",
      importance: 4,
      visibility: 1,
    });
  } catch {
    // Channel create is best-effort; register/tap still proceed.
  }

  await PushNotifications.addListener("registration", (event) => {
    rememberNativePushToken(event.value);
  });
  await PushNotifications.addListener("registrationError", () => {
    // no token / no log
  });
  await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
    const path = resolveNativePushOpenPath(event.notification?.data ?? event.notification);
    assignNativePushPath(path, assign);
  });
}

export async function waitForMemoryNativePushToken(
  timeoutMs = TOKEN_WAIT_MS
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let token = readMemoryNativePushToken();
  while (!token && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_MS));
    token = readMemoryNativePushToken();
  }
  return token;
}

async function requestNativePushToken(): Promise<string | null> {
  await bindNativePushListeners();
  await PushNotifications.register();
  return waitForMemoryNativePushToken();
}

/** Restart restore only. Does not POST / upsert. */
export async function rehydrateNativePushToken(): Promise<{
  permission: NativePushPermission;
  tokenReady: boolean;
}> {
  if (!(await nativePushPluginAvailable())) {
    return { permission: "unknown", tokenReady: false };
  }
  const permission = await readNativePushPermission();
  if (permission !== "granted") {
    return { permission, tokenReady: Boolean(readMemoryNativePushToken()) };
  }
  const token = await requestNativePushToken();
  return { permission: "granted", tokenReady: Boolean(token) };
}

export async function registerNativePushDevice(): Promise<{
  permission: NativePushPermission;
  tokenReady: boolean;
}> {
  if (!(await nativePushPluginAvailable())) {
    return { permission: "unknown", tokenReady: false };
  }
  await bindNativePushListeners();
  const current = await readNativePushPermission();
  if (current === "denied") return { permission: "denied", tokenReady: Boolean(memoryToken) };
  if (current !== "granted") {
    const asked = await PushNotifications.requestPermissions();
    if (asked.receive !== "granted") {
      return {
        permission: asked.receive === "denied" ? "denied" : "prompt",
        tokenReady: Boolean(memoryToken),
      };
    }
  }
  const token = await requestNativePushToken();
  return { permission: "granted", tokenReady: Boolean(token) };
}
