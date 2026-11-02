import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";

export type FreeBoardUploadStatus = "ready" | "uploading" | "done" | "failed";

export type FreeBoardUploadItem = {
  key: string;
  /** 재시도 멱등 키 (UUID v4). 같은 사진의 재전송은 서버에서 중복 생성되지 않는다. */
  uploadKey: string;
  blob: Blob;
  status: FreeBoardUploadStatus;
  error?: string;
};

export function newFreeBoardUploadKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function failMessage(status: number, data: { message?: unknown }): string {
  if (typeof data.message === "string" && data.message) return data.message;
  if (status === 413) return "사진 용량이 너무 큽니다.";
  if (status === 409) return "사진은 최대 9장까지 첨부할 수 있습니다.";
  if (status >= 500) return "서버 오류로 업로드하지 못했습니다.";
  return "업로드하지 못했습니다.";
}

/**
 * 아직 완료되지 않은 사진만 순서대로 업로드한다 (done 은 건너뜀 → 실패분만 재시도).
 * 각 사진 결과를 onItem 으로 즉시 알려 진행 상황(n/N)과 실패 표시를 갱신한다.
 */
export async function uploadFreeBoardPhotos(
  postId: number,
  items: FreeBoardUploadItem[],
  opts: {
    post?: typeof fetch;
    onItem?: (key: string, patch: Partial<FreeBoardUploadItem>) => void;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<{ uploaded: number; failed: number; unauthorized: boolean }> {
  const post = opts.post ?? fetch;
  const todo = items.filter((i) => i.status !== "done");
  let uploaded = 0;
  let failed = 0;
  const total = todo.length;
  opts.onProgress?.(0, total);
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
    opts.onItem?.(it.key, { status: "uploading", error: undefined });
    const mime = (it.blob.type || "image/jpeg").toLowerCase();
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const fd = new FormData();
    fd.append("uploadKey", it.uploadKey);
    fd.append("file", it.blob, `photo-${i}.${ext}`);
    let res: Response;
    try {
      res = await post(`/api/free-board/${postId}/photos`, {
        method: "POST",
        credentials: "include",
        headers: { "X-Upload-Key": it.uploadKey },
        body: fd,
      });
    } catch {
      failed += 1;
      opts.onItem?.(it.key, { status: "failed", error: "네트워크 오류" });
      opts.onProgress?.(i + 1, total);
      continue;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      for (const rest of todo.slice(i)) opts.onItem?.(rest.key, { status: "failed", error: "로그인이 필요합니다." });
      return { uploaded, failed: failed + (todo.length - i), unauthorized: true };
    }
    if (res.ok) {
      uploaded += 1;
      opts.onItem?.(it.key, { status: "done", error: undefined });
    } else {
      failed += 1;
      const data = await res.json().catch(() => ({}));
      opts.onItem?.(it.key, { status: "failed", error: failMessage(res.status, data) });
    }
    opts.onProgress?.(i + 1, total);
  }
  return { uploaded, failed, unauthorized: false };
}
