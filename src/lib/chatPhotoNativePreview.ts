import { CHAT_PHOTO_MAX } from "@/lib/chatPhotoConstants";
import {
  createChatPhotoPreviewUrl,
  nextChatPhotoComposerKey,
  revokeChatPhotoPreviewUrl,
  type ChatPendingPhoto,
} from "@/lib/chatPhotoPick";
import { appendComposerPhotos, visibleComposerPhotos } from "@/lib/chatPhotoComposer";

export const NATIVE_CHAT_PHOTO_PREVIEW_EVENT = "verthill:chat-photo-native-preview";
export const NATIVE_CHAT_PHOTO_HQ_READY_EVENT = "verthill:chat-photo-native-hq-ready";

const NATIVE_PREVIEW_ID_RE = /^nvp-\d+-[a-z0-9]+$/i;
const NATIVE_PREVIEW_FILE_RE = /^(nvp-\d+-[a-z0-9]+)\.jpe?g$/i;
const NATIVE_PREVIEW_CHOOSER_FILE_RE = /^(nvp-\d+-[a-z0-9]+)-preview\.jpe?g$/i;
const NATIVE_PREVIEW_SESSION_RE = /^nvp-(\d+)-[a-z0-9]+$/i;

export type NativeChatPhotoPreviewPayload = {
  previewId: string;
  sessionId?: string;
  mime?: string;
  width?: number;
  height?: number;
  bytes?: number;
  dataUrl: string;
};

export type NativeChatPhotoHqReadyPayload = {
  previewId: string;
  sessionId?: string;
  mime?: string;
  width?: number;
  height?: number;
  bytes?: number;
  dataUrl?: string;
  error?: string;
};

export function isNativePreviewPlaceholder(item: ChatPendingPhoto | undefined | null): boolean {
  return Boolean(item && item.nativePreview === true && item.status === "preparing");
}

export function shouldQueueNativeChatSend(photos: readonly ChatPendingPhoto[]): boolean {
  return photos.some(isNativePreviewPlaceholder);
}

export function parseNativeChatPhotoPreview(
  raw: unknown
): NativeChatPhotoPreviewPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const previewId = typeof row.previewId === "string" ? row.previewId.trim() : "";
  const dataUrl = typeof row.dataUrl === "string" ? row.dataUrl.trim() : "";
  if (!NATIVE_PREVIEW_ID_RE.test(previewId)) return null;
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null;
  if (dataUrl.length > 300_000) return null;
  if (dataUrl.includes("content://") || dataUrl.includes("file://")) return null;
  const sessionFromId = nativeSessionIdFromPreviewId(previewId);
  const sessionId =
    typeof row.sessionId === "string" && row.sessionId.trim()
      ? row.sessionId.trim()
      : sessionFromId || undefined;
  return {
    previewId,
    sessionId,
    mime: "image/jpeg",
    width: typeof row.width === "number" ? row.width : undefined,
    height: typeof row.height === "number" ? row.height : undefined,
    bytes: typeof row.bytes === "number" ? row.bytes : undefined,
    dataUrl,
  };
}

export function nativePreviewIdFromFileName(name: string | undefined | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  const preview = NATIVE_PREVIEW_CHOOSER_FILE_RE.exec(trimmed);
  if (preview) return preview[1];
  const match = NATIVE_PREVIEW_FILE_RE.exec(trimmed);
  return match ? match[1] : null;
}

export function nativePreviewIdFromPreviewFileName(name: string | undefined | null): string | null {
  if (!name) return null;
  const match = NATIVE_PREVIEW_CHOOSER_FILE_RE.exec(name.trim());
  return match ? match[1] : null;
}

export function isNativePreviewChooserFile(file: File): boolean {
  return Boolean(nativePreviewIdFromPreviewFileName(file.name));
}

export function nativeSessionIdFromPreviewId(id: string | undefined | null): string | null {
  if (!id) return null;
  const match = NATIVE_PREVIEW_SESSION_RE.exec(id.trim());
  return match ? match[1] : null;
}

export function isAbandonedNativeHqFile(
  file: File,
  abandonedIds: ReadonlySet<string>,
  abandonedSessions: ReadonlySet<string>
): boolean {
  const previewId = nativePreviewIdFromFileName(file.name);
  if (!previewId) return false;
  if (abandonedIds.has(previewId)) return true;
  const sessionId = nativeSessionIdFromPreviewId(previewId);
  return Boolean(sessionId && abandonedSessions.has(sessionId));
}

export function shouldAcceptNativePreview(
  payload: NativeChatPhotoPreviewPayload,
  abandonedIds: ReadonlySet<string>,
  abandonedSessions: ReadonlySet<string>
): boolean {
  if (abandonedIds.has(payload.previewId)) return false;
  if (payload.sessionId && abandonedSessions.has(payload.sessionId)) return false;
  const sessionFromId = nativeSessionIdFromPreviewId(payload.previewId);
  if (sessionFromId && abandonedSessions.has(sessionFromId)) return false;
  return true;
}

export function parseNativeChatPhotoHqReady(
  raw: unknown
): NativeChatPhotoHqReadyPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const previewId = typeof row.previewId === "string" ? row.previewId.trim() : "";
  if (!NATIVE_PREVIEW_ID_RE.test(previewId)) return null;
  const sessionFromId = nativeSessionIdFromPreviewId(previewId);
  const sessionId =
    typeof row.sessionId === "string" && row.sessionId.trim()
      ? row.sessionId.trim()
      : sessionFromId || undefined;
  const error = typeof row.error === "string" && row.error.trim() ? row.error.trim() : undefined;
  if (error) {
    return { previewId, sessionId, error };
  }
  const dataUrl = typeof row.dataUrl === "string" ? row.dataUrl.trim() : "";
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null;
  if (dataUrl.length > 4_000_000) return null;
  if (dataUrl.includes("content://") || dataUrl.includes("file://")) return null;
  return {
    previewId,
    sessionId,
    mime: "image/jpeg",
    width: typeof row.width === "number" ? row.width : undefined,
    height: typeof row.height === "number" ? row.height : undefined,
    bytes: typeof row.bytes === "number" ? row.bytes : undefined,
    dataUrl,
  };
}

export function fileFromNativeHqDataUrl(
  dataUrl: string,
  previewId: string
): File | null {
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null;
  try {
    const encoded = dataUrl.slice("data:image/jpeg;base64,".length);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length <= 0) return null;
    return new File([bytes], `${previewId}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  }
}

export function createNativePreviewFromChooserFile(
  file: File,
  previewId: string
): ChatPendingPhoto {
  return {
    key: nextChatPhotoComposerKey(previewId),
    blob: new Blob(),
    previewUrl: createChatPhotoPreviewUrl(file),
    fileId: previewId,
    fingerprint: "",
    status: "preparing",
    nativePreview: true,
    nativePreviewId: previewId,
    nativeSessionId: nativeSessionIdFromPreviewId(previewId) || undefined,
    metrics: { sourceBytes: file.size },
  };
}

export function createNativePreviewPhoto(
  payload: NativeChatPhotoPreviewPayload
): ChatPendingPhoto {
  return {
    key: nextChatPhotoComposerKey(payload.previewId),
    blob: new Blob(),
    previewUrl: payload.dataUrl,
    fileId: payload.previewId,
    fingerprint: "",
    status: "preparing",
    nativePreview: true,
    nativePreviewId: payload.previewId,
    nativeSessionId: payload.sessionId,
    metrics: { sourceBytes: payload.bytes || 0 },
  };
}

export function createNativeHqReadyPhoto(file: File, previewId: string): ChatPendingPhoto {
  const fileId = `${file.name}|${file.size}|${file.lastModified}|${file.type}`;
  return {
    key: nextChatPhotoComposerKey(fileId),
    blob: file,
    previewUrl: createChatPhotoPreviewUrl(file),
    fileId,
    fingerprint: "",
    status: "ready",
    nativePreview: false,
    nativePreviewId: previewId,
    nativeSessionId: nativeSessionIdFromPreviewId(previewId) || undefined,
    metrics: { sourceBytes: file.size, uploadBytes: file.size, compressionMs: 0 },
  };
}

export function appendNativePreviewPhoto(
  current: readonly ChatPendingPhoto[],
  payload: NativeChatPhotoPreviewPayload,
  max = CHAT_PHOTO_MAX
): { items: ChatPendingPhoto[]; accepted: ChatPendingPhoto | null } {
  const visible = visibleComposerPhotos(current);
  if (visible.some((row) => row.nativePreviewId === payload.previewId)) {
    return { items: visible, accepted: null };
  }
  const incoming = createNativePreviewPhoto(payload);
  const appended = appendComposerPhotos(visible, [incoming], max);
  return {
    items: appended.items,
    accepted: appended.accepted[0] || null,
  };
}

export function appendNativePreviewChooserFile(
  current: readonly ChatPendingPhoto[],
  file: File,
  previewId: string,
  max = CHAT_PHOTO_MAX
): { items: ChatPendingPhoto[]; accepted: ChatPendingPhoto | null } {
  const visible = visibleComposerPhotos(current);
  if (visible.some((row) => row.nativePreviewId === previewId)) {
    return { items: visible, accepted: null };
  }
  const incoming = createNativePreviewFromChooserFile(file, previewId);
  const appended = appendComposerPhotos(visible, [incoming], max);
  return {
    items: appended.items,
    accepted: appended.accepted[0] || null,
  };
}

export function appendNativeHqReadyPhoto(
  current: readonly ChatPendingPhoto[],
  file: File,
  previewId: string,
  max = CHAT_PHOTO_MAX
): { items: ChatPendingPhoto[]; accepted: ChatPendingPhoto | null } {
  const visible = visibleComposerPhotos(current);
  if (visible.some((row) => row.nativePreviewId === previewId)) {
    return { items: visible, accepted: null };
  }
  const incoming = createNativeHqReadyPhoto(file, previewId);
  const appended = appendComposerPhotos(visible, [incoming], max);
  return {
    items: appended.items,
    accepted: appended.accepted[0] || null,
  };
}

export function applyNativeHqFile(
  current: readonly ChatPendingPhoto[],
  previewId: string,
  file: File
): ChatPendingPhoto[] | null {
  const visible = visibleComposerPhotos(current);
  const index = visible.findIndex(
    (row) => row.nativePreviewId === previewId && row.status === "preparing"
  );
  if (index < 0) return null;
  const previous = visible[index]!;
  const nextPreviewUrl = createChatPhotoPreviewUrl(file);
  const next = visible.slice();
  next[index] = {
    ...previous,
    blob: file,
    previewUrl: nextPreviewUrl,
    fileId: `${file.name}|${file.size}|${file.lastModified}|${file.type}`,
    status: "ready",
    nativePreview: false,
    metrics: {
      sourceBytes: file.size,
      uploadBytes: file.size,
      compressionMs: 0,
    },
  };
  if (nextPreviewUrl !== previous.previewUrl) {
    revokeChatPhotoPreviewUrl(previous.previewUrl);
  }
  return next;
}

export function applyNativeHqFailed(
  current: readonly ChatPendingPhoto[],
  previewId: string,
  error = "사진 처리에 실패했습니다."
): ChatPendingPhoto[] | null {
  const visible = visibleComposerPhotos(current);
  const index = visible.findIndex((row) => row.nativePreviewId === previewId);
  if (index < 0) return null;
  const next = visible.slice();
  next[index] = {
    ...visible[index]!,
    status: "failed",
    error,
  };
  return next;
}

function isHeicLikeFile(file: File): boolean {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    name.endsWith(".heic") ||
    name.endsWith(".heif") ||
    type.includes("heic") ||
    type.includes("heif")
  );
}

export function partitionNativeHqFiles(
  current: readonly ChatPendingPhoto[],
  files: File[]
): {
  matched: Array<{ previewId: string; file: File }>;
  unmatchedNamed: Array<{ previewId: string; file: File }>;
  heicFallbacks: Array<{ previewId: string; file: File }>;
  leftovers: File[];
} {
  const pendingIds = visibleComposerPhotos(current)
    .filter(isNativePreviewPlaceholder)
    .map((row) => row.nativePreviewId)
    .filter((id): id is string => Boolean(id));
  const pendingSet = new Set(pendingIds);
  const matched: Array<{ previewId: string; file: File }> = [];
  const unmatchedNamed: Array<{ previewId: string; file: File }> = [];
  const leftovers: File[] = [];
  const unusedHeic: File[] = [];

  for (const file of files) {
    if (nativePreviewIdFromPreviewFileName(file.name)) {
      leftovers.push(file);
      continue;
    }
    const previewId = nativePreviewIdFromFileName(file.name);
    if (previewId) {
      if (pendingSet.has(previewId)) {
        matched.push({ previewId, file });
        pendingSet.delete(previewId);
      } else {
        unmatchedNamed.push({ previewId, file });
      }
      continue;
    }
    if (isHeicLikeFile(file)) {
      unusedHeic.push(file);
      continue;
    }
    leftovers.push(file);
  }

  const leftoverIds = pendingIds.filter((id) => pendingSet.has(id));
  const heicFallbacks: Array<{ previewId: string; file: File }> = [];
  for (let i = 0; i < unusedHeic.length; i++) {
    if (leftoverIds[i]) {
      heicFallbacks.push({ previewId: leftoverIds[i]!, file: unusedHeic[i]! });
    } else {
      leftovers.push(unusedHeic[i]!);
    }
  }
  return { matched, unmatchedNamed, heicFallbacks, leftovers };
}

export function partitionNativeChooserFiles(files: File[]): {
  previews: Array<{ previewId: string; file: File }>;
  leftovers: File[];
} {
  const previews: Array<{ previewId: string; file: File }> = [];
  const leftovers: File[] = [];
  for (const file of files) {
    const previewId = nativePreviewIdFromPreviewFileName(file.name);
    if (previewId) previews.push({ previewId, file });
    else leftovers.push(file);
  }
  return { previews, leftovers };
}
