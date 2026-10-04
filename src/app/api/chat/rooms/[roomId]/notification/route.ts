import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import { chatDirectoryMembersUrl, chatHttpBaseUrl } from "@/lib/chatClientConfig";
import {
  canWriteChatNotifyPref,
  DEFAULT_CHAT_NOTIFY_MODE,
  isChatNotifyRoomId,
  parseChatNotifyMode,
} from "@/lib/chatNotificationPref";
import { isAllRoomId } from "@/lib/chatRooms";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function isDirectoryMember(token: string, roomId: string): Promise<boolean> {
  const url = chatDirectoryMembersUrl(roomId, token);
  if (!url) return false;
  const res = await fetch(url, { cache: "no-store" });
  return res.ok;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> }
) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const issued = await issueChatAccessToken(prisma, auth);
    const roomId = decodeURIComponent((await ctx.params).roomId || "");
    if (!isChatNotifyRoomId(roomId)) {
      return NextResponse.json({ error: "invalid_room" }, { status: 400 });
    }
    const member = isAllRoomId(roomId) || (await isDirectoryMember(issued.token, roomId));
    if (!canWriteChatNotifyPref({ roomId, isMember: member })) {
      return NextResponse.json({ error: "room_forbidden" }, { status: 403 });
    }
    const row = await prisma.chatRoomNotificationPreference.findUnique({
      where: { userId_roomId: { userId: issued.user.userId, roomId } },
      select: { mode: true },
    });
    return NextResponse.json({
      ok: true,
      roomId,
      mode: row?.mode ?? DEFAULT_CHAT_NOTIFY_MODE,
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[GET /api/chat/rooms/notification]", e);
    return NextResponse.json({ error: "pref_failed" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> }
) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const issued = await issueChatAccessToken(prisma, auth);
    const roomId = decodeURIComponent((await ctx.params).roomId || "");
    if (!isChatNotifyRoomId(roomId)) {
      return NextResponse.json({ error: "invalid_room" }, { status: 400 });
    }
    if (!chatHttpBaseUrl() && !isAllRoomId(roomId)) {
      return NextResponse.json({ error: "chat_worker_unconfigured" }, { status: 503 });
    }
    const member = isAllRoomId(roomId) || (await isDirectoryMember(issued.token, roomId));
    if (!canWriteChatNotifyPref({ roomId, isMember: member })) {
      return NextResponse.json({ error: "room_forbidden" }, { status: 403 });
    }
    const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = parseChatNotifyMode(body?.mode);
    if (!mode) return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
    const row = await prisma.chatRoomNotificationPreference.upsert({
      where: { userId_roomId: { userId: issued.user.userId, roomId } },
      create: { userId: issued.user.userId, roomId, mode },
      update: { mode },
      select: { mode: true, roomId: true },
    });
    return NextResponse.json({ ok: true, roomId: row.roomId, mode: row.mode });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[PUT /api/chat/rooms/notification]", e);
    return NextResponse.json({ error: "pref_failed" }, { status: 500 });
  }
}
