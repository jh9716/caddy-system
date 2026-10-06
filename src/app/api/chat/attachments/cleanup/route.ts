import { NextRequest, NextResponse } from "next/server";
import {
  CHAT_ATTACHMENT_CLEANUP_PATH,
  verifyChatInternalRequest,
} from "@/lib/chatInternalAuth";
import { purgeChatAttachments, runChatAttachmentMaintenance } from "@/lib/chatPhoto";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await verifyChatInternalRequest(req, CHAT_ATTACHMENT_CLEANUP_PATH))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const roomId = String(body?.roomId || "").trim();
  const raw = Array.isArray(body?.attachmentIds) ? body.attachmentIds : [];
  const attachmentIds = raw.map((id) => String(id || "").trim()).filter(Boolean);
  const purged =
    roomId && attachmentIds.length > 0
      ? await purgeChatAttachments(prisma, { roomId, attachmentIds })
      : { deleted: 0, skipped: 0, blobFailed: [] };
  const orphans = await runChatAttachmentMaintenance(prisma);
  return NextResponse.json({
    ok: true,
    deleted: purged.deleted,
    skipped: purged.skipped,
    blobFailed: purged.blobFailed,
    orphans: orphans.deleted,
  });
}
