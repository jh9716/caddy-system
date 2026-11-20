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
  canComposeCommentAs,
  createCommunityComment,
  listCommunityComments,
} from "@/lib/communityBoardComments";
import { readCommentWritePayload } from "@/lib/comment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  if (isCommunityTableMissing(e)) return communityUnavailableResponse();
  throw e;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(ctx.params)).id);
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const comments = await listCommunityComments(prisma, id, actor);
    return NextResponse.json({ comments, canCompose: await canComposeCommentAs(prisma, actor) });
  } catch (e) {
    return fail(e);
  }
}

/** 댓글·답글 작성 (parentId = 원댓글 id, 1단계). 작성자는 세션 기준. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(ctx.params)).id);
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const write = readCommentWritePayload(payload);
    const comment = await createCommunityComment(prisma, id, actor, write.body, write.parentId);
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
