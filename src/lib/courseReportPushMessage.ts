import { COURSE_LABELS, type CourseCode } from "@/lib/reservationParser";
import {
  COURSE_REPORT_CATEGORY_LABELS,
  COURSE_REPORT_STATUS_LABELS,
  type CourseReportCategoryCode,
  type CourseReportStatusCode,
} from "@/lib/courseReportConstants";
import {
  COURSE_REPORT_PUSH_BODY_MAX,
  COURSE_REPORT_PUSH_TITLE_NEW,
  COURSE_REPORT_PUSH_TITLE_STATUS,
} from "@/lib/courseReportPushConstants";

export function courseReportPushUrl(reportId: number): string {
  return `/course-reports/${reportId}`;
}

export function courseReportPushTagNew(reportId: number): string {
  return `course-report:${reportId}:new`;
}

export function courseReportPushTagStatus(reportId: number): string {
  return `course-report:${reportId}:status`;
}

function clip(text: string, max = COURSE_REPORT_PUSH_BODY_MAX): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

export function formatCourseReportNewPushBody(input: {
  category: string;
  course: string;
  title: string;
}): string {
  const category =
    COURSE_REPORT_CATEGORY_LABELS[input.category as CourseReportCategoryCode] ??
    input.category;
  const course =
    COURSE_LABELS[input.course as CourseCode] ?? input.course;
  return clip(`${category} · ${course} · ${input.title}`);
}

export function formatCourseReportStatusPushBody(input: {
  status: string;
  title: string;
}): string {
  const status =
    COURSE_REPORT_STATUS_LABELS[input.status as CourseReportStatusCode] ??
    input.status;
  return clip(`${status} · ${input.title}`);
}

export function buildCourseReportNewPushPayload(input: {
  reportId: number;
  category: string;
  course: string;
  title: string;
}): { title: string; body: string; url: string; tag: string } {
  return {
    title: COURSE_REPORT_PUSH_TITLE_NEW,
    body: formatCourseReportNewPushBody(input),
    url: courseReportPushUrl(input.reportId),
    tag: courseReportPushTagNew(input.reportId),
  };
}

export function buildCourseReportStatusPushPayload(input: {
  reportId: number;
  status: string;
  title: string;
}): { title: string; body: string; url: string; tag: string } {
  return {
    title: COURSE_REPORT_PUSH_TITLE_STATUS,
    body: formatCourseReportStatusPushBody(input),
    url: courseReportPushUrl(input.reportId),
    tag: courseReportPushTagStatus(input.reportId),
  };
}
