import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommunityValidationError,
  canDeleteCommunityPost,
  canEditCommunityPost,
  communityUnavailableResponse,
  countCommunityComments,
  findLiveCommunityPost,
  isCommunityAuthResponse,
  isCommunityTableMissing,
  parseCommunityPostBody,
  requireCommunityReader,
  resolveCommunityActor,
  toCommunityPostPublic,
} from "@/lib/communityBoard";
import {
  CommunityPhotoValidationError,
  cleanupCommunityPostPhotos,
  listCommunityPhotos,
  parseCommunityRemovedPhotoIds,
  saveCommunityPostEdit,
} from "@/lib/communityBoardPhoto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function postId(ctx: Ctx): Promise<number> {
  return Number((await Promise.resolve(ctx.params)).id);
}

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

function fail(e: unknown) {
  if (e instanceof CommunityValidationError || e instanceof CommunityPhotoValidationError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  if (isCommunityTableMissing(e)) return communityUnavailableResponse();
  throw e;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const post = await findLiveCommunityPost(prisma, await postId(ctx));
    if (!post) return notFound();
    const photos = await listCommunityPhotos(prisma, post.id);
    const counts = await countCommunityComments(prisma, [post.id]);
    return NextResponse.json({
      post: toCommunityPostPublic(post, actor, { photoCount: photos.length, commentCount: counts.get(post.id) ?? 0 }),
      photos,
    });
  } catch (e) {
    return fail(e);
  }
}

/** 수정: 작성자 본인만 (관리자도 타인 글 수정 불가). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const post = await findLiveCommunityPost(prisma, await postId(ctx));
    if (!post) return notFound();
    if (
      !canEditCommunityPost({
        role: actor.role,
        userId: actor.userId,
        authorUserId: post.authorUserId,
        deletedAt: post.deletedAt,
      })
    ) {
      return NextResponse.json({ error: "forbidden", message: "본인이 쓴 글만 수정할 수 있습니다." }, { status: 403 });
    }
    const payload = await req.json().catch(() => ({}));
    const parsed = parseCommunityPostBody(payload);
    const removedPhotoIds = parseCommunityRemovedPhotoIds(
      payload && typeof payload === "object" ? (payload as { removedPhotoIds?: unknown }).removedPhotoIds : undefined
    );
    const saved = await saveCommunityPostEdit(prisma, {
      postId: post.id,
      title: parsed.title,
      body: parsed.body,
      removedPhotoIds,
    });
    return NextResponse.json({
      ok: true,
      post: toCommunityPostPublic(saved.post, actor),
      removedPhotos: saved.removed,
      ...(saved.blobCleanupFailed ? { blobCleanupFailed: saved.blobCleanupFailed } : {}),
    });
  } catch (e) {
    return fail(e);
  }
}

/** 삭제(soft): 작성자 본인 또는 관리자. 사진 객체는 best-effort 정리. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const post = await findLiveCommunityPost(prisma, await postId(ctx));
    if (!post) return notFound();
    if (
      !canDeleteCommunityPost({
        role: actor.role,
        userId: actor.userId,
        authorUserId: post.authorUserId,
        deletedAt: post.deletedAt,
      })
    ) {
      return NextResponse.json({ error: "forbidden", message: "삭제할 수 없습니다." }, { status: 403 });
    }
    // 동시 삭제에도 한 번만 반영 (이미 삭제된 글이면 count=0 → 404)
    const r = await prisma.communityPost.updateMany({
      where: { id: post.id, deletedAt: null },
      data: { deletedAt: new Date(), deletedByUserId: actor.userId ?? null },
    });
    if (r.count === 0) return notFound();
    try {
      await cleanupCommunityPostPhotos(prisma, post.id);
    } catch {
      // 사진 정리 실패가 게시글 삭제를 실패시키지 않음
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
