/**
 * CourseReport Web Push V1 copy + guards.
 * Safe for client + server. No VAPID, no web-push, no endpoints.
 * Idempotency: Prisma Audit, not CourseReport.pushSentAt.
 */

export const COURSE_REPORT_PUSH_TITLE_NEW = "새 코스 제보";
export const COURSE_REPORT_PUSH_TITLE_STATUS = "코스 제보 상태 변경";
export const COURSE_REPORT_PUSH_CONCURRENCY = 12;
export const COURSE_REPORT_PUSH_AUDIT_ACTION = "COURSE_REPORT_PUSH_SEND";
export const COURSE_REPORT_PUSH_AUDIT_ENTITY = "CourseReport";
/** pg_advisory_xact_lock namespace (int4). Second key is reportId. */
export const COURSE_REPORT_PUSH_LOCK_NS = 1630001;
export const COURSE_REPORT_PUSH_BODY_MAX = 80;
