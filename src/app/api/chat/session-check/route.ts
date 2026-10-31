import { NextRequest, NextResponse } from "next/server";
import { isAuthStoreUnavailable, isRetiredCaddySessionBlocked } from "@/lib/auth";
import { CHAT_SESSION_CHECK_PATH, verifyChatInternalRequest } from "@/lib/chatInternalAuth";
import {
  chatInternalDiagEnabled,
  diagnoseChatInternalRequest,
  formatChatInternalDiag,
} from "@/lib/chatInternalAuthDiag"; // TEMPORARY DIAGNOSTIC
import { evaluateChatSessionEpoch } from "@/lib/chatSessionEpoch";
import { normalizeAppRole } from "@/lib/sessionCookies";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await verifyChatInternalRequest(req, CHAT_SESSION_CHECK_PATH))) {
    // TEMPORARY DIAGNOSTIC — remove after Preview 403 diagnosis. Vercel Preview 에서만 (운영 미실행).
    if (chatInternalDiagEnabled()) {
      try {
        const d = await diagnoseChatInternalRequest(req, CHAT_SESSION_CHECK_PATH);
        console.log(formatChatInternalDiag(CHAT_SESSION_CHECK_PATH, false, d));
      } catch {
        // 진단 실패는 무시
      }
    }
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as {
    userId?: unknown;
    sv?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, code: "user_unavailable" }, { status: 401 });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        sessionVersion: true,
        caddyId: true,
        caddy: { select: { employmentStatus: true } },
      },
    });
    if (!user) {
      return NextResponse.json({ ok: false, code: "user_unavailable" }, { status: 401 });
    }
    const role = normalizeAppRole(user.role);
    const chatBlocked = isRetiredCaddySessionBlocked({
      role: role ?? "caddy",
      caddyId: user.caddyId ?? null,
      employmentStatus: user.caddy?.employmentStatus,
    });
    const decision = evaluateChatSessionEpoch({
      tokenSv: body.sv,
      currentSv: user.sessionVersion,
      chatBlocked,
    });
    if (!decision.ok) {
      return NextResponse.json({ ok: false, code: decision.code }, { status: 401 });
    }
    return NextResponse.json({ ok: true, userId: user.id, sv: user.sessionVersion });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) {
      return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
    }
    console.error("[POST /api/chat/session-check]", e);
    return NextResponse.json({ error: "session_check_failed" }, { status: 503 });
  }
}
