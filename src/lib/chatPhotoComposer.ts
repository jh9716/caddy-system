import { CHAT_PHOTO_MAX } from "@/lib/chatPhotoConstants";
import type { ChatPhotoDirectResult } from "@/lib/chatPhotoDirectClient";
import {
  applyChatPhotoSendProgress,
  applyPreparedChatPhoto,
  chatPhotoPickRoom,
  instantChatPhotoPicks,
  type ChatPendingPhoto,
  type ChatPhotoSendPhase,
} from "@/lib/chatPhotoPick";
import { usableOptimisticChatPhotos } from "@/lib/chatPhotoOptimistic";

export const CHAT_PHOTO_COMPOSER_MAX_MESSAGE = "사진은 최대 3장까지 첨부할 수 있습니다.";

export type ChatPhotoComposerProgress = {
  key: string;
  phase: ChatPhotoSendPhase;
  progress: number;
  attachmentId?: string;
  error?: string;
  result?: ChatPhotoDirectResult;
};

export function visibleComposerPhotos(items: readonly ChatPendingPhoto[]): ChatPendingPhoto[] {
  const seen = new Set<string>();
  const next: ChatPendingPhoto[] = [];
  for (const item of items) {
    if (!item?.key || seen.has(item.key)) continue;
    seen.add(item.key);
    next.push(item);
  }
  return next;
}

export function composerPhotoListsMatch(
  state: readonly ChatPendingPhoto[],
  ref: readonly ChatPendingPhoto[]
): boolean {
  if (state.length !== ref.length) return false;
  return state.every((row, index) => {
    const other = ref[index];
    return Boolean(other) && other.key === row.key && other.status === row.status;
  });
}

export function leftoverComposerPhotosAfterSend(
  items: readonly ChatPendingPhoto[],
  sentKeys: Iterable<string>
): ChatPendingPhoto[] {
  const sent = new Set(sentKeys);
  return visibleComposerPhotos(items).filter((item) => item.status === "failed" && !sent.has(item.key));
}

export function sentComposerPhotoKeys(items: readonly ChatPendingPhoto[]): string[] {
  return usableOptimisticChatPhotos(items).map((item) => item.key);
}

export function shouldApplyComposerWrite(input: {
  currentGeneration: number;
  writeGeneration: number;
  items: readonly ChatPendingPhoto[];
  key?: string;
}): boolean {
  if (input.writeGeneration !== input.currentGeneration) return false;
  if (input.key && !input.items.some((row) => row.key === input.key)) return false;
  return true;
}

export function appendComposerPhotos(
  current: readonly ChatPendingPhoto[],
  incoming: readonly ChatPendingPhoto[],
  max = CHAT_PHOTO_MAX
): { items: ChatPendingPhoto[]; accepted: ChatPendingPhoto[]; rejected: ChatPendingPhoto[] } {
  const items = visibleComposerPhotos(current);
  const seen = new Set(items.map((row) => row.fileId));
  const accepted: ChatPendingPhoto[] = [];
  const rejected: ChatPendingPhoto[] = [];
  for (const item of incoming) {
    if (items.length >= max || seen.has(item.fileId) || items.some((row) => row.key === item.key)) {
      rejected.push(item);
      continue;
    }
    seen.add(item.fileId);
    items.push(item);
    accepted.push(item);
  }
  return { items, accepted, rejected };
}

export function commitComposerPhotoPicks(
  current: readonly ChatPendingPhoto[],
  files: File[],
  max = CHAT_PHOTO_MAX
): {
  items: ChatPendingPhoto[];
  accepted: ChatPendingPhoto[];
  rejected: ChatPendingPhoto[];
  sources: File[];
  note: string;
  overflow: boolean;
} {
  const visible = visibleComposerPhotos(current);
  const room = chatPhotoPickRoom(visible.length, max);
  if (room <= 0) {
    return {
      items: visible,
      accepted: [],
      rejected: [],
      sources: [],
      note: CHAT_PHOTO_COMPOSER_MAX_MESSAGE,
      overflow: true,
    };
  }
  const picked = instantChatPhotoPicks(files, room, {
    fileIds: visible.map((item) => item.fileId),
  });
  const appended = appendComposerPhotos(visible, picked.items, max);
  return {
    ...appended,
    sources: picked.sources.filter((_, index) =>
      appended.accepted.some((item) => item.key === picked.items[index]?.key)
    ),
    note: appended.accepted.length === 0 && visible.length >= max
      ? CHAT_PHOTO_COMPOSER_MAX_MESSAGE
      : picked.note,
    overflow: room <= 0 || visible.length + appended.accepted.length > max,
  };
}

export function applyComposerPreparedIfCurrent(
  items: ChatPendingPhoto[],
  prepared: ChatPendingPhoto,
  currentGeneration: number,
  writeGeneration: number
): { items: ChatPendingPhoto[]; note: string } {
  if (!shouldApplyComposerWrite({ currentGeneration, writeGeneration, items, key: prepared.key })) {
    return { items, note: "" };
  }
  return applyPreparedChatPhoto(items, prepared);
}

export function applyComposerProgressIfCurrent(
  items: ChatPendingPhoto[],
  progress: ChatPhotoComposerProgress,
  currentGeneration: number,
  writeGeneration: number
): ChatPendingPhoto[] {
  if (!shouldApplyComposerWrite({ currentGeneration, writeGeneration, items, key: progress.key })) {
    return items;
  }
  return applyChatPhotoSendProgress(items, progress);
}

export type ChatPhotoComposerSession = {
  generation: number;
  items: ChatPendingPhoto[];
  replace(next: ChatPendingPhoto[]): ChatPendingPhoto[];
  beginSend(): { generation: number; items: ChatPendingPhoto[]; sent: ChatPendingPhoto[] };
  abandon(): { generation: number; items: ChatPendingPhoto[] };
  canWrite(writeGeneration: number, key?: string): boolean;
};

export function createChatPhotoComposerSession(
  initial: ChatPendingPhoto[] = []
): ChatPhotoComposerSession {
  let generation = 0;
  let items = visibleComposerPhotos(initial);
  return {
    get generation() {
      return generation;
    },
    get items() {
      return items;
    },
    replace(next) {
      items = visibleComposerPhotos(next);
      return items;
    },
    beginSend() {
      const sent = usableOptimisticChatPhotos(items);
      generation += 1;
      items = leftoverComposerPhotosAfterSend(items, sent.map((item) => item.key));
      return { generation, items, sent };
    },
    abandon() {
      generation += 1;
      items = [];
      return { generation, items };
    },
    canWrite(writeGeneration, key) {
      return shouldApplyComposerWrite({
        currentGeneration: generation,
        writeGeneration,
        items,
        key,
      });
    },
  };
}
