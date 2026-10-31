import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isFreeBoardAuthResponse, requireFreeBoardReader } from "@/lib/freeBoard";
import {
  FreeBoardPhotoStorageError,
  FreeBoardPhotoValidationError,
  uploadFreeBoardPhoto,
} from "@/lib/freeBoardPhoto";
import { FREE_BOARD_PHOTO_MAX_BYTES } from "@/lib/freeBoardConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readUploadBytes(req: NextRequest): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") || 0);
  // multipart overhead 여유 64KB
  if (declared > FREE_BOARD_PHOTO_MAX_BYTES + 64 * 1024) {
    throw new FreeBoardPhotoValidationError("file_too_large", "사진 용량이 너무 큽니다.", 413);
  }
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      throw new FreeBoardPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) {
    throw new FreeBoardPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  return new Uint8Array(buf);
}

/** 사진 1장 업로드. 작성자 본인만, 게시글당 최대 9장 (서버 강제). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(params)).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const bytes = await readUploadBytes(req);
    const photo = await uploadFreeBoardPhoto(prisma, { postId: id, bytes, auth });
    return NextResponse.json({ ok: true, photo }, { status: 201 });
  } catch (e) {
    if (e instanceof FreeBoardPhotoValidationError || e instanceof FreeBoardPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
