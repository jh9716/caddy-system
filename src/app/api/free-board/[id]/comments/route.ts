import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isFreeBoardAuthResponse, requireFreeBoardReader, resolveFreeBoardActor } from "@/lib/freeBoard";
import {
  CommentValidationError,
  canComposeCommentAs,
  createFreeBoardComment,
  listFreeBoardComments,
} from "@/lib/freeBoardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> | { id: string } };

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  throw e;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(ctx.params)).id);
  try {
    const actor = await resolveFreeBoardActor(prisma, auth).catch(() => auth);
    const comments = await listFreeBoardComments(prisma, id, actor);
    return NextResponse.json({ comments, canCompose: await canComposeCommentAs(prisma, actor) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const id = Number((await Promise.resolve(ctx.params)).id);
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveFreeBoardActor(prisma, auth);
    const comment = await createFreeBoardComment(
      prisma,
      id,
      actor,
      payload && typeof payload === "object" ? (payload as { body?: unknown }).body : undefined
    );
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
