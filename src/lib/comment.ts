import { Prisma } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import { COMMENT_BODY_MAX } from "@/lib/commentConstants";

export class CommentValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "CommentValidationError";
  }
}

export function isCommentTableMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return (
    /Comment(Thread)?/i.test(msg) && /does not exist|relation|table/i.test(msg)
  );
}

export function isCommentUniqueConflict(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export function parseCommentBody(input: unknown): string {
  if (typeof input !== "string") {
    throw new CommentValidationError("empty", "댓글을 입력해 주세요.", 400);
  }
  // Plain text only: trim + null-byte strip. Do not HTML-parse/sanitize/mutate.
  // React text children escape on render.
  const body = input.replace(/\u0000/g, "").trim();
  if (!body) {
    throw new CommentValidationError("empty", "댓글을 입력해 주세요.", 400);
  }
  if (body.length > COMMENT_BODY_MAX) {
    throw new CommentValidationError(
      "too_long",
      `댓글은 ${COMMENT_BODY_MAX}자 이하로 입력해 주세요.`,
      400
    );
  }
  return body;
}

export function canComposeComment(auth: {
  role: ResolvedAuthUser["role"] | null | undefined;
  userId: number | null;
}): boolean {
  const role = auth.role;
  if (role !== "admin" && role !== "caddy" && role !== "leader") return false;
  return (
    typeof auth.userId === "number" &&
    Number.isInteger(auth.userId) &&
    auth.userId > 0
  );
}

export function canSoftDeleteComment(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  deletedAt: Date | null;
}): boolean {
  if (input.deletedAt) return false;
  if (input.role === "admin") return true;
  return input.userId != null && input.userId === input.authorUserId;
}

export function resolveCommentAuthorDisplayName(author: {
  username: string;
  caddy: { name: string | null } | null;
}): string {
  const fromCaddy = author.caddy?.name?.trim();
  if (fromCaddy) return fromCaddy;
  return author.username;
}

export type CommentPublic = {
  id: number;
  authorUserId: number | null;
  authorDisplayName: string | null;
  body: string | null;
  deleted: boolean;
  createdAt: string;
  canDelete: boolean;
};

export function toCommentPublic(
  row: {
    id: number;
    authorUserId: number;
    body: string;
    deletedAt: Date | null;
    createdAt: Date;
    author: { username: string; caddy: { name: string | null } | null };
  },
  viewer: { role: ResolvedAuthUser["role"]; userId: number | null }
): CommentPublic {
  const deleted = row.deletedAt != null;
  if (deleted) {
    return {
      id: row.id,
      authorUserId: null,
      authorDisplayName: null,
      body: null,
      deleted: true,
      createdAt: row.createdAt.toISOString(),
      canDelete: false,
    };
  }
  return {
    id: row.id,
    authorUserId: row.authorUserId,
    authorDisplayName: resolveCommentAuthorDisplayName(row.author),
    body: row.body,
    deleted: false,
    createdAt: row.createdAt.toISOString(),
    canDelete: canSoftDeleteComment({
      role: viewer.role,
      userId: viewer.userId,
      authorUserId: row.authorUserId,
      deletedAt: row.deletedAt,
    }),
  };
}
