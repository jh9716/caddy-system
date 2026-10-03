import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import {
  matchesChatUserQuery,
  sanitizeChatUserHit,
  toChatUserSearchHit,
  type ChatUserRow,
} from "@/lib/chatUsers";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (shouldForcePasswordChange(auth)) {
      return mustChangePasswordResponse();
    }
    await issueChatAccessToken(prisma, auth);
    const q = String(req.nextUrl.searchParams.get("q") || "").trim().slice(0, 40);
    if (q.length < 1) {
      return NextResponse.json({ ok: true, users: [] });
    }
    const rows = (await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        caddy: {
          select: { name: true, team: true, employmentStatus: true },
        },
      },
      take: 80,
    })) as ChatUserRow[];
    const users = rows
      .filter((row) => matchesChatUserQuery(row, q))
      .map((row) => toChatUserSearchHit(row))
      .filter((hit): hit is NonNullable<typeof hit> => hit != null)
      .map(sanitizeChatUserHit)
      .slice(0, 20);
    return NextResponse.json({ ok: true, users });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[GET /api/chat/users]", e);
    return NextResponse.json({ error: "chat_users_failed" }, { status: 500 });
  }
}
