import { NextRequest, NextResponse } from "next/server";
import { CHAT_PUSH_DISPATCH_PATH, verifyChatInternalRequest } from "@/lib/chatInternalAuth";
import { dispatchChatPush } from "@/lib/chatPushDispatch";
import { isChatNotifyRoomId } from "@/lib/chatNotificationPref";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function asInt(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) ? n : 0;
}

export async function POST(req: NextRequest) {
  if (!(await verifyChatInternalRequest(req, CHAT_PUSH_DISPATCH_PATH))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const roomId = String(body.roomId || "").trim();
  if (!isChatNotifyRoomId(roomId)) {
    return NextResponse.json({ error: "invalid_room" }, { status: 400 });
  }
  const mentionUserIds = Array.isArray(body.mentionUserIds)
    ? body.mentionUserIds.map((id) => asInt(id)).filter((id) => id > 0)
    : [];
  const memberUserIds = Array.isArray(body.memberUserIds)
    ? body.memberUserIds.map((id) => asInt(id)).filter((id) => id > 0)
    : body.memberUserIds == null
      ? null
      : [];
  try {
    const result = await dispatchChatPush(prisma, {
      roomId,
      seq: asInt(body.seq),
      senderUserId: asInt(body.senderUserId),
      senderName: String(body.senderName || ""),
      preview: String(body.preview || ""),
      mentionAll: body.mentionAll === true,
      mentionUserIds,
      replyToUserId:
        asInt(body.replyToSenderUserId || body.replyToUserId) || null,
      deletionType: body.deletionType ? String(body.deletionType) : null,
      roomType: String(body.roomType || ""),
      memberUserIds,
      roomName: body.roomName ? String(body.roomName) : null,
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[POST /api/chat/push-dispatch]", e);
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  }
}
