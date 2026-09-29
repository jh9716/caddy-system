/**
 * Session rebind for an already-granted OS FCM token.
 * Login / account-switch only. Never requests notification permission.
 * Restart restore stays in restoreNativePushUiState (GET only, no POST).
 */
import type { NativePushPermission } from "@/lib/nativePushUi";

export type NativePushRebindStatus =
  | "registered"
  | "unregistered"
  | "unauthorized"
  | "error";

export function shouldRebindNativePushToken(input: {
  pluginAvailable: boolean;
  permission: NativePushPermission;
  token: string | null;
  serverRegistered: boolean;
  alreadyReboundToken: string | null;
}): boolean {
  if (!input.pluginAvailable) return false;
  if (input.permission !== "granted") return false;
  const token = String(input.token ?? "").trim();
  if (!token) return false;
  if (input.serverRegistered) return false;
  if (input.alreadyReboundToken === token) return false;
  return true;
}

export async function runNativePushSessionRebind(input: {
  pluginAvailable: boolean;
  permission: NativePushPermission;
  token: string | null;
  alreadyReboundToken: string | null;
  getRegistered: (token: string) => Promise<NativePushRebindStatus>;
  postToken: (token: string) => Promise<boolean>;
}): Promise<{ posted: boolean; boundToken: string | null }> {
  const token = String(input.token ?? "").trim() || null;
  if (
    !shouldRebindNativePushToken({
      pluginAvailable: input.pluginAvailable,
      permission: input.permission,
      token,
      serverRegistered: false,
      alreadyReboundToken: input.alreadyReboundToken,
    })
  ) {
    return { posted: false, boundToken: input.alreadyReboundToken };
  }

  const status = await input.getRegistered(token as string);
  if (status === "registered") {
    return { posted: false, boundToken: token };
  }
  if (status !== "unregistered") {
    return { posted: false, boundToken: input.alreadyReboundToken };
  }
  if (
    !shouldRebindNativePushToken({
      pluginAvailable: input.pluginAvailable,
      permission: input.permission,
      token,
      serverRegistered: false,
      alreadyReboundToken: input.alreadyReboundToken,
    })
  ) {
    return { posted: false, boundToken: input.alreadyReboundToken };
  }

  const ok = await input.postToken(token as string);
  return { posted: ok, boundToken: ok ? token : input.alreadyReboundToken };
}
