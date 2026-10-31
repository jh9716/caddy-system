import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isFreeBoardAuthResponse, requireFreeBoardReader } from "@/lib/freeBoard";
import {
  FreeBoardPhotoStorageError,
  FreeBoardPhotoValidationError,
  deleteFreeBoardPhoto,
  loadFreeBoardPhotoMeta,
  openFreeBoardPhotoBody,
} from "@/lib/freeBoardPhoto";
import { photoObjectToResponseBody, privatePhotoStreamHeaders } from "@/lib/photoObjectBody";
import {
  buildPrivatePhotoETag,
  ifNoneMatchContains,
  privatePhotoCacheHeaders,
} from "@/lib/privatePhotoCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = {
  params: Promise<{ id: string; photoId: string }> | { id: string; photoId: string };
};

async function ids(ctx: Ctx) {
  const r = await Promise.resolve(ctx.params);
  return { postId: Number(r.id), photoId: Number(r.photoId) };
}

function invalid(postId: number, photoId: number) {
  return !Number.isInteger(postId) || postId <= 0 || !Number.isInteger(photoId) || photoId <= 0;
}

function fail(e: unknown) {
  if (e instanceof FreeBoardPhotoValidationError || e instanceof FreeBoardPhotoStorageError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  throw e;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const { postId, photoId } = await ids(ctx);
  if (invalid(postId, photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const photo = await loadFreeBoardPhotoMeta(prisma, { postId, photoId });
    const etag = buildPrivatePhotoETag("fb", photo);
    if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers: privatePhotoCacheHeaders(etag) });
    }
    const body = await openFreeBoardPhotoBody(photo.storageKey, req.signal);
    return new NextResponse(photoObjectToResponseBody(body), {
      status: 200,
      headers: privatePhotoStreamHeaders(etag, photo.mimeType, body, {}),
    });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const { postId, photoId } = await ids(ctx);
  if (invalid(postId, photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const result = await deleteFreeBoardPhoto(prisma, { postId, photoId, auth });
    return NextResponse.json({
      ok: true,
      ...(result.blobCleanupFailed ? { blobCleanupFailed: true } : {}),
    });
  } catch (e) {
    return fail(e);
  }
}
