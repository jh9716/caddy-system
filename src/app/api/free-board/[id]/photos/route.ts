import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { FreeBoardValidationError, isFreeBoardAuthResponse, requireFreeBoardReader, resolveFreeBoardActor } from "@/lib/freeBoard";
import {
  FreeBoardPhotoStorageError,
  FreeBoardPhotoValidationError,
  normalizeFreeBoardUploadKey,
  uploadFreeBoardPhoto,
} from "@/lib/freeBoardPhoto";
import { FREE_BOARD_PHOTO_MAX_BYTES } from "@/lib/freeBoardConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** multipart boundary/field headers에 허용하는 최대 여유. 요청 전체는 이 크기를 넘기면 즉시 중단한다. */
const FREE_BOARD_UPLOAD_REQUEST_MAX_BYTES = FREE_BOARD_PHOTO_MAX_BYTES + 64 * 1024;

async function readBoundedBody(req: NextRequest, maxBytes: number): Promise<Uint8Array> {
  const declaredHeader = req.headers.get("content-length");
  if (declaredHeader != null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new FreeBoardPhotoValidationError("file_too_large", "사진 용량이 너무 큽니다.", 413);
    }
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
        await reader.cancel("free-board upload request too large").catch(() => undefined);
        throw new FreeBoardPhotoValidationError("file_too_large", "사진 용량이 너무 큽니다.", 413);
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

async function readUpload(req: NextRequest): Promise<{ bytes: Uint8Array; uploadKey: string | null }> {
  const headerKey = req.headers.get("x-upload-key");
  // Content-Length 유무/정확성과 무관하게 실제 스트림을 먼저 제한한다.
  // 이후 formData()/arrayBuffer()에는 최대 약 3MB+64KB만 전달된다.
  const body = await readBoundedBody(req, FREE_BOARD_UPLOAD_REQUEST_MAX_BYTES);
  if (body.byteLength === 0) {
    throw new FreeBoardPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const boundedHeaders = new Headers(req.headers);
    boundedHeaders.set("content-length", String(body.byteLength));
    const boundedBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const boundedRequest = new Request(req.url, { method: "POST", headers: boundedHeaders, body: boundedBody });
    const form = await boundedRequest.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      throw new FreeBoardPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    const formKey = form?.get("uploadKey");
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      uploadKey: normalizeFreeBoardUploadKey(typeof formKey === "string" ? formKey : headerKey),
    };
  }
  return { bytes: body, uploadKey: normalizeFreeBoardUploadKey(headerKey) };
}

/** 사진 1장 업로드. 관리자만, 게시글당 최대 9장 (서버 강제). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(params)).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const actor = await resolveFreeBoardActor(prisma, auth);
    const { bytes, uploadKey } = await readUpload(req);
    const { duplicate, ...photo } = await uploadFreeBoardPhoto(prisma, { postId: id, bytes, auth: actor, uploadKey });
    return NextResponse.json({ ok: true, photo, duplicate: !!duplicate }, { status: duplicate ? 200 : 201 });
  } catch (e) {
    if (e instanceof FreeBoardValidationError || e instanceof FreeBoardPhotoValidationError || e instanceof FreeBoardPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
