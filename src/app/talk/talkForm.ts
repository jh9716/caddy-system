import type { FreeBoardFormBoard } from "@/app/community/FreeBoardForm";
import { COMMUNITY_FREE_BOARD_API, COMMUNITY_FREE_BOARD_PATH } from "@/lib/communityBoardConstants";

/** 가배치표 작성 폼을 자유게시판 경로·문구로 재사용 (직렬화 가능한 값만). */
export const TALK_FORM_BOARD: FreeBoardFormBoard = {
  apiBase: COMMUNITY_FREE_BOARD_API,
  pageBase: COMMUNITY_FREE_BOARD_PATH,
  titlePlaceholder: "제목을 입력해 주세요",
  bodyPlaceholder: "내용을 입력해 주세요",
  submitLabel: "등록",
  requiredNote: "제목과 내용을 입력해 주세요.",
  partialSavedNoun: "글",
};
