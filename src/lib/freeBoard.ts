import { NextRequest, NextResponse } from "next/server";
import type { FreeBoardPost, PrismaClient } from "@prisma/client";
import {
  authUnavailableResponse,
  denyUnlinkedStaff,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
  type ResolvedAuthUser,
} from "@/lib/auth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { clearSessionCookies } from "@/lib/sessionCookies";
import { resolveEnvAdminChatIdentity } from "@/lib/chatEnvAdminIdentity";
import {
  FREE_BOARD_BODY_MAX,
  FREE_BOARD_TITLE_MAX,
  isFreeBoardEnabled,
  type FreeBoardPostPublic,
} from "@/lib/freeBoardConstants";

export class FreeBoardValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "FreeBoardValidationError";
  }
}

export function canReadFreeBoard(role: ResolvedAuthUser["role"] | null | undefined): boolean {
  return role === "admin" || role === "caddy" || role === "leader";
}

/** 게시글 작성·수정·삭제·사진 관리는 관리자만. 작성에는 검증된 DB User.id가 필요하다. */
export function canComposeFreeBoard(auth: {
  role: ResolvedAuthUser["role"] | null | undefined;
  userId: number | null;
}): boolean {
  return (
    auth.role === "admin" &&
    typeof auth.userId === "number" &&
    Number.isInteger(auth.userId) &&
    auth.userId > 0
  );
}

/** 수정: 관리자면 작성자와 무관하게 가능. */
export function canEditFreeBoardPost(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  deletedAt: Date | null;
}): boolean {
  if (input.deletedAt) return false;
  return (
    input.role === "admin"
  );
}

/** 삭제: 관리자만. */
export function canDeleteFreeBoardPost(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  deletedAt: Date | null;
}): boolean {
  if (input.deletedAt) return false;
  return input.role === "admin";
}

/**
 * env-only 관리자(uid=null)를 서버에서 검증된 DB 관리자 User에 연결한다.
 * 명시 ADMIN_CHAT_USER_ID(관리자 검증) 또는 전용 username=admin 계정만 사용하며
 * 첫 관리자/클라이언트 id/표시명 추측은 하지 않는다.
 */
export async function resolveFreeBoardActor(
  db: PrismaClient,
  auth: ResolvedAuthUser
): Promise<ResolvedAuthUser> {
  if (auth.userId != null || auth.role !== "admin") return auth;
  const mapped = await resolveEnvAdminChatIdentity(db);
  if (!mapped.ok) {
    throw new FreeBoardValidationError(
      "free_board_admin_user_missing",
      "관리자 게시판 계정 연결이 필요합니다.",
      403
    );
  }
  return {
    ...auth,
    userId: mapped.value.userId,
    username: mapped.value.username,
    sessionVersion: mapped.value.sessionVersion,
    caddyId: mapped.value.caddyId,
  };
}

export function freeBoardDisabledResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function isFreeBoardAuthResponse(
  v: ResolvedAuthUser | NextResponse
): v is NextResponse {
  return v instanceof NextResponse;
}

/**
 * 모든 자유게시판 API 의 진입 가드.
 * flag OFF → 404, 비로그인/권한 없음 → 401, 비밀번호 변경 강제 → 기존 응답, 미연결 직원 → 기존 응답.
 */
export async function requireFreeBoardReader(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  if (!isFreeBoardEnabled()) return freeBoardDisabledResponse();
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadFreeBoard(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
  const unlinked = denyUnlinkedStaff(auth);
  if (unlinked) return unlinked;
  return auth;
}

function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\u0000/g, "").trim();
}

export function parseFreeBoardPostBody(input: unknown): { title: string; body: string } {
  const obj = (input && typeof input === "object" ? input : {}) as {
    title?: unknown;
    body?: unknown;
  };
  const title = cleanText(obj.title);
  const body = cleanText(obj.body);
  if (!title) throw new FreeBoardValidationError("title_required", "제목을 입력해 주세요.");
  if (title.length > FREE_BOARD_TITLE_MAX) {
    throw new FreeBoardValidationError(
      "title_too_long",
      `제목은 ${FREE_BOARD_TITLE_MAX}자 이하로 입력해 주세요.`
    );
  }
  if (!body) throw new FreeBoardValidationError("body_required", "내용을 입력해 주세요.");
  if (body.length > FREE_BOARD_BODY_MAX) {
    throw new FreeBoardValidationError(
      "body_too_long",
      `내용은 ${FREE_BOARD_BODY_MAX}자 이하로 입력해 주세요.`
    );
  }
  return { title, body };
}

export async function resolveFreeBoardAuthorSnapshot(
  db: PrismaClient,
  auth: ResolvedAuthUser
): Promise<{ authorUserId: number; authorDisplayName: string }> {
  if (!canComposeFreeBoard(auth) || auth.userId == null) {
    throw new FreeBoardValidationError("author_required", "작성자 계정이 필요합니다.", 403);
  }
  let displayName = auth.username;
  if (auth.caddyId != null) {
    const caddy = await db.caddy.findUnique({
      where: { id: auth.caddyId },
      select: { name: true },
    });
    if (caddy?.name) displayName = caddy.name;
  }
  return { authorUserId: auth.userId, authorDisplayName: displayName };
}

export function toFreeBoardPostPublic(
  row: FreeBoardPost,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null },
  counts: { photoCount?: number; commentCount?: number } = {}
): FreeBoardPostPublic {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    edited: row.updatedAt.getTime() - row.createdAt.getTime() > 1000,
    photoCount: counts.photoCount ?? 0,
    ...(counts.commentCount != null ? { commentCount: counts.commentCount } : {}),
    canEdit: canEditFreeBoardPost({
      role: viewer.role,
      userId: viewer.userId,
      authorUserId: row.authorUserId,
      deletedAt: row.deletedAt,
    }),
    canDelete: canDeleteFreeBoardPost({
      role: viewer.role,
      userId: viewer.userId,
      authorUserId: row.authorUserId,
      deletedAt: row.deletedAt,
    }),
  };
}

export async function findLiveFreeBoardPost(db: PrismaClient, id: number) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.freeBoardPost.findFirst({ where: { id, deletedAt: null } });
}

export async function listFreeBoardPosts(
  db: PrismaClient,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null },
  take: number
): Promise<FreeBoardPostPublic[]> {
  const rows = await db.freeBoardPost.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take,
    include: { _count: { select: { photos: true } } },
  });
  const commentCounts = await countFreeBoardComments(
    db,
    rows.map((r) => r.id)
  );
  return rows.map((row) =>
    toFreeBoardPostPublic(row, viewer, {
      photoCount: row._count.photos,
      commentCount: commentCounts.get(row.id) ?? 0,
    })
  );
}

/** 게시글별 살아있는 댓글 수 (soft-deleted 제외). */
export async function countFreeBoardComments(
  db: PrismaClient,
  postIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (postIds.length === 0) return out;
  const threads = await db.commentThread.findMany({
    where: { targetType: "FREE_BOARD_POST", targetKey: { in: postIds.map(String) } },
    select: { id: true, targetKey: true },
  });
  if (threads.length === 0) return out;
  const grouped = await db.comment.groupBy({
    by: ["threadId"],
    where: { threadId: { in: threads.map((t) => t.id) }, deletedAt: null },
    _count: { _all: true },
  });
  const byThread = new Map(grouped.map((g) => [g.threadId, g._count._all]));
  for (const t of threads) out.set(Number(t.targetKey), byThread.get(t.id) ?? 0);
  return out;
}
