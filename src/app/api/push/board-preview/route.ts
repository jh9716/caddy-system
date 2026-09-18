import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isYmd } from "@/lib/dailyBoardDraft";
import { requireBoardPushAdmin } from "@/lib/boardPushAuth";
import {
  BoardPushError,
  isBoardPushStoreMissing,
  previewBoardPush,
} from "@/lib/boardPush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = await requireBoardPushAdmin(req);
  if (guard) return guard;

  const date = String(req.nextUrl.searchParams.get("date") ?? "").trim();
  if (!isYmd(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD 필요" }, { status: 400 });
  }

  try {
    const preview = await previewBoardPush(prisma, date);
    return NextResponse.json({
      date: preview.date,
      published: preview.published,
      freshness: preview.freshness,
      canSend: preview.canSend,
      sourceDraftVersion: preview.sourceDraftVersion,
      currentDraftVersion: preview.currentDraftVersion,
      alreadySent: preview.alreadySent,
      counts: preview.counts,
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
    console.error("[GET /api/push/board-preview]", e instanceof Error ? e.name : "failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
