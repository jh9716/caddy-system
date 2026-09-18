import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isNoticeAuthResponse,
  requireNoticeAdmin,
} from "@/lib/noticeAccess";
import {
  NoticePushError,
  isNoticePushStoreMissing,
  previewNoticePush,
} from "@/lib/noticePush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireNoticeAdmin(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const noticeId = Number(req.nextUrl.searchParams.get("noticeId") ?? "");
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    return NextResponse.json({ error: "noticeId가 필요합니다." }, { status: 400 });
  }

  try {
    const preview = await previewNoticePush(prisma, noticeId);
    return NextResponse.json({
      noticeId: preview.noticeId,
      targetType: preview.targetType,
      targetValue: preview.targetValue,
      counts: preview.counts,
      canSend: preview.canSend,
      alreadySent: preview.alreadySent,
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
    console.error("[GET /api/push/notice-preview]", e instanceof Error ? e.name : "failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
