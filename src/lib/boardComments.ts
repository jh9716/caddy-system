import { NextRequest, NextResponse } from "next/server";
import type { CommentTargetType, Prisma, PrismaClient } from "@prisma/client";
import {
  authUnavailableResponse,
  canReadPublishedBoard,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
  type ResolvedAuthUser,
} from "@/lib/auth";
import { COMMENT_TARGET } from "@/lib/commentConstants";
import {
  CommentValidationError,
  canComposeComment,
  createCommentByTarget,
  listCommentsByTarget,
  softDeleteCommentByTarget,
  type CommentPublic,
} from "@/lib/commentThread";
import {
  getDailyBoardPublished,
  type DailyBoardPublishedDb,
} from "@/lib/dailyBoardPublishedService";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { clearSessionCookies } from "@/lib/sessionCookies";

export { CommentValidationError, canComposeComment };
export type { CommentPublic };

export function isBoardCommentAuthResponse(
  v: ResolvedAuthUser | NextResponse
): v is NextResponse {
  return v instanceof NextResponse;
}

export function parseBoardCommentDate(raw: unknown): string {
  if (typeof raw !== "string" || !isStrictYmd(raw)) {
    throw new CommentValidationError("invalid_date", "date=YYYY-MM-DD 필요", 400);
  }
  return raw;
}

function isStrictYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

async function requirePublishedBoardDate(
  db: PrismaClient | Prisma.TransactionClient,
  ymd: string
) {
  const published = await getDailyBoardPublished(
    ymd,
    db as unknown as DailyBoardPublishedDb
  );
  if (!published) {
    throw new CommentValidationError(
      "board_not_published",
      "공개된 배치표가 없습니다.",
      404
    );
  }
  return published;
}

function boardDateTarget(ymd: string) {
  return {
    targetType: COMMENT_TARGET.BOARD_DATE as CommentTargetType,
    targetKey: ymd,
  };
}

/**
 * Login required: admin / caddy / leader (published board reader).
 * Unauth → 401. RETIRED already null from resolveAuthUser.
 */
export async function requireBoardCommentReader(
  req: NextRequest
): Promise<ResolvedAuthUser | NextResponse> {
  let auth: ResolvedAuthUser | null;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth || !canReadPublishedBoard(auth.role)) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!auth) clearSessionCookies(res, req);
    return res;
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
  return auth;
}

export async function listBoardDateComments(
  db: PrismaClient,
  ymd: string,
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): Promise<CommentPublic[]> {
  const date = parseBoardCommentDate(ymd);
  const { targetType, targetKey } = boardDateTarget(date);
  return listCommentsByTarget(db, targetType, targetKey, viewer, (client) =>
    requirePublishedBoardDate(client, date)
  );
}

export async function createBoardDateComment(
  db: PrismaClient,
  ymd: string,
  auth: ResolvedAuthUser,
  rawBody: unknown
): Promise<CommentPublic> {
  const date = parseBoardCommentDate(ymd);
  const { targetType, targetKey } = boardDateTarget(date);
  return createCommentByTarget(
    db,
    targetType,
    targetKey,
    auth,
    rawBody,
    (client) => requirePublishedBoardDate(client, date)
  );
}

export async function softDeleteBoardDateComment(
  db: PrismaClient,
  ymd: string,
  commentId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  const date = parseBoardCommentDate(ymd);
  const { targetType, targetKey } = boardDateTarget(date);
  return softDeleteCommentByTarget(
    db,
    targetType,
    targetKey,
    commentId,
    auth,
    (client) => requirePublishedBoardDate(client, date)
  );
}
