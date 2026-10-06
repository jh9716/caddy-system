/**
 * Dev/test-only chat photo timing. Production analytics are forbidden.
 * Tests can set globalThis.__CHAT_PHOTO_TIMING__ = { marks: [] }.
 */

export type ChatPhotoTimingMark = {
  name: string;
  ms: number;
};

export type ChatPhotoTimingBag = {
  marks: ChatPhotoTimingMark[];
};

declare global {
  // eslint-disable-next-line no-var
  var __CHAT_PHOTO_TIMING__: ChatPhotoTimingBag | undefined;
}

export function chatPhotoNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function isChatPhotoTimingEnabled(): boolean {
  if (typeof globalThis !== "undefined" && globalThis.__CHAT_PHOTO_TIMING__) return true;
  return typeof process !== "undefined" && process.env.NODE_ENV !== "production";
}

export function markChatPhotoTiming(name: string, startedAt: number): number {
  const ms = Math.max(0, chatPhotoNow() - startedAt);
  if (!isChatPhotoTimingEnabled()) return ms;
  const bag = (globalThis.__CHAT_PHOTO_TIMING__ ||= { marks: [] });
  bag.marks.push({ name, ms });
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(`[chat-photo] ${name} ${Math.round(ms)}ms`);
  }
  return ms;
}

export function resetChatPhotoTiming(): void {
  if (globalThis.__CHAT_PHOTO_TIMING__) {
    globalThis.__CHAT_PHOTO_TIMING__.marks = [];
  }
}
