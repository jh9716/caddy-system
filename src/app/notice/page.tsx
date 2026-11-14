import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { formatKstDisplay } from "@/lib/kstDate";
import { loadNoticeViewer } from "@/lib/noticeAccess";
import { isNoticePhotoTableMissing } from "@/lib/noticePhoto";
import { isNoticeFileTableMissing } from "@/lib/noticeFile";
import { formatNoticeAuthorDisplay } from "@/lib/noticeAuthor";
import {
  adminNoticePublishWhere,
  formatNoticeTargetLabel,
  noticeListOrder,
  visibleNoticeWhere,
} from "@/lib/noticeTarget";
import {
  NOTICE_PUBLISH_FILTER_LABELS,
  NOTICE_PUBLISH_FILTERS,
  NOTICE_TARGET_ALL,
} from "@/lib/noticeConstants";
import {
  noticePublishStatus,
  parseNoticePublishFilter,
} from "@/lib/noticePublishWindow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noticeListSelect = {
  id: true,
  title: true,
  author: true,
  createdAt: true,
  important: true,
  pinned: true,
  targetType: true,
  targetValue: true,
  publishStartAt: true,
  publishEndAt: true,
} as const;

export default async function NoticeListPage({
  searchParams,
}: {
  searchParams?: Promise<{ publish?: string }> | { publish?: string };
}) {
  const auth = await getRequestAuthUser();
  if (!auth) return null;
  const viewer = await loadNoticeViewer(prisma, auth);
  const isAdmin = auth.role === "admin";
  const resolved = await Promise.resolve(searchParams ?? {});
  const publishFilter = isAdmin
    ? parseNoticePublishFilter(resolved.publish)
    : "all";
  const where = isAdmin
    ? adminNoticePublishWhere(publishFilter)
    : visibleNoticeWhere(viewer);

  let notices: Array<{
    id: number;
    title: string;
    author: string | null;
    createdAt: Date;
    important: boolean;
    pinned: boolean;
    targetType: string;
    targetValue: string | null;
    publishStartAt: Date | null;
    publishEndAt: Date | null;
    photoCount: number;
    fileCount: number;
  }>;
  try {
    const rows = await prisma.notice.findMany({
      where,
      select: {
        ...noticeListSelect,
        _count: { select: { photos: true, files: true } },
      },
      orderBy: noticeListOrder(),
      take: 80,
    });
    notices = rows.map(({ _count, ...row }) => ({
      ...row,
      photoCount: _count.photos,
      fileCount: _count.files,
    }));
  } catch (e) {
    if (isNoticeFileTableMissing(e) && !isNoticePhotoTableMissing(e)) {
      const rows = await prisma.notice.findMany({
        where,
        select: {
          ...noticeListSelect,
          _count: { select: { photos: true } },
        },
        orderBy: noticeListOrder(),
        take: 80,
      });
      notices = rows.map(({ _count, ...row }) => ({
        ...row,
        photoCount: _count.photos,
        fileCount: 0,
      }));
    } else if (isNoticePhotoTableMissing(e) || isNoticeFileTableMissing(e)) {
      const rows = await prisma.notice.findMany({
        where,
        select: noticeListSelect,
        orderBy: noticeListOrder(),
        take: 80,
      });
      notices = rows.map((row) => ({ ...row, photoCount: 0, fileCount: 0 }));
    } else {
      throw e;
    }
  }

  const emptyLabel =
    publishFilter === "ended"
      ? "종료된 공지가 없습니다."
      : publishFilter === "scheduled"
        ? "예약된 공지가 없습니다."
        : publishFilter === "live"
          ? "게시 중인 공지가 없습니다."
          : "등록된 공지가 없습니다.";

  return (
    <div className="notice-page">
      <div className="notice-page-head">
        <h1 className="ui-page-title">공지</h1>
        {isAdmin && (
          <Link href="/notice/new" className="ui-btn ui-btn-primary">
            새 공지
          </Link>
        )}
      </div>

      {isAdmin ? (
        <div className="notice-publish-filters" role="tablist" aria-label="게시 상태">
          {NOTICE_PUBLISH_FILTERS.map((code) => {
            const href = code === "all" ? "/notice" : `/notice?publish=${code}`;
            return (
              <Link
                key={code}
                href={href}
                className={`notice-publish-chip${publishFilter === code ? " is-active" : ""}`}
              >
                {NOTICE_PUBLISH_FILTER_LABELS[code]}
              </Link>
            );
          })}
        </div>
      ) : null}

      <ul className="notice-list">
        {notices.map((n) => {
          const status = isAdmin
            ? noticePublishStatus({
                publishStartAt: n.publishStartAt,
                publishEndAt: n.publishEndAt,
              })
            : null;
          return (
            <li key={n.id}>
              <Link className="notice-list-row" href={`/notice/${n.id}`}>
                <div className="notice-list-title-row">
                  {status ? (
                    <span className={`notice-badge notice-badge-publish is-${status}`}>
                      {NOTICE_PUBLISH_FILTER_LABELS[status]}
                    </span>
                  ) : null}
                  {n.important ? <span className="notice-badge notice-badge-important">중요</span> : null}
                  {n.pinned ? <span className="notice-badge notice-badge-pinned">고정</span> : null}
                  {n.photoCount > 0 ? (
                    <span className="notice-badge notice-badge-photo">사진 {n.photoCount}</span>
                  ) : null}
                  {n.fileCount > 0 ? (
                    <span className="notice-badge notice-badge-file">첨부 {n.fileCount}</span>
                  ) : null}
                  <span className="notice-list-title">{n.title}</span>
                </div>
                <div className="notice-list-meta">
                  <span>{formatNoticeAuthorDisplay(n.author)}</span>
                  <time>{formatKstDisplay(n.createdAt, "ymd")}</time>
                  {n.targetType !== NOTICE_TARGET_ALL ? (
                    <span>{formatNoticeTargetLabel(n)}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
        {notices.length === 0 && (
          <li className="notice-empty">{emptyLabel}</li>
        )}
      </ul>
    </div>
  );
}
