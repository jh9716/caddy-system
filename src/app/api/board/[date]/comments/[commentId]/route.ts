import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommentValidationError,
  isBoardCommentAuthResponse,
  requireBoardCommentReader,
  softDeleteBoardDateComment,
  updateBoardDateComment,
} from "@/lib/boardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params:
      | Promise<{ date: string; commentId: string }>
      | { date: string; commentId: string };
  }
) {
  const auth = await requireBoardCommentReader(req);
  if (isBoardCommentAuthResponse(auth)) return auth;
  const resolved = await Promise.resolve(params);
  try {
    await softDeleteBoardDateComment(
      prisma,
      resolved.date,
      Number(resolved.commentId),
      auth
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CommentValidationError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    throw e;
  }
}

/** 댓글 수정 — 작성자 본인만 (서버 검증). body: { body: string } */
export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params:
      | Promise<{ date: string; commentId: string }>
      | { date: string; commentId: string };
  }
) {
  const auth = await requireBoardCommentReader(req);
  if (isBoardCommentAuthResponse(auth)) return auth;
  const resolved = await Promise.resolve(params);
  const payload = await req.json().catch(() => ({}));
  try {
    const comment = await updateBoardDateComment(
      prisma,
      resolved.date,
      Number(resolved.commentId),
      auth,
      payload && typeof payload === "object"
        ? (payload as { body?: unknown }).body
        : undefined
    );
    return NextResponse.json({ comment });
  } catch (e) {
    if (e instanceof CommentValidationError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    throw e;
  }
}
