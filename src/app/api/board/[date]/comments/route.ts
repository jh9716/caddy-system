import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CommentValidationError,
  canComposeCommentAs,
  createBoardDateComment,
  isBoardCommentAuthResponse,
  listBoardDateComments,
  requireBoardCommentReader,
} from "@/lib/boardComments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function boardDate(
  params: Promise<{ date: string }> | { date: string }
): Promise<string> {
  const resolved = await Promise.resolve(params);
  return resolved.date;
}

function fail(e: unknown) {
  if (e instanceof CommentValidationError) {
    return NextResponse.json(
      { error: e.code, message: e.message },
      { status: e.status }
    );
  }
  throw e;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> | { date: string } }
) {
  const auth = await requireBoardCommentReader(req);
  if (isBoardCommentAuthResponse(auth)) return auth;
  try {
    const comments = await listBoardDateComments(
      prisma,
      await boardDate(params),
      auth
    );
    return NextResponse.json({
      comments,
      canCompose: await canComposeCommentAs(prisma, auth),
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> | { date: string } }
) {
  const auth = await requireBoardCommentReader(req);
  if (isBoardCommentAuthResponse(auth)) return auth;
  const payload = await req.json().catch(() => ({}));
  try {
    const comment = await createBoardDateComment(
      prisma,
      await boardDate(params),
      auth,
      payload && typeof payload === "object"
        ? (payload as { body?: unknown }).body
        : payload
    );
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
