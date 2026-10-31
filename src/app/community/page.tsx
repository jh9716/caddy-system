import Link from "next/link";
import dayjs from "dayjs";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canComposeFreeBoard, listFreeBoardPosts } from "@/lib/freeBoard";
import { FREE_BOARD_LIST_TAKE } from "@/lib/freeBoardConstants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CommunityListPage() {
  const auth = await getRequestAuthUser();
  if (!auth) return null;
  const posts = await listFreeBoardPosts(prisma, auth, FREE_BOARD_LIST_TAKE);
  const canCompose = canComposeFreeBoard(auth);

  return (
    <div className="course-report-page free-board-page">
      <div className="course-report-page-head">
        <h1 className="ui-page-title">자유게시판</h1>
        {canCompose ? (
          <Link href="/community/new" className="ui-btn ui-btn-primary course-report-compose-link">
            + 글쓰기
          </Link>
        ) : null}
      </div>
      <ul className="course-report-list">
        {posts.map((row) => (
          <li key={row.id}>
            <Link className="course-report-list-row" href={`/community/${row.id}`}>
              <div className="course-report-list-title-row">
                <span className="course-report-list-title">{row.title}</span>
                {row.commentCount ? (
                  <span className="free-board-comment-count" aria-label={`댓글 ${row.commentCount}개`}>
                    [{row.commentCount}]
                  </span>
                ) : null}
              </div>
              <div className="course-report-list-meta">
                <span>{row.authorDisplayName}</span>
                <time dateTime={row.createdAt}>{dayjs(row.createdAt).format("MM-DD HH:mm")}</time>
                {row.photoCount > 0 ? (
                  <span className="course-report-photo-count" aria-label={`사진 ${row.photoCount}장`}>
                    사진 {row.photoCount}
                  </span>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
        {posts.length === 0 && <li className="course-report-empty">등록된 글이 없습니다.</li>}
      </ul>
    </div>
  );
}
