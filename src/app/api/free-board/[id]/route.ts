import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  FreeBoardValidationError,
  canDeleteFreeBoardPost,
  canEditFreeBoardPost,
  countFreeBoardComments,
  findLiveFreeBoardPost,
  isFreeBoardAuthResponse,
  parseFreeBoardPostBody,
  requireFreeBoardReader,
  toFreeBoardPostPublic,
} from "@/lib/freeBoard";
import { cleanupFreeBoardPostPhotos, listFreeBoardPhotos } from "@/lib/freeBoardPhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> | { id: string } };

async function postId(ctx: Ctx): Promise<number> {
  return Number((await Promise.resolve(ctx.params)).id);
}

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const post = await findLiveFreeBoardPost(prisma, await postId(ctx));
  if (!post) return notFound();
  const photos = await listFreeBoardPhotos(prisma, post.id);
  const counts = await countFreeBoardComments(prisma, [post.id]);
  return NextResponse.json({
    post: toFreeBoardPostPublic(post, auth, {
      photoCount: photos.length,
      commentCount: counts.get(post.id) ?? 0,
    }),
    photos,
  });
}

/** 수정: 작성자 본인만. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const post = await findLiveFreeBoardPost(prisma, await postId(ctx));
  if (!post) return notFound();
  if (
    !canEditFreeBoardPost({
      userId: auth.userId,
      authorUserId: post.authorUserId,
      deletedAt: post.deletedAt,
    })
  ) {
    return NextResponse.json(
      { error: "forbidden", message: "본인 글만 수정할 수 있습니다." },
      { status: 403 }
    );
  }
  const payload = await req.json().catch(() => ({}));
  try {
    const parsed = parseFreeBoardPostBody(payload);
    const updated = await prisma.freeBoardPost.update({
      where: { id: post.id },
      data: parsed,
    });
    return NextResponse.json({ ok: true, post: toFreeBoardPostPublic(updated, auth) });
  } catch (e) {
    if (e instanceof FreeBoardValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}

/** 삭제(soft): 작성자 본인 또는 관리자. 사진 객체는 best-effort 정리. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireFreeBoardReader(req);
  if (isFreeBoardAuthResponse(auth)) return auth;
  const post = await findLiveFreeBoardPost(prisma, await postId(ctx));
  if (!post) return notFound();
  if (
    !canDeleteFreeBoardPost({
      role: auth.role,
      userId: auth.userId,
      authorUserId: post.authorUserId,
      deletedAt: post.deletedAt,
    })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await prisma.freeBoardPost.update({
    where: { id: post.id },
    data: { deletedAt: new Date() },
  });
  try {
    await cleanupFreeBoardPostPhotos(prisma, post.id);
  } catch {
    // 사진 정리 실패가 게시글 삭제를 실패시키지 않음
  }
  return NextResponse.json({ ok: true });
}
