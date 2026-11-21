/**
 * 커뮤니티 자유게시판 V1 (server-only).
 *
 * 권한
 * - 읽기·작성·댓글: 로그인한 정상 계정 admin / leader(조장) / caddy.
 *   (resolveAuthUser 가 서명·sessionVersion·퇴사(RETIRED) 차단, 미연결 캐디·조장은 denyUnlinkedStaff 로 차단)
 * - 수정: 작성자 본인만 (관리자도 타인 글 수정 불가).
 * - 삭제: 작성자 본인 또는 관리자(부적절한 글 관리).
 * - 작성자 id 는 항상 서버 세션에서만 가져온다 (요청 본문의 authorUserId 등은 무시).
 *
 * 데이터: CommunityPost(boardType=FREE) 만 사용. 가배치표(FreeBoardPost)는 읽지도 쓰지도 않는다.
 */
import { NextRequest, NextResponse } from "next/server";
import { Prisma, type CommunityPost, type PrismaClient } from "@prisma/client";
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
import { resolveFreeBoardActor } from "@/lib/freeBoard";
import {
  COMMUNITY_BODY_MAX,
  COMMUNITY_PAGE_SIZE,
  COMMUNITY_SEARCH_MAX,
  COMMUNITY_TITLE_MAX,
  isCommunityFreeBoardEnabled,
  type CommunityListPage,
  type CommunityPostListItem,
  type CommunityPostPublic,
} from "@/lib/communityBoardConstants";

/** 이번 V1 에서 다루는 유일한 게시판 종류. */
export const COMMUNITY_FREE_BOARD_TYPE = "FREE" as const;

export class CommunityValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "CommunityValidationError";
  }
}

type Viewer = { role: ResolvedAuthUser["role"] | null | undefined; userId: number | null };

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

export function canReadCommunity(role: ResolvedAuthUser["role"] | null | undefined): boolean {
  return role === "admin" || role === "leader" || role === "caddy";
}

/** 글쓰기: 세 역할 모두 가능. DB User.id 가 확인된 경우만. */
export function canComposeCommunity(auth: Viewer): boolean {
  return canReadCommunity(auth.role) && isPositiveInt(auth.userId);
}

/** 수정: 작성자 본인만. 관리자도 다른 사람 글은 수정할 수 없다. */
export function canEditCommunityPost(input: Viewer & { authorUserId: number; deletedAt: Date | null }): boolean {
  if (input.deletedAt) return false;
  if (!canReadCommunity(input.role)) return false;
  return isPositiveInt(input.userId) && input.userId === input.authorUserId;
}

/** 삭제: 작성자 본인 또는 관리자. */
export function canDeleteCommunityPost(input: Viewer & { authorUserId: number; deletedAt: Date | null }): boolean {
  if (input.deletedAt) return false;
  if (input.role === "admin") return true;
  if (!canReadCommunity(input.role)) return false;
  return isPositiveInt(input.userId) && input.userId === input.authorUserId;
}

/** 새 테이블이 아직 없는 DB(마이그레이션 미적용)에서 나는 오류인지. 화면에서 안내 문구로 바꾼다. */
export function isCommunityTableMissing(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2021" || e.code === "P2022")) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /Community(Post|Photo|BoardType)/.test(msg) && /does not exist|relation|table|type/i.test(msg);
}

export function communityUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "community_unavailable", message: "자유게시판을 준비 중입니다. 잠시 후 다시 시도해 주세요." },
    { status: 503 }
  );
}

export function communityDisabledResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function isCommunityAuthResponse(v: ResolvedAuthUser | NextResponse): v is NextResponse {
  return v instanceof NextResponse;
}

/**
 * 모든 /api/talk handler 진입 가드 (기존 인증 경로 재사용, 우회 없음).
 * flag OFF → 404, 비로그인/권한 없음/퇴사 → 401, 비밀번호 변경 강제 → 기존 응답, 미연결 직원 → 403.
 */
export async function requireCommunityReader(req: NextRequest): Promise<ResolvedAuthUser | NextResponse> {
  if (!isCommunityFreeBoardEnabled()) return communityDisabledResponse();
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadCommunity(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
  const unlinked = denyUnlinkedStaff(auth);
  if (unlinked) return unlinked;
  return auth;
}

/**
 * env 전용 관리자(userId=null)는 기존 가배치표와 같은 방식으로 DB 관리자 User 에 연결한다.
 * 연결 실패 시 읽기는 가능하지만 작성·수정은 불가 (userId=null 유지).
 */
export async function resolveCommunityActor(db: PrismaClient, auth: ResolvedAuthUser): Promise<ResolvedAuthUser> {
  return resolveFreeBoardActor(db, auth).catch(() => auth);
}

function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  // 평문만 저장. HTML 은 해석하지 않고 React 텍스트로만 출력한다 (XSS 방지).
  return input.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

/** 제목·본문 검증. 그 밖의 필드(authorUserId 등)는 읽지 않는다. */
export function parseCommunityPostBody(input: unknown): { title: string; body: string } {
  const obj = (input && typeof input === "object" ? input : {}) as { title?: unknown; body?: unknown };
  const title = cleanText(obj.title).replace(/\n+/g, " ");
  const body = cleanText(obj.body);
  if (!title) throw new CommunityValidationError("title_required", "제목을 입력해 주세요.");
  if (title.length > COMMUNITY_TITLE_MAX) {
    throw new CommunityValidationError("title_too_long", `제목은 ${COMMUNITY_TITLE_MAX}자 이하로 입력해 주세요.`);
  }
  if (!body) throw new CommunityValidationError("body_required", "내용을 입력해 주세요.");
  if (body.length > COMMUNITY_BODY_MAX) {
    throw new CommunityValidationError("body_too_long", `내용은 ${COMMUNITY_BODY_MAX}자 이하로 입력해 주세요.`);
  }
  return { title, body };
}

/** 검색어: 앞뒤 공백 제거, 최대 길이, 제어문자 제거. */
export function normalizeCommunitySearch(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, COMMUNITY_SEARCH_MAX);
}

export function normalizeCommunityPage(input: unknown): number {
  const n = Number(typeof input === "string" ? input : input ?? 1);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, 10000);
}

/** 작성자 표시명 snapshot: 연결 캐디 이름 우선, 없으면 username. 서버 세션 기준. */
export async function resolveCommunityAuthorSnapshot(
  db: PrismaClient,
  auth: ResolvedAuthUser
): Promise<{ authorUserId: number; authorDisplayName: string }> {
  if (!canComposeCommunity(auth) || auth.userId == null) {
    throw new CommunityValidationError("author_required", "작성자 계정이 필요합니다.", 403);
  }
  let displayName = auth.username;
  if (auth.caddyId != null) {
    const caddy = await db.caddy.findUnique({ where: { id: auth.caddyId }, select: { name: true } });
    if (caddy?.name) displayName = caddy.name;
  }
  return { authorUserId: auth.userId, authorDisplayName: displayName };
}

export function toCommunityPostPublic(
  row: CommunityPost,
  viewer: Viewer,
  counts: { photoCount?: number; commentCount?: number } = {}
): CommunityPostPublic {
  const perm = { role: viewer.role, userId: viewer.userId, authorUserId: row.authorUserId, deletedAt: row.deletedAt };
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
    commentCount: counts.commentCount ?? 0,
    isMine: isPositiveInt(viewer.userId) && viewer.userId === row.authorUserId,
    canEdit: canEditCommunityPost(perm),
    canDelete: canDeleteCommunityPost(perm),
  };
}

/** 살아있는 자유게시판 글만 (다른 boardType·삭제글 제외). */
export async function findLiveCommunityPost(db: PrismaClient | Prisma.TransactionClient, id: number) {
  if (!isPositiveInt(id)) return null;
  return db.communityPost.findFirst({ where: { id, boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null } });
}

function searchWhere(q: string): Prisma.CommunityPostWhereInput {
  const where: Prisma.CommunityPostWhereInput = { boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null };
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { body: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

/** 최신순 + 페이지네이션 + 제목·본문 검색. */
export async function listCommunityPosts(
  db: PrismaClient,
  viewer: Viewer,
  input: { q?: unknown; page?: unknown; pageSize?: number } = {}
): Promise<CommunityListPage> {
  const q = normalizeCommunitySearch(input.q);
  const pageSize = input.pageSize && input.pageSize > 0 ? Math.min(input.pageSize, 50) : COMMUNITY_PAGE_SIZE;
  const where = searchWhere(q);
  const total = await db.communityPost.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(normalizeCommunityPage(input.page), totalPages);
  const rows = await db.communityPost.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { _count: { select: { photos: true } } },
  });
  const commentCounts = await countCommunityComments(
    db,
    rows.map((r) => r.id)
  );
  const posts: CommunityPostListItem[] = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { body: _body, ...rest } = toCommunityPostPublic(row, viewer, {
      photoCount: row._count.photos,
      commentCount: commentCounts.get(row.id) ?? 0,
    });
    return rest;
  });
  return { posts, page, pageSize, total, totalPages, q };
}

/** 게시글별 살아있는 댓글 수 (soft-deleted 제외). COMMUNITY_POST thread 만 센다. */
export async function countCommunityComments(db: PrismaClient, postIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (postIds.length === 0) return out;
  const threads = await db.commentThread.findMany({
    where: { targetType: "COMMUNITY_POST", targetKey: { in: postIds.map(String) } },
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
