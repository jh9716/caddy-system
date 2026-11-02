import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canComposeFreeBoard, resolveFreeBoardActor } from "@/lib/freeBoard";
import { isFreeBoardEnabled } from "@/lib/freeBoardConstants";
import FreeBoardForm from "../FreeBoardForm";

export const dynamic = "force-dynamic";

export default async function NewFreeBoardPostPage() {
  if (!isFreeBoardEnabled()) notFound();
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/community/new");
  const actor = await resolveFreeBoardActor(prisma, auth).catch(() => auth);
  if (!canComposeFreeBoard(actor)) redirect("/community");
  return (
    <div className="course-report-page free-board-page">
      <h1 className="ui-page-title">가배치표 올리기</h1>
      <FreeBoardForm />
    </div>
  );
}
