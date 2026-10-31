import { redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canComposeFreeBoard } from "@/lib/freeBoard";
import FreeBoardForm from "../FreeBoardForm";

export const dynamic = "force-dynamic";

export default async function NewFreeBoardPostPage() {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/community/new");
  if (!canComposeFreeBoard(auth)) redirect("/community");
  return (
    <div className="course-report-page free-board-page">
      <h1 className="ui-page-title">글쓰기</h1>
      <FreeBoardForm />
    </div>
  );
}
