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
  "예약 게시 공지는 현재 게시 시각 자동 푸시를 지원하지 않으며 게시 시작 이후 상세에서 수동 발송할 수 있습니다.";

export const NOTICE_PUBLISH_MODES = ["always", "today", "range", "scheduled"] as const;
export type NoticePublishMode = (typeof NOTICE_PUBLISH_MODES)[number];

export const NOTICE_PUBLISH_MODE_LABELS: Record<NoticePublishMode, string> = {
  always: "계속 게시",
  today: "오늘만",
  range: "기간 지정",
  scheduled: "예약 게시",
};

export const NOTICE_PUBLISH_MODE_HINTS: Record<NoticePublishMode, string> = {
  always: "기한을 두지 않습니다. 캐디에게 계속 보입니다.",
  today: "한국시간 오늘 하루만 보입니다. 내일 0시부터 숨겨집니다.",
  range: "시작일과 종료일을 고릅니다. 종료일은 그날 끝까지이며, 필요하면 시각을 직접 지정할 수 있습니다.",
  scheduled: "지정한 시작 시각부터 보입니다. 종료일은 비워도 됩니다.",
};

export const NOTICE_PUBLISH_STATUSES = ["live", "scheduled", "ended"] as const;
export type NoticePublishStatus = (typeof NOTICE_PUBLISH_STATUSES)[number];

export const NOTICE_PUBLISH_STATUS_LABELS: Record<NoticePublishStatus, string> = {
  live: "게시 중",
  scheduled: "예약",
  ended: "종료",
};

export const NOTICE_PUBLISH_FILTERS = ["all", "live", "scheduled", "ended"] as const;
export type NoticePublishFilter = (typeof NOTICE_PUBLISH_FILTERS)[number];

export const NOTICE_PUBLISH_FILTER_LABELS: Record<NoticePublishFilter, string> = {
  all: "전체",
  live: "게시 중",
  scheduled: "예약",
  ended: "종료",
};

export const NOTICE_PUBLISH_QUICK_RANGES = ["today", "3d", "7d", "month"] as const;
export type NoticePublishQuickRange = (typeof NOTICE_PUBLISH_QUICK_RANGES)[number];

export const NOTICE_PUBLISH_QUICK_RANGE_LABELS: Record<NoticePublishQuickRange, string> = {
  today: "오늘",
  "3d": "3일",
  "7d": "7일",
  month: "이번 달",
};

export const NOTICE_PUBLISH_CLEAR_LABEL = "날짜 지우기";
export const NOTICE_PUBLISH_ALWAYS_PERIOD_LABEL = "기한 없음";
export const NOTICE_PUBLISH_END_EXCLUSIVE_HINT =
  "종료일은 그날 하루가 끝날 때까지입니다. 다음날 0시부터 캐디에게 숨겨집니다.";
export const NOTICE_PUBLISH_CUSTOM_TIME_LABEL = "시각 직접 지정";
export const NOTICE_PUBLISH_INVALID_WINDOW_MESSAGE =
  "게시 시작 시각이 종료 시각과 같거나 더 늦을 수 없습니다. 종료를 더 뒤로 지정해 주세요.";

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
