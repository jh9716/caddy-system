import {
  chatPhotoDebugApiUrl,
  markChatPhotoTiming,
  noteChatPhotoServerHotpath,
  stampChatPhotoTiming,
} from "@/lib/chatPhotoTiming";

export type ChatPhotoDirectResult = {
  id: string;
  mimeType: string;
  size: number;
  exp: number;
  claim: string;
};

export function chatPhotoClaimStillValid(
  result?: ChatPhotoDirectResult | null,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  return Boolean(
    result?.id &&
      result.claim &&
      Number.isFinite(result.exp) &&
      result.exp > nowSec
  );
}

export type ChatPhotoDirectProgress = {
  key: string;
  phase: "prepare" | "put" | "finalize" | "done" | "error";
  progress: number;
  attachmentId?: string;
  error?: string;
};

export async function putChatPhotoBytes(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (typeof XMLHttpRequest !== "undefined") {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("content-type", contentType);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress?.(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(100);
          resolve();
          return;
        }
        reject(new Error("사진 업로드에 실패했습니다."));
      };
      xhr.onerror = () => reject(new Error("사진 업로드에 실패했습니다."));
      xhr.send(blob);
    });
    return;
  }
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: blob,
  });
  if (!res.ok) {
    throw new Error("사진 업로드에 실패했습니다.");
  }
  onProgress?.(100);
}

export async function uploadChatPhotoDirect(
  roomId: string,
  item: { key: string; blob: Blob; send?: { result?: ChatPhotoDirectResult } },
  opts: {
    onProgress?: (progress: ChatPhotoDirectProgress) => void;
    fetchFn?: typeof fetch;
    put?: typeof putChatPhotoBytes;
  } = {}
): Promise<ChatPhotoDirectResult> {
  if (chatPhotoClaimStillValid(item.send?.result)) {
    return item.send!.result!;
  }
  const fetchFn = opts.fetchFn || fetch;
  const put = opts.put || putChatPhotoBytes;
  const notify = (progress: ChatPhotoDirectProgress) => opts.onProgress?.(progress);
  const mime = (item.blob.type || "image/jpeg").toLowerCase().split(";", 1)[0] || "image/jpeg";

  notify({ key: item.key, phase: "prepare", progress: 0 });
  const prepareStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  stampChatPhotoTiming("prepare_api_start", prepareStarted);
  const preparedRes = await fetchFn(
    chatPhotoDebugApiUrl(`/api/chat/rooms/${encodeURIComponent(roomId)}/attachments/prepare`),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentType: mime, size: item.blob.size }),
    }
  );
  const prepared = await preparedRes.json().catch(() => null);
  markChatPhotoTiming("prepare_api", prepareStarted);
  noteChatPhotoServerHotpath(prepared?.hotpath);
  if (!preparedRes.ok || !prepared?.upload?.attachmentId || !prepared.upload.uploadUrl) {
    const message = prepared?.message || "사진 업로드 준비에 실패했습니다.";
    notify({ key: item.key, phase: "error", progress: 0, error: message });
    throw new Error(message);
  }
  const attachmentId = String(prepared.upload.attachmentId);
  const uploadUrl = String(prepared.upload.uploadUrl);
  const contentType = String(prepared.upload.contentType || mime);

  notify({ key: item.key, phase: "put", progress: 0, attachmentId });
  const putStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  stampChatPhotoTiming("put_start", putStarted);
  try {
    await put(uploadUrl, item.blob, contentType, (pct) => {
      notify({ key: item.key, phase: "put", progress: pct, attachmentId });
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "사진 업로드에 실패했습니다.";
    notify({ key: item.key, phase: "error", progress: 0, attachmentId, error: message });
    throw e instanceof Error ? e : new Error(message);
  }
  stampChatPhotoTiming("put_end");
  markChatPhotoTiming("direct_put", putStarted);

  notify({ key: item.key, phase: "finalize", progress: 100, attachmentId });
  const finalizeStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  stampChatPhotoTiming("finalize_start", finalizeStarted);
  const finalizedRes = await fetchFn(
    chatPhotoDebugApiUrl(
      `/api/chat/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/finalize`
    ),
    {
      method: "POST",
      credentials: "include",
    }
  );
  const finalized = await finalizedRes.json().catch(() => null);
  stampChatPhotoTiming("finalize_end");
  markChatPhotoTiming("finalize_api", finalizeStarted);
  noteChatPhotoServerHotpath(finalized?.hotpath);
  if (!finalizedRes.ok || !finalized?.photo?.id || !finalized.photo.claim) {
    const message = finalized?.message || "사진 확인에 실패했습니다.";
    notify({ key: item.key, phase: "error", progress: 100, attachmentId, error: message });
    throw new Error(message);
  }
  const result: ChatPhotoDirectResult = {
    id: String(finalized.photo.id),
    mimeType: String(finalized.photo.mimeType || contentType),
    size: Number(finalized.photo.size || item.blob.size),
    exp: Number(finalized.photo.exp),
    claim: String(finalized.photo.claim),
  };
  notify({ key: item.key, phase: "done", progress: 100, attachmentId });
  return result;
}
