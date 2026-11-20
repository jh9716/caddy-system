import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommunityValidationError,
  communityUnavailableResponse,
  isCommunityAuthResponse,
  isCommunityTableMissing,
  requireCommunityReader,
  resolveCommunityActor,
} from "@/lib/communityBoard";
import {
  CommunityPhotoStorageError,
  CommunityPhotoValidationError,
  deleteCommunityPhoto,
  loadCommunityPhotoMeta,
  openCommunityPhotoBody,
} from "@/lib/communityBoardPhoto";
import { photoObjectToResponseBody, privatePhotoStreamHeaders } from "@/lib/photoObjectBody";
import { buildPrivatePhotoETag, ifNoneMatchContains, privatePhotoCacheHeaders } from "@/lib/privatePhotoCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; photoId: string }> };

async function ids(ctx: Ctx) {
  const r = await Promise.resolve(ctx.params);
  return { postId: Number(r.id), photoId: Number(r.photoId) };
}

function invalid(postId: number, photoId: number) {
  return !Number.isInteger(postId) || postId <= 0 || !Number.isInteger(photoId) || photoId <= 0;
}

function fail(e: unknown) {
  if (
    e instanceof CommunityValidationError ||
    e instanceof CommunityPhotoValidationError ||
    e instanceof CommunityPhotoStorageError
  ) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  if (isCommunityTableMissing(e)) return communityUnavailableResponse();
  throw e;
}

/** 사진 보기: 로그인 정상 계정만. 이 게시판·이 글 소속 사진만 (private, no public URL). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const { postId, photoId } = await ids(ctx);
  if (invalid(postId, photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const photo = await loadCommunityPhotoMeta(prisma, { postId, photoId });
    const etag = buildPrivatePhotoETag("cm", photo);
    if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers: privatePhotoCacheHeaders(etag) });
    }
    const body = await openCommunityPhotoBody(photo.storageKey, req.signal);
    return new NextResponse(photoObjectToResponseBody(body), {
      status: 200,
      headers: privatePhotoStreamHeaders(etag, photo.mimeType, body, {}),
    });
  } catch (e) {
    return fail(e);
  }
}

/** 사진 1장 삭제: 게시글 작성자 본인만. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const { postId, photoId } = await ids(ctx);
  if (invalid(postId, photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const result = await deleteCommunityPhoto(prisma, { postId, photoId, auth: actor });
    return NextResponse.json({ ok: true, ...(result.blobCleanupFailed ? { blobCleanupFailed: true } : {}) });
  } catch (e) {
    return fail(e);
  }
}
