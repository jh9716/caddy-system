import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  COMMUNITY_FREE_BOARD_TYPE,
  CommunityValidationError,
  canComposeCommunity,
  communityUnavailableResponse,
  isCommunityAuthResponse,
  isCommunityTableMissing,
  listCommunityPosts,
  parseCommunityPostBody,
  requireCommunityReader,
  resolveCommunityActor,
  resolveCommunityAuthorSnapshot,
  toCommunityPostPublic,
} from "@/lib/communityBoard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 목록: 최신순, ?q= 제목·본문 검색, ?page= 페이지. */
export async function GET(req: NextRequest) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const actor = await resolveCommunityActor(prisma, auth);
  try {
    const sp = req.nextUrl.searchParams;
    const page = await listCommunityPosts(prisma, actor, { q: sp.get("q") ?? "", page: sp.get("page") ?? "1" });
    return NextResponse.json({ ...page, canCompose: canComposeCommunity(actor) });
  } catch (e) {
    if (isCommunityTableMissing(e)) return communityUnavailableResponse();
    throw e;
  }
}

/** 글쓰기: 관리자·조장·캐디. 작성자는 세션에서만 결정 (요청의 authorUserId 등은 무시). */
export async function POST(req: NextRequest) {
  const auth = await requireCommunityReader(req);
  if (isCommunityAuthResponse(auth)) return auth;
  const payload = await req.json().catch(() => ({}));
  try {
    const actor = await resolveCommunityActor(prisma, auth);
    const parsed = parseCommunityPostBody(payload);
    const author = await resolveCommunityAuthorSnapshot(prisma, actor);
    const created = await prisma.communityPost.create({
      data: { ...author, boardType: COMMUNITY_FREE_BOARD_TYPE, title: parsed.title, body: parsed.body },
    });
    return NextResponse.json({ ok: true, id: created.id, post: toCommunityPostPublic(created, actor) }, { status: 201 });
  } catch (e) {
    if (e instanceof CommunityValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (isCommunityTableMissing(e)) return communityUnavailableResponse();
    throw e;
  }
}
