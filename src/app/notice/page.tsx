import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { formatKstDisplay } from "@/lib/kstDate";
import { loadNoticeViewer } from "@/lib/noticeAccess";
import { isNoticePhotoTableMissing } from "@/lib/noticePhoto";
import {
  formatNoticeTargetLabel,
  noticeListOrder,
  visibleNoticeWhere,
} from "@/lib/noticeTarget";
import { NOTICE_TARGET_ALL } from "@/lib/noticeConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NoticeListPage() {
  const auth = await getRequestAuthUser();
  if (!auth) return null;
  const viewer = await loadNoticeViewer(prisma, auth);

  let notices: Array<{
    id: number;
    title: string;
    createdAt: Date;
    important: boolean;
    pinned: boolean;
    targetType: string;
    targetValue: string | null;
    photoCount: number;
  }>;
  try {
    const rows = await prisma.notice.findMany({
      where: visibleNoticeWhere(viewer),
      select: {
        id: true,
        title: true,
        createdAt: true,
        important: true,
        pinned: true,
        targetType: true,
        targetValue: true,
        _count: { select: { photos: true } },
      },
      orderBy: noticeListOrder(),
      take: 80,
    });
    notices = rows.map(({ _count, ...row }) => ({
      ...row,
      photoCount: _count.photos,
    }));
  } catch (e) {
    if (!isNoticePhotoTableMissing(e)) throw e;
    const rows = await prisma.notice.findMany({
      where: visibleNoticeWhere(viewer),
      select: {
        id: true,
        title: true,
        createdAt: true,
        important: true,
        pinned: true,
        targetType: true,
        targetValue: true,
      },
      orderBy: noticeListOrder(),
      take: 80,
    });
    notices = rows.map((row) => ({ ...row, photoCount: 0 }));
  }

  return (
    <div className="notice-page">
      <div className="notice-page-head">
        <h1 className="ui-page-title">공지</h1>
        {auth.role === "admin" && (
          <Link href="/notice/new" className="ui-btn ui-btn-primary">
            새 공지
          </Link>
        )}
      </div>

      <ul className="notice-list">
        {notices.map((n) => (
          <li key={n.id}>
            <Link className="notice-list-row" href={`/notice/${n.id}`}>
              <div className="notice-list-title-row">
                {n.important ? <span className="notice-badge notice-badge-important">중요</span> : null}
                {n.pinned ? <span className="notice-badge notice-badge-pinned">고정</span> : null}
                {n.photoCount > 0 ? (
                  <span className="notice-badge notice-badge-photo">사진 {n.photoCount}</span>
                ) : null}
                <span className="notice-list-title">{n.title}</span>
              </div>
              <div className="notice-list-meta">
                <time>{formatKstDisplay(n.createdAt, "ymd")}</time>
                {n.targetType !== NOTICE_TARGET_ALL ? (
                  <span>{formatNoticeTargetLabel(n)}</span>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
        {notices.length === 0 && (
          <li className="notice-empty">등록된 공지가 없습니다.</li>
        )}
      </ul>
    </div>
  );
}
