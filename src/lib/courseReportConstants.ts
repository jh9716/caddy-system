import type { CourseReportCategory, CourseReportStatus } from "@prisma/client";

export const COURSE_REPORT_CATEGORIES = [
  "COURSE_CONDITION",
  "CART_PATH",
  "FACILITY",
  "SAFETY",
  "LOST_FOUND",
  "OTHER",
] as const satisfies readonly CourseReportCategory[];

export type CourseReportCategoryCode = (typeof COURSE_REPORT_CATEGORIES)[number];

export const COURSE_REPORT_CATEGORY_LABELS: Record<CourseReportCategoryCode, string> =
  {
    COURSE_CONDITION: "코스 상태",
    CART_PATH: "카트도로",
    FACILITY: "시설",
    SAFETY: "안전",
    LOST_FOUND: "분실물",
    OTHER: "기타",
  };

export const COURSE_REPORT_STATUSES = [
  "RECEIVED",
  "CHECKING",
  "RESOLVED",
] as const satisfies readonly CourseReportStatus[];

export type CourseReportStatusCode = (typeof COURSE_REPORT_STATUSES)[number];

export const COURSE_REPORT_STATUS_LABELS: Record<CourseReportStatusCode, string> = {
  RECEIVED: "접수",
  CHECKING: "확인중",
  RESOLVED: "처리완료",
};

export const COURSE_REPORT_TITLE_MAX = 120;
export const COURSE_REPORT_BODY_MAX = 4000;
export const COURSE_REPORT_HOLE_MIN = 1;
export const COURSE_REPORT_HOLE_MAX = 9;
export const COURSE_REPORT_HOLES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const COURSE_REPORT_HOLE_ERROR = "홀은 선택 안 함 또는 1~9만 가능합니다.";
export const COURSE_REPORT_LIST_TAKE = 200;
