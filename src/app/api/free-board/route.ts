import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  FreeBoardValidationError,
  canComposeFreeBoard,
  isFreeBoardAuthResponse,
  listFreeBoardPosts,
  parseFreeBoardPostBody,
  requireFreeBoardReader,
  resolveFreeBoardActor,
  resolveFreeBoardAuthorSnapshot,
  toFreeBoardPostPublic,
} from "@/lib/freeBoard";
import { FREE_BOARD_LIST_TAKE } from "@/lib/freeBoardConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const actor = await resolveFreeBoardActor(prisma, auth).catch(() => auth);
  const posts = await listFreeBoardPosts(prisma, actor, FREE_BOARD_LIST_TAKE);
  return NextResponse.json({ posts, canCompose: canComposeFreeBoard(actor) });
}

export async function POST(req: NextRequest) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveFreeBoardActor(prisma, auth);
    const parsed = parseFreeBoardPostBody(payload);
    const author = await resolveFreeBoardAuthorSnapshot(prisma, actor);
    const created = await prisma.freeBoardPost.create({
      data: { ...author, title: parsed.title, body: parsed.body },
    });
    return NextResponse.json(
      { ok: true, id: created.id, post: toFreeBoardPostPublic(created, actor) },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof FreeBoardValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
