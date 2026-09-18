import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardPushAdmin } from "@/lib/boardPushAuth";
import {
  BoardPushError,
  isBoardPushStoreMissing,
  parseBoardPushSendRequest,
  sendBoardPush,
} from "@/lib/boardPush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const guard = await requireBoardPushAdmin(req);
  if (guard) return guard;

  const body = await req.json().catch(() => ({}));
  try {
    const { date, confirm } = parseBoardPushSendRequest(body);
    const result = await sendBoardPush(prisma, { date, confirm });
    return NextResponse.json({
      ok: result.ok,
      recipients: result.recipients,
      subscriptions: result.subscriptions,
      sent: result.sent,
      failed: result.failed,
      removedStale: result.removedStale,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    if (e instanceof BoardPushError) {
      return NextResponse.json(
        { error: e.code, message: e.message, ...(e.extra ?? {}) },
        { status: e.status }
      );
    }
    if (isBoardPushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    console.error("[POST /api/push/board-send]", e instanceof Error ? e.name : "failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
