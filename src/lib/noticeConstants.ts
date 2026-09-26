/**
 * Notice V2 + Notice Web Push V1 copy + guards.
 * Safe for client + server. No VAPID, no web-push, no endpoints.
 */

export const NOTICE_TARGET_ALL = "ALL";
export const NOTICE_TARGET_CADDY_TYPE = "CADDY_TYPE";
export const NOTICE_TARGET_TEAM = "TEAM";

export const NOTICE_TARGET_TYPES = [
  NOTICE_TARGET_ALL,
  NOTICE_TARGET_CADDY_TYPE,
  NOTICE_TARGET_TEAM,
] as const;

export type NoticeTargetType = (typeof NOTICE_TARGET_TYPES)[number];

export const NOTICE_CADDY_TYPES = ["HOUSE", "THIRD", "DRIVING"] as const;
export type NoticeCaddyType = (typeof NOTICE_CADDY_TYPES)[number];

export const NOTICE_PUSH_CONFIRM = "SEND_NOTICE_PUSH";
export const NOTICE_PUSH_TITLE = "VERTHILL 새 공지";
export const NOTICE_PUSH_IMPORTANT_TITLE = "VERTHILL 중요 공지";
export const NOTICE_PUSH_ALREADY_SENT_MESSAGE =
  "이 공지에는 이미 알림을 보냈습니다.";
export const NOTICE_PUSH_DELIVERY_FAILED_MESSAGE =
  "알림 전달에 실패했습니다. 다시 보낼 수 있습니다.";
export const NOTICE_PUSH_OUTSIDE_WINDOW_MESSAGE =
  "게시 기간이 아닌 공지에는 알림을 보낼 수 없습니다.";
export const NOTICE_PUSH_CONFIRM_UI =
  "이 공지를 대상 캐디에게 푸시 알림으로 보냅니다.";
export const NOTICE_PUSH_SEND_BUTTON = "공지 푸시 알림 보내기";
export const NOTICE_PUSH_DONE_LABEL = "푸시 발송 완료";
export const NOTICE_CREATE_SEND_PUSH_LABEL = "등록과 동시에 푸시 알림 보내기";
export const NOTICE_EDIT_SEND_PUSH_LABEL = "수정 내용 푸시 알림 보내기";
export const NOTICE_SCHEDULED_PUSH_HINT =
  "예약 게시 공지는 현재 게시 시각 자동 푸시를 지원하지 않으며 게시 후 수동 발송할 수 있습니다.";

export const NOTICE_PUSH_CONCURRENCY = 12;
export const NOTICE_PUSH_AUDIT_ACTION = "NOTICE_PUSH_SEND";
export const NOTICE_PUSH_AUDIT_ENTITY = "Notice";
/** pg_advisory_xact_lock namespace (int4). Second key is noticeId. */
export const NOTICE_PUSH_LOCK_NS = 1620001;

export const NOTICE_LIST_ORDER = [
  { pinned: "desc" as const },
  { important: "desc" as const },
  { createdAt: "desc" as const },
];
