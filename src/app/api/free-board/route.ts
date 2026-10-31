import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  FreeBoardValidationError,
  canComposeFreeBoard,
  isFreeBoardAuthResponse,
  listFreeBoardPosts,
  parseFreeBoardPostBody,
  requireFreeBoardReader,
  resolveFreeBoardAuthorSnapshot,
  toFreeBoardPostPublic,
} from "@/lib/freeBoard";
import { FREE_BOARD_LIST_TAKE } from "@/lib/freeBoardConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const posts = await listFreeBoardPosts(prisma, auth, FREE_BOARD_LIST_TAKE);
  return NextResponse.json({ posts, canCompose: canComposeFreeBoard(auth) });
}

export async function POST(req: NextRequest) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const payload = await req.json().catch(() => ({}));
  try {
    const parsed = parseFreeBoardPostBody(payload);
    const author = await resolveFreeBoardAuthorSnapshot(prisma, auth);
    const created = await prisma.freeBoardPost.create({
      data: { ...author, title: parsed.title, body: parsed.body },
    });
    return NextResponse.json(
      { ok: true, id: created.id, post: toFreeBoardPostPublic(created, auth) },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof FreeBoardValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
