import { NextRequest, NextResponse } from "next/server";
import {
  CHAT_ATTACHMENT_CONSUME_PATH,
  verifyChatInternalRequest,
} from "@/lib/chatInternalAuth";
import { consumeChatAttachments } from "@/lib/chatPhoto";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await verifyChatInternalRequest(req, CHAT_ATTACHMENT_CONSUME_PATH))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const raw = Array.isArray(body?.attachmentIds) ? body.attachmentIds : [];
  const attachmentIds = raw.map((id) => String(id || "").trim()).filter(Boolean);
  const consumed = await consumeChatAttachments(prisma, attachmentIds);
  return NextResponse.json({ ok: true, consumed });
}
