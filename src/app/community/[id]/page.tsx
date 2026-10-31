import Link from "next/link";
import dayjs from "dayjs";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { findLiveFreeBoardPost, toFreeBoardPostPublic } from "@/lib/freeBoard";
import { listFreeBoardPhotos } from "@/lib/freeBoardPhoto";
import { canComposeCommentAs, listFreeBoardComments } from "@/lib/freeBoardComments";
import FreeBoardPhotoGallery from "../FreeBoardPhotoGallery";
import FreeBoardDetailActions from "./FreeBoardDetailActions";
import FreeBoardComments from "./FreeBoardComments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function FreeBoardDetailPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/community");
  const id = Number((await Promise.resolve(params)).id);
  const row = await findLiveFreeBoardPost(prisma, id);
  if (!row) notFound();
  const photos = await listFreeBoardPhotos(prisma, row.id);
  const post = toFreeBoardPostPublic(row, auth, { photoCount: photos.length });
  const comments = await listFreeBoardComments(prisma, row.id, auth);
  const canCompose = await canComposeCommentAs(prisma, auth);

  return (
    <div className="course-report-page course-report-detail free-board-page">
      <Link href="/community" className="ui-btn ui-btn-ghost course-report-back">
        ← 목록
      </Link>
      <h1 className="ui-page-title">{post.title}</h1>
      <p className="course-report-detail-meta">
        <span>{post.authorDisplayName}</span>
        <span> · {dayjs(post.createdAt).format("YYYY-MM-DD HH:mm")}</span>
        {post.edited ? <span> · 수정됨</span> : null}
      </p>
      <div className="course-report-detail-body">{post.body}</div>
      <FreeBoardPhotoGallery postId={post.id} photos={photos} />
      <FreeBoardDetailActions id={post.id} canEdit={post.canEdit} canDelete={post.canDelete} />
      <FreeBoardComments postId={post.id} initialComments={comments} canCompose={canCompose} />
    </div>
  );
}
