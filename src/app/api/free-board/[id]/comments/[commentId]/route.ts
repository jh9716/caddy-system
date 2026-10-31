import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isFreeBoardAuthResponse, requireFreeBoardReader } from "@/lib/freeBoard";
import { CommentValidationError, softDeleteFreeBoardComment } from "@/lib/freeBoardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; commentId: string }> | { id: string; commentId: string } }
) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const r = await Promise.resolve(params);
  try {
    await softDeleteFreeBoardComment(prisma, Number(r.id), Number(r.commentId), auth);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CommentValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
