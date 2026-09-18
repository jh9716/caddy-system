import type { CaddyType, Prisma } from "@prisma/client";
import { DRIVING_POOL_TEAM, isPrimaryTeam } from "@/lib/caddyManage";
import {
  NOTICE_CADDY_TYPES,
  NOTICE_LIST_ORDER,
  NOTICE_TARGET_ALL,
  NOTICE_TARGET_CADDY_TYPE,
  NOTICE_TARGET_TEAM,
  NOTICE_TARGET_TYPES,
  type NoticeTargetType,
} from "@/lib/noticeConstants";
import type { AppRole } from "@/lib/sessionCookies";

export class NoticeValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message);
    this.name = "NoticeValidationError";
  }
}

export type NoticeTargetFields = {
  targetType: string;
  targetValue: string | null;
};

export type NoticePublishFields = {
  publishStartAt: Date | null;
  publishEndAt: Date | null;
};

export type NoticeViewer = {
  role: AppRole;
  caddyId: number | null;
  caddyType: string | null;
  team: string | null;
};

export function isNoticeTargetType(v: string): v is NoticeTargetType {
  return (NOTICE_TARGET_TYPES as readonly string[]).includes(v);
}

export function isNoticeCaddyType(v: string): boolean {
  return (NOTICE_CADDY_TYPES as readonly string[]).includes(v);
}

export function isNoticeTeamValue(team: string): boolean {
  const t = String(team ?? "").trim();
  return isPrimaryTeam(t) || t === DRIVING_POOL_TEAM;
}

export function parseNoticeTarget(input: {
  targetType?: unknown;
  targetValue?: unknown;
}): NoticeTargetFields {
  const rawType = String(input.targetType ?? NOTICE_TARGET_ALL)
    .trim()
    .toUpperCase();
  if (!isNoticeTargetType(rawType)) {
    throw new NoticeValidationError(
      "invalid_target",
      "대상 유형이 올바르지 않습니다."
    );
  }
  if (rawType === NOTICE_TARGET_ALL) {
    return { targetType: NOTICE_TARGET_ALL, targetValue: null };
  }
  const rawValue = String(input.targetValue ?? "").trim();
  if (rawType === NOTICE_TARGET_CADDY_TYPE) {
    const v = rawValue.toUpperCase();
    if (!isNoticeCaddyType(v)) {
      throw new NoticeValidationError(
        "invalid_target",
        "캐디구분 대상이 올바르지 않습니다."
      );
    }
    return { targetType: NOTICE_TARGET_CADDY_TYPE, targetValue: v };
  }
  if (!isNoticeTeamValue(rawValue)) {
    throw new NoticeValidationError("invalid_target", "조 대상이 올바르지 않습니다.");
  }
  return { targetType: NOTICE_TARGET_TEAM, targetValue: rawValue };
}

export function parseOptionalDateTime(
  v: unknown
): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new NoticeValidationError("invalid_datetime", "날짜 형식이 올바르지 않습니다.");
  }
  return d;
}

export function parseNoticePublishWindow(input: {
  publishStartAt?: unknown;
  publishEndAt?: unknown;
}): {
  publishStartAt?: Date | null;
  publishEndAt?: Date | null;
} {
  const publishStartAt = parseOptionalDateTime(input.publishStartAt);
  const publishEndAt = parseOptionalDateTime(input.publishEndAt);
  const out: {
    publishStartAt?: Date | null;
    publishEndAt?: Date | null;
  } = {};
  if (publishStartAt !== undefined) out.publishStartAt = publishStartAt;
  if (publishEndAt !== undefined) out.publishEndAt = publishEndAt;
  const start = publishStartAt === undefined ? undefined : publishStartAt;
  const end = publishEndAt === undefined ? undefined : publishEndAt;
  if (start && end && start.getTime() > end.getTime()) {
    throw new NoticeValidationError(
      "invalid_window",
      "게시 시작일이 종료일보다 늦을 수 없습니다."
    );
  }
  return out;
}

/** PATCH/POST both accept schema `content` and legacy form `body`. */
export function readNoticeContent(body: Record<string, unknown>): string | undefined {
  if (body.content !== undefined) return String(body.content ?? "");
  if (body.body !== undefined) return String(body.body ?? "");
  return undefined;
}

export function isNoticeInPublishWindow(
  notice: NoticePublishFields,
  now: Date = new Date()
): boolean {
  if (notice.publishStartAt && notice.publishStartAt.getTime() > now.getTime()) {
    return false;
  }
  if (notice.publishEndAt && notice.publishEndAt.getTime() < now.getTime()) {
    return false;
  }
  return true;
}

export function matchesNoticeTarget(
  notice: NoticeTargetFields,
  viewer: NoticeViewer
): boolean {
  if (viewer.role === "admin") return true;
  const t = String(notice.targetType ?? NOTICE_TARGET_ALL).trim().toUpperCase();
  if (t === NOTICE_TARGET_ALL) return true;
  if (t === NOTICE_TARGET_CADDY_TYPE) {
    return Boolean(viewer.caddyType) && viewer.caddyType === notice.targetValue;
  }
  if (t === NOTICE_TARGET_TEAM) {
    return Boolean(viewer.team) && viewer.team === notice.targetValue;
  }
  return false;
}

export function canViewNotice(
  notice: NoticeTargetFields & NoticePublishFields,
  viewer: NoticeViewer,
  now: Date = new Date()
): boolean {
  if (viewer.role === "admin") return true;
  return isNoticeInPublishWindow(notice, now) && matchesNoticeTarget(notice, viewer);
}

export function visibleNoticeWhere(
  viewer: NoticeViewer,
  now: Date = new Date()
): Prisma.NoticeWhereInput {
  if (viewer.role === "admin") return {};
  const targetOr: Prisma.NoticeWhereInput[] = [
    { targetType: NOTICE_TARGET_ALL },
  ];
  if (viewer.caddyType) {
    targetOr.push({
      targetType: NOTICE_TARGET_CADDY_TYPE,
      targetValue: viewer.caddyType,
    });
  }
  if (viewer.team) {
    targetOr.push({
      targetType: NOTICE_TARGET_TEAM,
      targetValue: viewer.team,
    });
  }
  return {
    AND: [
      {
        OR: [{ publishStartAt: null }, { publishStartAt: { lte: now } }],
      },
      {
        OR: [{ publishEndAt: null }, { publishEndAt: { gte: now } }],
      },
      { OR: targetOr },
    ],
  };
}

export function noticeListOrder(): typeof NOTICE_LIST_ORDER {
  return NOTICE_LIST_ORDER;
}

export function formatNoticeTargetLabel(notice: NoticeTargetFields): string {
  const t = String(notice.targetType ?? NOTICE_TARGET_ALL).trim().toUpperCase();
  if (t === NOTICE_TARGET_ALL) return "전체";
  if (t === NOTICE_TARGET_CADDY_TYPE) {
    return `캐디구분 · ${notice.targetValue ?? ""}`;
  }
  if (t === NOTICE_TARGET_TEAM) {
    return `조 · ${notice.targetValue ?? ""}`;
  }
  return t;
}

export type NoticeWriteFields = {
  title?: string;
  content?: string;
  important?: boolean;
  pinned?: boolean;
  targetType?: string;
  targetValue?: string | null;
  publishStartAt?: Date | null;
  publishEndAt?: Date | null;
  author?: string;
};

export function parseNoticeWriteBody(
  body: unknown,
  mode: "create" | "update"
): NoticeWriteFields {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const out: NoticeWriteFields = {};

  if (mode === "create" || rec.title !== undefined) {
    const title = String(rec.title ?? "").trim();
    if (!title) {
      throw new NoticeValidationError("invalid_title", "제목은 필수입니다.");
    }
    out.title = title;
  }

  const content = readNoticeContent(rec);
  if (mode === "create") {
    out.content = content ?? "";
  } else if (content !== undefined) {
    out.content = content;
  }

  if (mode === "create" || rec.important !== undefined) {
    out.important = Boolean(rec.important);
  }
  if (mode === "create" || rec.pinned !== undefined) {
    out.pinned = Boolean(rec.pinned);
  }

  if (
    mode === "create" ||
    rec.targetType !== undefined ||
    rec.targetValue !== undefined
  ) {
    const target = parseNoticeTarget({
      targetType: rec.targetType,
      targetValue: rec.targetValue,
    });
    out.targetType = target.targetType;
    out.targetValue = target.targetValue;
  }

  const window = parseNoticePublishWindow({
    publishStartAt: rec.publishStartAt,
    publishEndAt: rec.publishEndAt,
  });
  if (mode === "create") {
    out.publishStartAt = window.publishStartAt ?? null;
    out.publishEndAt = window.publishEndAt ?? null;
  } else {
    if (window.publishStartAt !== undefined) out.publishStartAt = window.publishStartAt;
    if (window.publishEndAt !== undefined) out.publishEndAt = window.publishEndAt;
  }

  if (typeof rec.author === "string") {
    out.author = rec.author;
  }

  return out;
}

export function caddyTargetWhere(
  notice: NoticeTargetFields
): Prisma.CaddyWhereInput {
  const t = String(notice.targetType ?? NOTICE_TARGET_ALL).trim().toUpperCase();
  const base: Prisma.CaddyWhereInput = {
    employmentStatus: { in: ["ACTIVE", "LEAVE"] },
  };
  if (t === NOTICE_TARGET_ALL) return base;
  if (t === NOTICE_TARGET_CADDY_TYPE && notice.targetValue) {
    return { ...base, caddyType: notice.targetValue as CaddyType };
  }
  if (t === NOTICE_TARGET_TEAM && notice.targetValue) {
    return { ...base, team: notice.targetValue };
  }
  return { ...base, id: { in: [] } };
}
