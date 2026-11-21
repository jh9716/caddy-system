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
  uploadCommunityPhoto,
} from "@/lib/communityBoardPhoto";
import { readCommunityUpload } from "@/lib/communityPhotoUploadRequest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 사진 1장 업로드. 게시글 작성자 본인만, 게시글당 최대 9장·장당 3MB·JPG/PNG/WEBP (서버 강제). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(params)).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const { bytes, uploadKey } = await readCommunityUpload(req);
    const { duplicate, ...photo } = await uploadCommunityPhoto(prisma, { postId: id, bytes, auth: actor, uploadKey });
    return NextResponse.json({ ok: true, photo, duplicate: !!duplicate }, { status: duplicate ? 200 : 201 });
  } catch (e) {
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
}
