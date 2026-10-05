/**
 * Android system back semantics for the Capacitor WebView.
 * Web / PWA / iOS must not register this handler.
 */

export type AndroidBackAction =
  | "close-drawer"
  | "close-chat-overlay"
  | "leave-chat-room"
  | "history-back"
  | "noop";

export type AndroidBackInput = {
  drawerOpen: boolean;
  chatOverlayOpen?: boolean;
  inChatRoom: boolean;
  pathname: string;
  canGoBack: boolean;
};

export function isAuthHistoryPath(pathname: string): boolean {
  const p = String(pathname ?? "").split(/[?#]/)[0] || "/";
  if (p === "/login" || p.startsWith("/login/")) return true;
  if (p === "/admin/login" || p.startsWith("/admin/login/")) return true;
  return false;
}

export function isChatPath(pathname: string): boolean {
  const p = String(pathname ?? "").split(/[?#]/)[0] || "/";
  return p === "/chat" || p.startsWith("/chat/");
}

export function shouldRegisterAndroidSystemBack(input: {
  isNativePlatform: boolean;
  platform: string;
}): boolean {
  return input.isNativePlatform === true && input.platform === "android";
}

/**
 * Priority:
 * 1. Close the hamburger drawer (local overlay, not history).
 * 2. Close the active chat overlay (action menu → profile → mention → reply → sheet).
 * 3. Leave /chat room view to the list (room is React state, not a URL).
 * 4. history.back() when WebView/App plugin reports a previous screen.
 * 5. No-op on auth screens and at root — no exitApp, no redirect loop.
 */
export function resolveAndroidSystemBack(input: AndroidBackInput): AndroidBackAction {
  if (input.drawerOpen) return "close-drawer";
  if (input.chatOverlayOpen && isChatPath(input.pathname)) return "close-chat-overlay";
  if (input.inChatRoom && isChatPath(input.pathname)) return "leave-chat-room";
  if (isAuthHistoryPath(input.pathname)) return "noop";
  if (input.canGoBack) return "history-back";
  return "noop";
}

export function applyAndroidSystemBack(
  action: AndroidBackAction,
  hooks: {
    closeDrawer?: () => void;
    closeChatOverlay?: () => void;
    leaveChatRoom?: () => void;
    historyBack?: () => void;
  }
): AndroidBackAction {
  if (action === "close-drawer") hooks.closeDrawer?.();
  else if (action === "close-chat-overlay") hooks.closeChatOverlay?.();
  else if (action === "leave-chat-room") hooks.leaveChatRoom?.();
  else if (action === "history-back") hooks.historyBack?.();
  return action;
}

let closeDrawer: (() => void) | null = null;
let closeChatOverlay: (() => void) | null = null;
let leaveChatRoom: (() => void) | null = null;

export function registerAndroidDrawerClose(fn: (() => void) | null): () => void {
  closeDrawer = fn;
  return () => {
    if (closeDrawer === fn) closeDrawer = null;
  };
}

export function registerAndroidChatOverlayClose(fn: (() => void) | null): () => void {
  closeChatOverlay = fn;
  return () => {
    if (closeChatOverlay === fn) closeChatOverlay = null;
  };
}

export function registerAndroidChatRoomLeave(fn: (() => void) | null): () => void {
  leaveChatRoom = fn;
  return () => {
    if (leaveChatRoom === fn) leaveChatRoom = null;
  };
}

export function peekAndroidBackOverlays(): {
  drawerOpen: boolean;
  chatOverlayOpen: boolean;
  inChatRoom: boolean;
  closeDrawer: (() => void) | null;
  closeChatOverlay: (() => void) | null;
  leaveChatRoom: (() => void) | null;
} {
  return {
    drawerOpen: closeDrawer != null,
    chatOverlayOpen: closeChatOverlay != null,
    inChatRoom: leaveChatRoom != null,
    closeDrawer,
    closeChatOverlay,
    leaveChatRoom,
  };
}

export function resetAndroidBackOverlaysForTests(): void {
  closeDrawer = null;
  closeChatOverlay = null;
  leaveChatRoom = null;
}
