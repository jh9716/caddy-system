import { revokeChatPhotoPreviewUrl, type ChatPendingPhoto } from "@/lib/chatPhotoPick";

export type OptimisticChatComposer = {
  draft: string;
  pendingPhotos: ChatPendingPhoto[];
  replyTo: null;
};

export type OptimisticOutgoingLine = {
  status: "sending";
  body: string;
  localPhotos: ChatPendingPhoto[];
  attachments: [];
  pendingClaims: [];
};

export function usableOptimisticChatPhotos(photos: readonly ChatPendingPhoto[]): ChatPendingPhoto[] {
  return photos.filter((item) => item.status !== "failed" && item.blob && item.blob.size > 0);
}

export function shouldStartOptimisticChatSend(body: string, photos: readonly ChatPendingPhoto[]): boolean {
  return Boolean(body.trim() || usableOptimisticChatPhotos(photos).length);
}

export function clearedComposerAfterOptimisticSend(): OptimisticChatComposer {
  return { draft: "", pendingPhotos: [], replyTo: null };
}

export function buildOptimisticOutgoingLine(
  body: string,
  photos: readonly ChatPendingPhoto[]
): OptimisticOutgoingLine {
  return {
    status: "sending",
    body,
    localPhotos: usableOptimisticChatPhotos(photos),
    attachments: [],
    pendingClaims: [],
  };
}

export function revokeChatPhotoPreviewUrls(photos: readonly { previewUrl?: string }[]): void {
  for (const item of photos) {
    revokeChatPhotoPreviewUrl(item.previewUrl);
  }
}

export function outgoingChatPhotoSrc(input: {
  roomId: string;
  attachmentId?: string;
  previewUrl?: string;
  chatPhotoSrc: (roomId: string, attachmentId: string) => string;
}): string {
  if (input.attachmentId) return input.chatPhotoSrc(input.roomId, input.attachmentId);
  return input.previewUrl || "";
}
