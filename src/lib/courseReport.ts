import type { CourseReport, PrismaClient } from "@prisma/client";
import {
  COURSE_CODES,
  COURSE_LABELS,
  type CourseCode,
} from "@/lib/reservationParser";
import {
  COURSE_REPORT_BODY_MAX,
  COURSE_REPORT_CATEGORIES,
  COURSE_REPORT_CATEGORY_LABELS,
  COURSE_REPORT_HOLE_MAX,
  COURSE_REPORT_HOLE_MIN,
  COURSE_REPORT_STATUS_LABELS,
  COURSE_REPORT_STATUSES,
  COURSE_REPORT_TITLE_MAX,
  type CourseReportCategoryCode,
  type CourseReportStatusCode,
} from "@/lib/courseReportConstants";
import type { ResolvedAuthUser } from "@/lib/auth";

export class CourseReportValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "CourseReportValidationError";
  }
}

export type CourseReportPublic = {
  id: number;
  authorUserId: number;
  authorCaddyId: number | null;
  authorDisplayName: string;
  title: string;
  body: string;
  course: CourseCode;
  courseLabel: string;
  hole: number | null;
  category: CourseReportCategoryCode;
  categoryLabel: string;
  status: CourseReportStatusCode;
  statusLabel: string;
  handlerUserId: number | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  photoCount: number;
};

export type CourseReportWriteFields = {
  title: string;
  body: string;
  course: CourseCode;
  hole: number | null;
  category: CourseReportCategoryCode;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function readTrimmedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CourseReportValidationError("invalid_field", "문자열이 필요합니다.");
  }
  return value.trim();
}

export function isCourseReportCourse(value: string): value is CourseCode {
  return (COURSE_CODES as readonly string[]).includes(value);
}

export function parseCourseReportCourse(value: unknown): CourseCode {
  if (typeof value !== "string" || !isCourseReportCourse(value)) {
    throw new CourseReportValidationError("invalid_course", "코스를 선택해 주세요.");
  }
  return value;
}

export function parseCourseReportHole(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < COURSE_REPORT_HOLE_MIN || value > COURSE_REPORT_HOLE_MAX) {
      throw new CourseReportValidationError("invalid_hole", "홀은 비우거나 1~18만 가능합니다.");
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^(?:[1-9]|1[0-8])$/.test(trimmed)) {
      throw new CourseReportValidationError("invalid_hole", "홀은 비우거나 1~18만 가능합니다.");
    }
    return Number(trimmed);
  }
  throw new CourseReportValidationError("invalid_hole", "홀은 비우거나 1~18만 가능합니다.");
}

export function parseCourseReportCategory(value: unknown): CourseReportCategoryCode {
  if (
    typeof value !== "string" ||
    !(COURSE_REPORT_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new CourseReportValidationError("invalid_category", "분류를 선택해 주세요.");
  }
  return value as CourseReportCategoryCode;
}

export function parseCourseReportStatus(value: unknown): CourseReportStatusCode {
  if (
    typeof value !== "string" ||
    !(COURSE_REPORT_STATUSES as readonly string[]).includes(value)
  ) {
    throw new CourseReportValidationError("invalid_status", "상태를 선택해 주세요.");
  }
  return value as CourseReportStatusCode;
}

export function parseCourseReportStatusFilter(
  value: string | null | undefined
): CourseReportStatusCode | null {
  if (!value) return null;
  if (!(COURSE_REPORT_STATUSES as readonly string[]).includes(value)) return null;
  return value as CourseReportStatusCode;
}

function parseTitle(value: unknown, required: boolean): string | undefined {
  const title = readTrimmedString(value);
  if (title === undefined) {
    if (required) throw new CourseReportValidationError("invalid_title", "제목을 입력해 주세요.");
    return undefined;
  }
  if (!title) throw new CourseReportValidationError("invalid_title", "제목을 입력해 주세요.");
  if (title.length > COURSE_REPORT_TITLE_MAX) {
    throw new CourseReportValidationError("invalid_title", "제목이 너무 깁니다.");
  }
  return title;
}

function parseBody(value: unknown, required: boolean): string | undefined {
  const body = readTrimmedString(value);
  if (body === undefined) {
    if (required) throw new CourseReportValidationError("invalid_body", "내용을 입력해 주세요.");
    return undefined;
  }
  if (!body) throw new CourseReportValidationError("invalid_body", "내용을 입력해 주세요.");
  if (body.length > COURSE_REPORT_BODY_MAX) {
    throw new CourseReportValidationError("invalid_body", "내용이 너무 깁니다.");
  }
  return body;
}

export function parseCourseReportCreateBody(body: unknown): CourseReportWriteFields {
  if (!isRecord(body)) {
    throw new CourseReportValidationError("invalid_body", "요청 본문이 올바르지 않습니다.");
  }
  return {
    title: parseTitle(body.title, true)!,
    body: parseBody(body.body ?? body.content, true)!,
    course: parseCourseReportCourse(body.course),
    hole: parseCourseReportHole(body.hole),
    category: parseCourseReportCategory(body.category),
  };
}

export function parseCourseReportUpdateBody(
  body: unknown
): Partial<CourseReportWriteFields> {
  if (!isRecord(body)) {
    throw new CourseReportValidationError("invalid_body", "요청 본문이 올바르지 않습니다.");
  }
  const next: Partial<CourseReportWriteFields> = {};
  if (body.title !== undefined) next.title = parseTitle(body.title, true)!;
  if (body.body !== undefined || body.content !== undefined) {
    next.body = parseBody(body.body ?? body.content, true)!;
  }
  if (body.course !== undefined) next.course = parseCourseReportCourse(body.course);
  if (body.hole !== undefined) next.hole = parseCourseReportHole(body.hole);
  if (body.category !== undefined) next.category = parseCourseReportCategory(body.category);
  if (Object.keys(next).length === 0) {
    throw new CourseReportValidationError("invalid_body", "수정할 항목이 없습니다.");
  }
  return next;
}

export function parseCourseReportStatusBody(body: unknown): CourseReportStatusCode {
  if (!isRecord(body)) {
    throw new CourseReportValidationError("invalid_status", "상태를 선택해 주세요.");
  }
  return parseCourseReportStatus(body.status);
}

export function toCourseReportPublic(
  row: CourseReport,
  photoCount = 0
): CourseReportPublic {
  const course = isCourseReportCourse(row.course) ? row.course : "VERTHILL";
  const category = (
    COURSE_REPORT_CATEGORIES as readonly string[]
  ).includes(row.category)
    ? (row.category as CourseReportCategoryCode)
    : "OTHER";
  const status = (COURSE_REPORT_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as CourseReportStatusCode)
    : "RECEIVED";
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    authorCaddyId: row.authorCaddyId,
    authorDisplayName: row.authorDisplayName,
    title: row.title,
    body: row.body,
    course,
    courseLabel: COURSE_LABELS[course],
    hole: row.hole,
    category,
    categoryLabel: COURSE_REPORT_CATEGORY_LABELS[category],
    status,
    statusLabel: COURSE_REPORT_STATUS_LABELS[status],
    handlerUserId: row.handlerUserId,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    photoCount,
  };
}

export async function resolveCourseReportAuthorSnapshot(
  db: PrismaClient,
  auth: ResolvedAuthUser
): Promise<{
  authorUserId: number;
  authorCaddyId: number | null;
  authorDisplayName: string;
}> {
  if (auth.userId == null) {
    throw new CourseReportValidationError(
      "author_required",
      "작성자 계정이 필요합니다.",
      403
    );
  }
  let displayName = auth.username;
  if (auth.caddyId != null) {
    const caddy = await db.caddy.findUnique({
      where: { id: auth.caddyId },
      select: { name: true },
    });
    if (caddy?.name) displayName = caddy.name;
  }
  return {
    authorUserId: auth.userId,
    authorCaddyId: auth.caddyId,
    authorDisplayName: displayName,
  };
}

export function resolvedAtForStatus(
  status: CourseReportStatusCode,
  now = new Date()
): Date | null {
  return status === "RESOLVED" ? now : null;
}
