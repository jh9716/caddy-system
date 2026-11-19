import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { formatKstDisplay } from "@/lib/kstDate";
import { formatNoticeAuthorDisplay } from "@/lib/noticeAuthor";
import { loadNoticeViewer } from "@/lib/noticeAccess";
import {
  canViewNotice,
  formatNoticeTargetLabel,
} from "@/lib/noticeTarget";
import {
  NOTICE_PUBLISH_ALWAYS_PERIOD_LABEL,
  NOTICE_PUBLISH_STATUS_LABELS,
} from "@/lib/noticeConstants";
import { noticePublishStatus } from "@/lib/noticePublishWindow";
import { listNoticePhotos } from "@/lib/noticePhoto";
import { listNoticeFiles } from "@/lib/noticeFile";
import NoticeDetailActions from "@/components/notice/NoticeDetailActions";
import NoticeFileList from "@/components/notice/NoticeFileList";
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
  const files = await listNoticeFiles(prisma, id);
  const hasWindow = Boolean(notice.publishStartAt || notice.publishEndAt);
  const publishStatus = noticePublishStatus(notice);

  return (
    <div className="notice-page notice-detail">
      <Link href="/notice" className="ui-btn ui-btn-ghost notice-back">
        ← 목록
      </Link>
      <div className="notice-detail-badges">
        {isAdmin ? (
          <span className={`notice-badge notice-badge-publish is-${publishStatus}`}>
            {NOTICE_PUBLISH_STATUS_LABELS[publishStatus]}
          </span>
        ) : null}
        {notice.important ? <span className="notice-badge notice-badge-important">중요공지</span> : null}
        {notice.pinned ? <span className="notice-badge notice-badge-pinned">상단고정</span> : null}
      </div>
      <h1 className="ui-page-title">{notice.title}</h1>
      <dl className="notice-detail-meta-list">
        <div>
          <dt>작성자</dt>
          <dd>{formatNoticeAuthorDisplay(notice.author)}</dd>
        </div>
        <div>
          <dt>작성일</dt>
          <dd>{formatKstDisplay(notice.createdAt, "ymd-hm")}</dd>
        </div>
        <div>
          <dt>게시 대상</dt>
          <dd>{formatNoticeTargetLabel(notice)}</dd>
        </div>
        <div>
          <dt>게시 기간</dt>
          <dd>
            {hasWindow
              ? `${
                  notice.publishStartAt
                    ? formatKstDisplay(notice.publishStartAt, "ymd-hm")
                    : "시작 없음"
                } ~ ${
                  notice.publishEndAt
                    ? formatKstDisplay(notice.publishEndAt, "ymd-hm")
                    : "종료 없음"
                }`
              : NOTICE_PUBLISH_ALWAYS_PERIOD_LABEL}
          </dd>
        </div>
      </dl>
      <div className="notice-detail-body">{content || "내용이 없습니다."}</div>
      <NoticePhotoGallery noticeId={id} photos={photos} />
      <NoticeFileList noticeId={id} files={files} />
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
