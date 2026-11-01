import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isFreeBoardAuthResponse, requireFreeBoardReader, resolveFreeBoardActor } from "@/lib/freeBoard";
import { CommentValidationError, softDeleteFreeBoardComment, updateFreeBoardComment } from "@/lib/freeBoardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; commentId: string }> | { id: string; commentId: string } };

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  throw e;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const r = await Promise.resolve(params);
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveFreeBoardActor(prisma, auth);
    const comment = await updateFreeBoardComment(
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

export async function DELETE(
  req: NextRequest,
  { params }: Ctx
) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const r = await Promise.resolve(params);
  try {
    const actor = await resolveFreeBoardActor(prisma, auth).catch(() => auth);
    await softDeleteFreeBoardComment(prisma, Number(r.id), Number(r.commentId), actor);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
