/**
 * Board published Web Push V1 copy + guards.
 * Safe for client + server. No VAPID, no web-push, no endpoints.
 */

export const BOARD_PUSH_CONFIRM = "SEND_BOARD_PUSH";
export const BOARD_PUSH_TITLE = "VERTHILL 배치표 안내";
export const BOARD_PUSH_BODY_SUFFIX =
  "배치표가 게시되었습니다. 앱에서 근무 일정을 확인해 주세요.";
export const BOARD_PUSH_STALE_MESSAGE =
  "현재 작업본과 게시본이 다릅니다. 배치표를 다시 게시한 뒤 알림을 보내세요.";
export const BOARD_PUSH_STALE_UI_LABEL = "게시본이 오래되었습니다.";
export const BOARD_PUSH_NO_PUBLISHED_MESSAGE = "게시된 배치표가 없습니다.";
export const BOARD_PUSH_ALREADY_SENT_MESSAGE =
  "이 게시본에는 이미 배치표 알림을 보냈습니다.";
export const BOARD_PUSH_CONCURRENCY = 12;
export const BOARD_PUSH_AUDIT_ACTION = "BOARD_PUSH_SEND";
export const BOARD_PUSH_AUDIT_ENTITY = "DailyBoardPublished";
/** pg_advisory_xact_lock namespace (int4). Date key is YYYYMMDD. */
export const BOARD_PUSH_LOCK_NS = 1610001;
