export const COMMENT_BODY_MAX = 1000;
export const COMMENT_DELETED_PLACEHOLDER = "삭제된 댓글입니다.";

export const COMMENT_TARGET = {
  COURSE_REPORT: "COURSE_REPORT",
  BOARD_DATE: "BOARD_DATE",
  NOTICE: "NOTICE",
} as const;

export type CommentTargetTypeCode =
  (typeof COMMENT_TARGET)[keyof typeof COMMENT_TARGET];
