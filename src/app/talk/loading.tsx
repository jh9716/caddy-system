import { COMMUNITY_FREE_BOARD_LABEL } from "@/lib/communityBoardConstants";

/** 로딩 상태: 목록 모양 그대로 회색 줄 표시 (빈 게시판·오류와 구분). */
export default function TalkLoading() {
  return (
    <div className="course-report-page talk-page" aria-busy="true" aria-live="polite">
      <div className="talk-head">
        <h1 className="ui-page-title">{COMMUNITY_FREE_BOARD_LABEL}</h1>
      </div>
      <div className="talk-toolbar">
        <div className="vh-skel talk-skel-search" />
      </div>
      <ul className="talk-list" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="talk-row is-skeleton">
            <div className="vh-skel talk-skel-title" />
            <div className="vh-skel talk-skel-meta" />
          </li>
        ))}
      </ul>
      <p className="vh-sr-only">{COMMUNITY_FREE_BOARD_LABEL} 불러오는 중</p>
    </div>
  );
}
