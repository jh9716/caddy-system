import { NextRequest, NextResponse } from "next/server";
import { runChatAttachmentMaintenance } from "@/lib/chatPhoto";
import { authorizeCronRequest } from "@/lib/cronAuth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Orphan ChatAttachment cleanup. Not on the photo upload hot path. */
export async function GET(req: NextRequest) {
  if (!authorizeCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const orphans = await runChatAttachmentMaintenance(prisma);
    return NextResponse.json({
      ok: true,
      deleted: orphans.deleted,
      blobFailed: orphans.blobFailed.length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "chat attachment cleanup 실패";
    console.error("[GET /api/cron/chat-attachment-cleanup]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
