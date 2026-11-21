import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canComposeCommunity, resolveCommunityActor } from "@/lib/communityBoard";
import { COMMUNITY_FREE_BOARD_PATH } from "@/lib/communityBoardConstants";
import FreeBoardForm from "@/app/community/FreeBoardForm";
import { TALK_FORM_BOARD } from "../talkForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NewTalkPostPage() {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/talk/new");
  const actor = await resolveCommunityActor(prisma, auth);
  if (!canComposeCommunity(actor)) redirect(COMMUNITY_FREE_BOARD_PATH);
  return (
    <div className="course-report-page talk-page">
      <Link href={COMMUNITY_FREE_BOARD_PATH} className="talk-back">
        ‹ 자유게시판
      </Link>
      <h1 className="ui-page-title talk-form-title">글쓰기</h1>
      <FreeBoardForm board={TALK_FORM_BOARD} />
    </div>
  );
}
