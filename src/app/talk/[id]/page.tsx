import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import {
  countCommunityComments,
  findLiveCommunityPost,
  resolveCommunityActor,
  toCommunityPostPublic,
} from "@/lib/communityBoard";
import { COMMUNITY_FREE_BOARD_API, COMMUNITY_FREE_BOARD_PATH } from "@/lib/communityBoardConstants";
import { listCommunityPhotos } from "@/lib/communityBoardPhoto";
import { canComposeCommentAs, listCommunityComments } from "@/lib/communityBoardComments";
import { TalkCommentCountLabel, TalkCommentCountProvider, TalkComments } from "./TalkCommentCount";
import TalkPhotoGallery from "./TalkPhotoGallery";
import TalkDetailActions from "./TalkDetailActions";
import { formatTalkDetailTime } from "../talkTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TalkDetailPage({ params }: { params: Promise<{ id: string }> | { id: string } }) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/talk");
  const actor = await resolveCommunityActor(prisma, auth);
  const id = Number((await Promise.resolve(params)).id);
  const row = await findLiveCommunityPost(prisma, id);
  if (!row) notFound();
  const photos = await listCommunityPhotos(prisma, row.id);
  const counts = await countCommunityComments(prisma, [row.id]);
  const post = toCommunityPostPublic(row, actor, { photoCount: photos.length, commentCount: counts.get(row.id) ?? 0 });
  const comments = await listCommunityComments(prisma, row.id, actor);
  const canCompose = await canComposeCommentAs(prisma, actor);
  const moderatorOnly = post.canDelete && !post.isMine;

  return (
    <TalkCommentCountProvider initialCount={post.commentCount}>
    <div className="course-report-page talk-page talk-detail">
      <Link href={COMMUNITY_FREE_BOARD_PATH} className="talk-back">
        ‹ 자유게시판
      </Link>
      <article className="talk-article">
        <header className="talk-article-head">
          <h1 className="talk-article-title">{post.title}</h1>
          <p className="talk-article-meta">
            <span className="talk-row-author">{post.authorDisplayName}</span>
            <time dateTime={post.createdAt}>{formatTalkDetailTime(post.createdAt)}</time>
            {post.edited ? <span>수정됨</span> : null}
            <TalkCommentCountLabel fallback={post.commentCount} />
          </p>
        </header>
        <div className="talk-article-body">{post.body}</div>
        <TalkPhotoGallery postId={post.id} photos={photos} />
        <TalkDetailActions
          id={post.id}
          canEdit={post.canEdit}
          canDelete={post.canDelete}
          moderatorOnly={moderatorOnly}
        />
      </article>
      <TalkComments
        postId={post.id}
        initialComments={comments}
        canCompose={canCompose}
        apiBase={COMMUNITY_FREE_BOARD_API}
      />
    </div>
    </TalkCommentCountProvider>
  );
}
