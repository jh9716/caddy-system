import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (shouldForcePasswordChange(auth)) {
      return mustChangePasswordResponse();
    }
    const issued = await issueChatAccessToken(prisma, auth);
    return NextResponse.json({
      ok: true,
      token: issued.token,
      exp: issued.exp,
      ttlSec: issued.ttlSec,
      user: issued.user,
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[POST /api/chat/token]", e);
    return NextResponse.json({ error: "chat_token_failed" }, { status: 500 });
  }
}
