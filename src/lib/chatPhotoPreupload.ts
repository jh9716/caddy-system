import {
  uploadChatPhotoDirect,
  chatPhotoClaimStillValid,
  type ChatPhotoDirectProgress,
  type ChatPhotoDirectResult,
} from "@/lib/chatPhotoDirectClient";
import {
  CHAT_PHOTO_UPLOAD_CONCURRENCY,
  mapBoundedSettled,
  readyChatPhotosForUpload,
  type ChatPendingPhoto,
} from "@/lib/chatPhotoPick";
import { markChatPhotoTiming, chatPhotoNow } from "@/lib/chatPhotoTiming";

export type ChatPhotoUploadJobMap = Map<string, Promise<ChatPhotoDirectResult>>;

export type ChatPhotoPreuploadOptions = {
  upload?: typeof uploadChatPhotoDirect;
  onProgress?: (progress: ChatPhotoDirectProgress & { result?: ChatPhotoDirectResult }) => void;
  nowSec?: number;
  chatToken?: string | null;
};

export function reusableChatPhotoResult(
  item: { send?: { result?: ChatPhotoDirectResult } },
  nowSec = Math.floor(Date.now() / 1000)
): ChatPhotoDirectResult | null {
  const result = item.send?.result;
  return chatPhotoClaimStillValid(result, nowSec) ? result! : null;
}

export function reusablePendingClaims(
  claims: Array<ChatPhotoDirectResult> | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): ChatPhotoDirectResult[] | null {
  if (!claims?.length) return null;
  if (claims.every((row) => chatPhotoClaimStillValid(row, nowSec))) return claims;
  return null;
}

function itemWithoutExpiredClaim(
  item: ChatPendingPhoto,
  nowSec: number
): ChatPendingPhoto {
  if (!item.send?.result || chatPhotoClaimStillValid(item.send.result, nowSec)) return item;
  return {
    ...item,
    send: {
      ...item.send,
      result: undefined,
      attachmentId: item.send.phase === "done" ? undefined : item.send.attachmentId,
      phase: item.send.phase === "done" ? "idle" : item.send.phase,
    },
  };
}

export function startChatPhotoPreupload(
  jobs: ChatPhotoUploadJobMap,
  roomId: string,
  item: ChatPendingPhoto,
  opts: ChatPhotoPreuploadOptions = {}
): Promise<ChatPhotoDirectResult> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const reusable = reusableChatPhotoResult(item, nowSec);
  if (reusable) return Promise.resolve(reusable);

  const inflight = jobs.get(item.key);
  if (inflight) return inflight;

  const upload = opts.upload || uploadChatPhotoDirect;
  const promise = upload(roomId, itemWithoutExpiredClaim(item, nowSec), {
    onProgress: opts.onProgress,
    chatToken: opts.chatToken,
  })
    .then((result) => {
      opts.onProgress?.({
        key: item.key,
        phase: "done",
        progress: 100,
        attachmentId: result.id,
        result,
      });
      return result;
    })
    .catch((error) => {
      if (jobs.get(item.key) === promise) jobs.delete(item.key);
      throw error;
    });
  jobs.set(item.key, promise);
  return promise;
}

export function abandonChatPhotoPreupload(
  jobs: ChatPhotoUploadJobMap,
  keys?: Iterable<string>
): void {
  if (!keys) {
    jobs.clear();
    return;
  }
  for (const key of keys) jobs.delete(key);
}

export async function resolveChatPhotoUploads(
  jobs: ChatPhotoUploadJobMap,
  roomId: string,
  items: readonly ChatPendingPhoto[],
  opts: ChatPhotoPreuploadOptions = {}
): Promise<ChatPhotoDirectResult[]> {
  const ready = readyChatPhotosForUpload(items);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const settled = await mapBoundedSettled(ready, CHAT_PHOTO_UPLOAD_CONCURRENCY, async (item) => {
    const result = await startChatPhotoPreupload(jobs, roomId, item, opts);
    if (chatPhotoClaimStillValid(result, nowSec)) return result;
    if (jobs.get(item.key)) jobs.delete(item.key);
    return startChatPhotoPreupload(jobs, roomId, itemWithoutExpiredClaim(item, nowSec), opts);
  });
  const failed = settled.find((row) => row.status === "rejected");
  if (failed && failed.status === "rejected") {
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error("사진 업로드에 실패했습니다.");
  }
  return settled.map((row) => {
    if (row.status !== "fulfilled") {
      throw new Error("사진 업로드에 실패했습니다.");
    }
    return row.value;
  });
}

export async function finishChatPhotoOutgoingUploads(opts: {
  jobs: ChatPhotoUploadJobMap;
  roomId: string;
  photos: readonly ChatPendingPhoto[];
  pendingClaims?: ChatPhotoDirectResult[];
  upload?: typeof uploadChatPhotoDirect;
  onProgress?: ChatPhotoPreuploadOptions["onProgress"];
  nowSec?: number;
}): Promise<ChatPhotoDirectResult[]> {
  const started = chatPhotoNow();
  const claimed = reusablePendingClaims(opts.pendingClaims, opts.nowSec);
  if (claimed) {
    markChatPhotoTiming("upload_direct", started);
    return claimed;
  }
  const fromPhotos = opts.photos.map((item) => reusableChatPhotoResult(item, opts.nowSec));
  if (fromPhotos.length > 0 && fromPhotos.every(Boolean)) {
    markChatPhotoTiming("upload_direct", started);
    return fromPhotos as ChatPhotoDirectResult[];
  }
  const uploaded = await resolveChatPhotoUploads(opts.jobs, opts.roomId, opts.photos, {
    upload: opts.upload,
    onProgress: opts.onProgress,
    nowSec: opts.nowSec,
  });
  markChatPhotoTiming("upload_direct", started);
  return uploaded;
}
