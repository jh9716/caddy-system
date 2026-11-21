/**
 * 사진 업로드 요청 본문 읽기 (server-only). 가배치표 업로드 route 와 같은 방식:
 * Content-Length 와 무관하게 실제 스트림을 최대 크기로 제한한 뒤 multipart 를 해석한다.
 */
import type { NextRequest } from "next/server";
import { COMMUNITY_PHOTO_MAX_BYTES } from "@/lib/communityBoardConstants";
import { CommunityPhotoValidationError, normalizeCommunityUploadKey } from "@/lib/communityBoardPhoto";

/** multipart boundary/field header 여유 64KB. */
export const COMMUNITY_UPLOAD_REQUEST_MAX_BYTES = COMMUNITY_PHOTO_MAX_BYTES + 64 * 1024;

const tooLarge = () => new CommunityPhotoValidationError("file_too_large", "사진 용량이 너무 큽니다.", 413);

async function readBoundedBody(req: NextRequest, maxBytes: number): Promise<Uint8Array> {
  const declaredHeader = req.headers.get("content-length");
  if (declaredHeader != null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw tooLarge();
  }
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("community upload request too large").catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readCommunityUpload(req: NextRequest): Promise<{ bytes: Uint8Array; uploadKey: string | null }> {
  const headerKey = req.headers.get("x-upload-key");
  const body = await readBoundedBody(req, COMMUNITY_UPLOAD_REQUEST_MAX_BYTES);
  if (body.byteLength === 0) {
    throw new CommunityPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const boundedHeaders = new Headers(req.headers);
    boundedHeaders.set("content-length", String(body.byteLength));
    const boundedBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const boundedRequest = new Request(req.url, { method: "POST", headers: boundedHeaders, body: boundedBody });
    const form = await boundedRequest.formData().catch(() => null);
    const files = form ? form.getAll("file") : [];
    // 요청 1건 = 사진 1장. 여러 장을 한 번에 넣어 장수 제한을 우회하지 못하게 한다.
    if (files.length !== 1 || !(files[0] instanceof Blob)) {
      throw new CommunityPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    const formKey = form?.get("uploadKey");
    return {
      bytes: new Uint8Array(await (files[0] as Blob).arrayBuffer()),
      uploadKey: normalizeCommunityUploadKey(typeof formKey === "string" ? formKey : headerKey),
    };
  }
  return { bytes: body, uploadKey: normalizeCommunityUploadKey(headerKey) };
}
