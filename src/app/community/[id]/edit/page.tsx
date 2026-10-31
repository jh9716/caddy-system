import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canEditFreeBoardPost, findLiveFreeBoardPost } from "@/lib/freeBoard";
import { listFreeBoardPhotos } from "@/lib/freeBoardPhoto";
import FreeBoardForm from "../../FreeBoardForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EditFreeBoardPostPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/community");
  const id = Number((await Promise.resolve(params)).id);
  const row = await findLiveFreeBoardPost(prisma, id);
  if (!row) notFound();
  if (
    !canEditFreeBoardPost({ userId: auth.userId, authorUserId: row.authorUserId, deletedAt: row.deletedAt })
  ) {
    redirect(`/community/${row.id}`);
  }
  const photos = await listFreeBoardPhotos(prisma, row.id);
  return (
    <div className="course-report-page free-board-page">
      <h1 className="ui-page-title">글 수정</h1>
      <FreeBoardForm mode="edit" initial={{ id: row.id, title: row.title, body: row.body, photos }} />
    </div>
  );
}
