import { NextRequest, NextResponse } from "next/server";
import { isAuthStoreUnavailable, isRetiredCaddySessionBlocked } from "@/lib/auth";
import { CHAT_SESSION_CHECK_PATH, verifyChatInternalRequest } from "@/lib/chatInternalAuth";
import { evaluateChatSessionEpoch } from "@/lib/chatSessionEpoch";
import { normalizeAppRole } from "@/lib/sessionCookies";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Preview 전용 Server-Timing (ms 숫자만: app=함수 처리, db=Prisma 조회, cold=이 인스턴스 첫 요청 1/0).
// 운영(VERCEL_ENV!=="preview")에서는 헤더를 붙이지 않는다. 응답 본문·상태·인증 판단은 그대로.
let sessionCheckWarm = false;
function withPreviewTiming(res: NextResponse, t0: number, dbMs: number | null, cold: boolean): NextResponse {
  try {
    if (process.env.VERCEL_ENV !== "preview") return res;
    const app = Math.max(0, Math.round(performance.now() - t0));
    const parts = [`app;dur=${app}`, `cold;dur=${cold ? 1 : 0}`];
    if (dbMs != null) parts.push(`db;dur=${Math.max(0, Math.round(dbMs))}`);
    res.headers.set("Server-Timing", parts.join(", "));
  } catch {
    // 계측 실패는 무시
  }
  return res;
}

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  const cold = !sessionCheckWarm;
  sessionCheckWarm = true;
  let dbMs: number | null = null;
  const done = (res: NextResponse) => withPreviewTiming(res, t0, dbMs, cold);
  if (!(await verifyChatInternalRequest(req, CHAT_SESSION_CHECK_PATH))) {
    return done(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }
  const body = (await req.json().catch(() => null)) as {
    userId?: unknown;
    sv?: unknown;
  } | null;
  if (!body) return done(NextResponse.json({ error: "invalid_payload" }, { status: 400 }));
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return done(NextResponse.json({ ok: false, code: "user_unavailable" }, { status: 401 }));
  }
  try {
    const tDb = performance.now();
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
    dbMs = performance.now() - tDb;
    if (!user) {
      return done(NextResponse.json({ ok: false, code: "user_unavailable" }, { status: 401 }));
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
      return done(NextResponse.json({ ok: false, code: decision.code }, { status: 401 }));
    }
    return done(NextResponse.json({ ok: true, userId: user.id, sv: user.sessionVersion }));
  } catch (e) {
    if (isAuthStoreUnavailable(e)) {
      return done(NextResponse.json({ error: "auth_unavailable" }, { status: 503 }));
    }
    console.error("[POST /api/chat/session-check]", e);
    return done(NextResponse.json({ error: "session_check_failed" }, { status: 503 }));
  }
}
