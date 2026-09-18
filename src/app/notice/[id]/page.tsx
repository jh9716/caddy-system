import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import dayjs from "dayjs";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { loadNoticeViewer } from "@/lib/noticeAccess";
import {
  canViewNotice,
  formatNoticeTargetLabel,
} from "@/lib/noticeTarget";
import NoticeDetailActions from "@/components/notice/NoticeDetailActions";
import NoticePushNotifyCard from "@/components/notice/NoticePushNotifyCard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NoticeDetailPage({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/notice");

  const resolved = await Promise.resolve(params);
  const id = Number(resolved.id);
  if (!Number.isFinite(id)) notFound();

  const notice = await prisma.notice.findUnique({ where: { id } });
  if (!notice) notFound();

  const viewer = await loadNoticeViewer(prisma, auth);
  if (!canViewNotice(notice, viewer)) notFound();

  const isAdmin = auth.role === "admin";
  const content = notice.content ?? "";

  return (
    <div className="notice-page notice-detail">
      <Link href="/notice" className="ui-btn ui-btn-ghost notice-back">
        ← 목록
      </Link>
      <div className="notice-detail-badges">
        {notice.important ? <span className="notice-badge notice-badge-important">중요</span> : null}
        {notice.pinned ? <span className="notice-badge notice-badge-pinned">고정</span> : null}
      </div>
      <h1 className="ui-page-title">{notice.title}</h1>
      <p className="notice-detail-meta">
        {dayjs(notice.createdAt).format("YYYY-MM-DD HH:mm")}
        <span> · {formatNoticeTargetLabel(notice)}</span>
      </p>
      <div className="notice-detail-body">{content || "내용이 없습니다."}</div>
      {isAdmin ? (
        <>
          <NoticeDetailActions id={id} />
          <NoticePushNotifyCard noticeId={id} />
        </>
      ) : null}
    </div>
  );
}
