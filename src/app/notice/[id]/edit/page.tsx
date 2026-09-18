import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveAuthFromCookieStore } from "@/lib/auth";
import NewNoticeForm from "@/app/notice/new/ui/NewNoticeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function EditNoticePage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth || auth.role !== "admin") redirect("/login");
  if (auth.mustChangePassword) redirect("/change-password");

  const resolved = await Promise.resolve(params);
  const id = Number(resolved.id);
  if (!Number.isFinite(id)) notFound();

  const notice = await prisma.notice.findUnique({ where: { id } });
  if (!notice) {
    return (
      <div className="notice-page">
        <p>존재하지 않는 공지입니다.</p>
      </div>
    );
  }

  return (
    <div className="notice-page">
      <h1 className="ui-page-title">공지 수정</h1>
      <NewNoticeForm
        mode="edit"
        initial={{
          id,
          title: notice.title,
          body: notice.content ?? "",
          important: notice.important,
          pinned: notice.pinned,
          targetType: notice.targetType,
          targetValue: notice.targetValue,
          publishStartAt: notice.publishStartAt
            ? notice.publishStartAt.toISOString()
            : null,
          publishEndAt: notice.publishEndAt
            ? notice.publishEndAt.toISOString()
            : null,
        }}
      />
    </div>
  );
}
