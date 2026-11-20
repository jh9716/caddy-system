"use client";

import { COMMUNITY_FREE_BOARD_LABEL } from "@/lib/communityBoardConstants";

/** 오류 상태: 빈 게시판과 다른 안내 + 다시 시도. 오류 상세는 화면에 출력하지 않는다. */
export default function TalkError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="course-report-page talk-page">
      <div className="talk-head">
        <h1 className="ui-page-title">{COMMUNITY_FREE_BOARD_LABEL}</h1>
      </div>
      <div className="talk-state is-error" role="alert">
        <p className="talk-state-title">게시판을 불러오지 못했습니다.</p>
        <p className="talk-state-desc">잠시 후 다시 시도해 주세요.</p>
        <button type="button" className="ui-btn ui-btn-ghost talk-touch" onClick={() => reset()}>
          다시 시도
        </button>
      </div>
    </div>
  );
}
