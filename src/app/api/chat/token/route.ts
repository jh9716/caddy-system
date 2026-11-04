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
import { currentChatAppEnv } from "@/lib/chatAppEnv";
import { chatTokenServerTiming, isChatEntryTimingEnabledFor } from "@/lib/chatEntryTiming";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const t0 = performance.now();
    const auth = await resolveAuthUser(req);
    const t1 = performance.now();
    if (!auth) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (shouldForcePasswordChange(auth)) {
      return mustChangePasswordResponse();
    }
    const issued = await issueChatAccessToken(prisma, auth);
    const t2 = performance.now();
    const res = NextResponse.json({
      ok: true,
      token: issued.token,
      exp: issued.exp,
      ttlSec: issued.ttlSec,
      user: issued.user,
    });
    try {
      if (isChatEntryTimingEnabledFor(currentChatAppEnv(), process.env.NODE_ENV)) {
        res.headers.set("Server-Timing", chatTokenServerTiming(t1 - t0, t2 - t1));
      }
    } catch {
      // timing only
    }
    return res;
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
