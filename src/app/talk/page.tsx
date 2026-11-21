import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import {
  canComposeCommunity,
  isCommunityTableMissing,
  listCommunityPosts,
  resolveCommunityActor,
} from "@/lib/communityBoard";
import {
  COMMUNITY_FREE_BOARD_LABEL,
  COMMUNITY_FREE_BOARD_PATH,
  COMMUNITY_SEARCH_MAX,
  communityListHref,
  communityPostHref,
  type CommunityListPage,
} from "@/lib/communityBoardConstants";
import { formatTalkListTime } from "./talkTime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** 페이지 번호 묶음 (최대 5개). */
function pageWindow(page: number, totalPages: number): number[] {
  const size = 5;
  const start = Math.max(1, Math.min(page - 2, totalPages - size + 1));
  const end = Math.min(totalPages, start + size - 1);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

export default async function TalkListPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const auth = await getRequestAuthUser();
  if (!auth) return null;
  const sp = (await Promise.resolve(searchParams)) ?? {};
  const actor = await resolveCommunityActor(prisma, auth);
  const canCompose = canComposeCommunity(actor);
  let data: CommunityListPage | null = null;
  let unavailable = false;
  try {
    data = await listCommunityPosts(prisma, actor, { q: first(sp.q), page: first(sp.page) || "1" });
  } catch (e) {
    if (!isCommunityTableMissing(e)) throw e;
    unavailable = true;
  }
  const q = data?.q ?? "";
  const now = new Date();

  return (
    <div className="course-report-page talk-page">
      <div className="talk-head">
        <h1 className="ui-page-title">{COMMUNITY_FREE_BOARD_LABEL}</h1>
        {canCompose && !unavailable ? (
          <Link href={`${COMMUNITY_FREE_BOARD_PATH}/new`} className="ui-btn ui-btn-primary talk-write-btn">
            글쓰기
          </Link>
        ) : null}
      </div>

      <form className="talk-toolbar" action={COMMUNITY_FREE_BOARD_PATH} method="get" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          maxLength={COMMUNITY_SEARCH_MAX}
          placeholder="제목·내용 검색"
          aria-label="제목·내용 검색"
          className="ui-input talk-search-input"
          enterKeyHint="search"
        />
        <button type="submit" className="ui-btn ui-btn-ghost talk-search-btn">
          검색
        </button>
      </form>

      {unavailable ? (
        <div className="talk-state is-error" role="alert">
          <p className="talk-state-title">자유게시판을 준비 중입니다.</p>
          <p className="talk-state-desc">잠시 후 다시 확인해 주세요.</p>
        </div>
      ) : data && data.posts.length === 0 ? (
        <div className="talk-state is-empty">
          {q ? (
            <>
              <p className="talk-state-title">&lsquo;{q}&rsquo; 검색 결과가 없습니다.</p>
              <Link href={COMMUNITY_FREE_BOARD_PATH} className="ui-btn ui-btn-ghost talk-touch">
                전체 글 보기
              </Link>
            </>
          ) : (
            <>
              <p className="talk-state-title">아직 글이 없습니다.</p>
              <p className="talk-state-desc">첫 글을 남겨 보세요.</p>
            </>
          )}
        </div>
      ) : data ? (
        <>
          {q ? (
            <p className="talk-result-note">
              &lsquo;{q}&rsquo; 검색 결과 {data.total}건 ·{" "}
              <Link href={COMMUNITY_FREE_BOARD_PATH}>전체 보기</Link>
            </p>
          ) : null}
          <ul className="talk-list">
            {data.posts.map((row) => (
              <li key={row.id}>
                <Link className="talk-row" href={communityPostHref(row.id)}>
                  <span className="talk-row-title">
                    <span className="talk-row-title-text">{row.title}</span>
                    {row.photoCount > 0 ? (
                      <span className="talk-photo-icon" role="img" aria-label={`사진 ${row.photoCount}장`} title="사진 첨부">
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                          <rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                          <circle cx="5.5" cy="6.5" r="1.3" fill="currentColor" />
                          <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                        </svg>
                      </span>
                    ) : null}
                    {row.commentCount > 0 ? (
                      <span className="talk-comment-count" aria-label={`댓글 ${row.commentCount}개`}>
                        [{row.commentCount}]
                      </span>
                    ) : null}
                  </span>
                  <span className="talk-row-meta">
                    <span className="talk-row-author">{row.authorDisplayName}</span>
                    <time dateTime={row.createdAt}>{formatTalkListTime(row.createdAt, now)}</time>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {data.totalPages > 1 ? (
            <nav className="talk-pager" aria-label="페이지">
              {data.page > 1 ? (
                <Link className="talk-page-link" href={communityListHref({ q, page: data.page - 1 })} aria-label="이전 페이지">
                  ‹
                </Link>
              ) : (
                <span className="talk-page-link is-disabled" aria-hidden="true">‹</span>
              )}
              {pageWindow(data.page, data.totalPages).map((n) =>
                n === data!.page ? (
                  <span key={n} className="talk-page-link is-current" aria-current="page">
                    {n}
                  </span>
                ) : (
                  <Link key={n} className="talk-page-link" href={communityListHref({ q, page: n })}>
                    {n}
                  </Link>
                )
              )}
              {data.page < data.totalPages ? (
                <Link className="talk-page-link" href={communityListHref({ q, page: data.page + 1 })} aria-label="다음 페이지">
                  ›
                </Link>
              ) : (
                <span className="talk-page-link is-disabled" aria-hidden="true">›</span>
              )}
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
