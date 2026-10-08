import {
  chatPhotoDebugApiUrl,
  markChatPhotoTiming,
  noteChatPhotoServerHotpath,
  noteChatPhotoStorageBackend,
  noteChatPhotoWorkerTiming,
  stampChatPhotoTiming,
} from "@/lib/chatPhotoTiming";
import { CHAT_MEDIA_GRANT_HEADER } from "../../cloudflare/verthill-chat/src/chatMediaGrant";

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

export type ChatPhotoPutResult = {
  receipt?: string;
  actualSize?: number;
  mimeType?: string;
  ingressMs?: number;
  storeMs?: number;
};

function parseChatPhotoPutResult(text: string): ChatPhotoPutResult {
  if (!text) return {};
  try {
    const row = JSON.parse(text) as {
      receipt?: unknown;
      actualSize?: unknown;
      mimeType?: unknown;
      timing?: { ingressMs?: unknown; storeMs?: unknown };
    };
    const result: ChatPhotoPutResult = {};
    if (typeof row.receipt === "string" && row.receipt) result.receipt = row.receipt;
    if (Number.isFinite(Number(row.actualSize))) result.actualSize = Number(row.actualSize);
    if (typeof row.mimeType === "string" && row.mimeType) result.mimeType = row.mimeType;
    const ingressMs = Number(row.timing?.ingressMs);
    const storeMs = Number(row.timing?.storeMs);
    if (Number.isFinite(ingressMs)) result.ingressMs = ingressMs;
    if (Number.isFinite(storeMs)) result.storeMs = storeMs;
    return result;
  } catch {
    return {};
  }
}

export async function putChatPhotoBytes(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  onProgress?: (pct: number) => void,
  extraHeaders?: { grant?: string }
): Promise<ChatPhotoPutResult> {
  if (typeof XMLHttpRequest !== "undefined") {
    return new Promise<ChatPhotoPutResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("content-type", contentType);
      if (extraHeaders?.grant) {
        xhr.setRequestHeader(CHAT_MEDIA_GRANT_HEADER, extraHeaders.grant);
      }
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress?.(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(100);
          resolve(parseChatPhotoPutResult(xhr.responseText || ""));
          return;
        }
        reject(new Error("사진 업로드에 실패했습니다."));
      };
      xhr.onerror = () => reject(new Error("사진 업로드에 실패했습니다."));
      xhr.send(blob);
    });
  }
  const headers: Record<string, string> = { "content-type": contentType };
  if (extraHeaders?.grant) headers[CHAT_MEDIA_GRANT_HEADER] = extraHeaders.grant;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: blob,
  });
  if (!res.ok) {
    throw new Error("사진 업로드에 실패했습니다.");
  }
  onProgress?.(100);
  return parseChatPhotoPutResult(await res.text().catch(() => ""));
}

export async function uploadChatPhotoDirect(
  roomId: string,
  item: { key: string; blob: Blob; send?: { result?: ChatPhotoDirectResult } },
  opts: {
    onProgress?: (progress: ChatPhotoDirectProgress) => void;
    fetchFn?: typeof fetch;
    put?: (
      uploadUrl: string,
      blob: Blob,
      contentType: string,
      onProgress?: (pct: number) => void,
      extraHeaders?: { grant?: string }
    ) => Promise<ChatPhotoPutResult | void>;
    chatToken?: string | null;
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
      body: JSON.stringify({
        contentType: mime,
        size: item.blob.size,
        ...(opts.chatToken ? { chatToken: opts.chatToken } : {}),
      }),
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
  const uploadGrant =
    typeof prepared.upload.uploadGrant === "string" ? prepared.upload.uploadGrant : "";
  const storageBackend = prepared.upload.storageBackend === "r2" ? "r2" : "blob";
  noteChatPhotoStorageBackend(storageBackend);

  notify({ key: item.key, phase: "put", progress: 0, attachmentId });
  const putStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
  stampChatPhotoTiming("put_start", putStarted);
  let putResult: ChatPhotoPutResult = {};
  try {
    putResult =
      (await put(
        uploadUrl,
        item.blob,
        contentType,
        (pct) => {
          notify({ key: item.key, phase: "put", progress: pct, attachmentId });
        },
        uploadGrant ? { grant: uploadGrant } : undefined
      )) || {};
  } catch (e) {
    const message = e instanceof Error ? e.message : "사진 업로드에 실패했습니다.";
    notify({ key: item.key, phase: "error", progress: 0, attachmentId, error: message });
    throw e instanceof Error ? e : new Error(message);
  }
  stampChatPhotoTiming("put_end");
  markChatPhotoTiming("direct_put", putStarted);
  noteChatPhotoWorkerTiming({
    ingressMs: putResult.ingressMs,
    storeMs: putResult.storeMs,
  });

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
      headers: { "content-type": "application/json" },
      body: JSON.stringify(putResult.receipt ? { receipt: putResult.receipt } : {}),
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
