import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  communityUnavailableResponse,
  isCommunityAuthResponse,
  isCommunityTableMissing,
  requireCommunityReader,
  resolveCommunityActor,
} from "@/lib/communityBoard";
import {
  CommentValidationError,
  softDeleteCommunityComment,
  updateCommunityComment,
} from "@/lib/communityBoardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  if (isCommunityTableMissing(e)) return communityUnavailableResponse();
  throw e;
}

/** 댓글 수정: 작성자 본인만. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const r = await Promise.resolve(params);
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const comment = await updateCommunityComment(
      prisma,
      Number(r.id),
      Number(r.commentId),
      actor,
      payload && typeof payload === "object" ? (payload as { body?: unknown }).body : undefined
    );
    return NextResponse.json({ comment });
  } catch (e) {
    return fail(e);
  }
}

/** 댓글 삭제: 작성자 본인 또는 관리자. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const r = await Promise.resolve(params);
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    await softDeleteCommunityComment(prisma, Number(r.id), Number(r.commentId), actor);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
