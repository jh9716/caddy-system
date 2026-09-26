import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { formatKstDisplay } from "@/lib/kstDate";
import { loadNoticeViewer } from "@/lib/noticeAccess";
import {
  canViewNotice,
  formatNoticeTargetLabel,
} from "@/lib/noticeTarget";
import { listNoticePhotos } from "@/lib/noticePhoto";
import NoticeDetailActions from "@/components/notice/NoticeDetailActions";
import NoticePhotoGallery from "@/components/notice/NoticePhotoGallery";
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
  const photos = await listNoticePhotos(prisma, id);
  const hasWindow = Boolean(notice.publishStartAt || notice.publishEndAt);

  return (
    <div className="notice-page notice-detail">
      <Link href="/notice" className="ui-btn ui-btn-ghost notice-back">
        ← 목록
      </Link>
      <div className="notice-detail-badges">
        {notice.important ? <span className="notice-badge notice-badge-important">중요공지</span> : null}
        {notice.pinned ? <span className="notice-badge notice-badge-pinned">상단고정</span> : null}
      </div>
      <h1 className="ui-page-title">{notice.title}</h1>
      <dl className="notice-detail-meta-list">
        <div>
          <dt>작성일</dt>
          <dd>{formatKstDisplay(notice.createdAt, "ymd-hm")}</dd>
        </div>
        <div>
          <dt>게시 대상</dt>
          <dd>{formatNoticeTargetLabel(notice)}</dd>
        </div>
        {hasWindow ? (
          <div>
            <dt>게시 기간</dt>
            <dd>
              {notice.publishStartAt
                ? formatKstDisplay(notice.publishStartAt, "ymd-hm")
                : "시작 없음"}
              {" ~ "}
              {notice.publishEndAt
                ? formatKstDisplay(notice.publishEndAt, "ymd-hm")
                : "종료 없음"}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="notice-detail-body">{content || "내용이 없습니다."}</div>
      <NoticePhotoGallery noticeId={id} photos={photos} />
      {isAdmin ? (
        <>
          <NoticeDetailActions id={id} />
          <NoticePushNotifyCard
            noticeId={id}
            pushSentAt={notice.pushSentAt ? notice.pushSentAt.toISOString() : null}
          />
        </>
      ) : null}
    </div>
  );
}
