import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canEditCommunityPost, findLiveCommunityPost, resolveCommunityActor } from "@/lib/communityBoard";
import { communityPostHref } from "@/lib/communityBoardConstants";
import { listCommunityPhotos } from "@/lib/communityBoardPhoto";
import FreeBoardForm from "@/app/community/FreeBoardForm";
import { TALK_FORM_BOARD } from "../../talkForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EditTalkPostPage({ params }: { params: Promise<{ id: string }> | { id: string } }) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/talk");
  const actor = await resolveCommunityActor(prisma, auth);
  const id = Number((await Promise.resolve(params)).id);
  const row = await findLiveCommunityPost(prisma, id);
  if (!row) notFound();
  // 작성자 본인만. 관리자도 다른 사람 글은 수정 화면에 들어갈 수 없다.
  if (!canEditCommunityPost({ role: actor.role, userId: actor.userId, authorUserId: row.authorUserId, deletedAt: row.deletedAt })) {
    redirect(communityPostHref(row.id));
  }
  const photos = await listCommunityPhotos(prisma, row.id);
  return (
    <div className="course-report-page talk-page">
      <Link href={communityPostHref(row.id)} className="talk-back">
        ‹ 글로 돌아가기
      </Link>
      <h1 className="ui-page-title talk-form-title">글 수정</h1>
      <FreeBoardForm mode="edit" board={TALK_FORM_BOARD} initial={{ id: row.id, title: row.title, body: row.body, photos }} />
    </div>
  );
}
