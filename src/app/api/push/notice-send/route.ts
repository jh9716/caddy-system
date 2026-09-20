import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isNoticeAuthResponse,
  requireNoticeAdmin,
} from "@/lib/noticeAccess";
import {
  NoticePushError,
  isNoticePushStoreMissing,
  parseNoticePushSendRequest,
  sendNoticePush,
} from "@/lib/noticePush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireNoticeAdmin(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const body = await req.json().catch(() => ({}));
  try {
    const { noticeId, confirm } = parseNoticePushSendRequest(body);
    const result = await sendNoticePush(prisma, {
      noticeId,
      confirm,
      actorUserId: auth.userId,
    });
    return NextResponse.json({
      ok: result.ok,
      recipients: result.recipients,
      subscriptions: result.subscriptions,
      sent: result.sent,
      failed: result.failed,
      removedStale: result.removedStale,
      ...(typeof result.deliveries === "number" ? { deliveries: result.deliveries } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    if (e instanceof NoticePushError) {
      return NextResponse.json(
        { error: e.code, message: e.message, ...(e.extra ?? {}) },
        { status: e.status }
      );
    }
    if (isNoticePushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    console.error("[POST /api/push/notice-send]", e instanceof Error ? e.name : "failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
