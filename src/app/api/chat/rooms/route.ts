import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import { chatHttpBaseUrl } from "@/lib/chatClientConfig";
import {
  CHAT_DIRECTORY_GRANT_TTL_SEC,
  signDirectoryCreateGrant,
} from "@/lib/chatDirectoryGrant";
import {
  generateCustomRoomId,
  ROOM_NAME_MIN,
  sanitizeChatRoomName,
} from "@/lib/chatRooms";
import { collectChatInviteMembers, type ChatUserRow } from "@/lib/chatUsers";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (shouldForcePasswordChange(auth)) {
      return mustChangePasswordResponse();
    }
    const issued = await issueChatAccessToken(prisma, auth);
    let body: { name?: string; memberUserIds?: unknown };
    try {
      body = (await req.json()) as { name?: string; memberUserIds?: unknown };
    } catch {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    const name = sanitizeChatRoomName(String(body.name || ""));
    if (name.length < ROOM_NAME_MIN) {
      return NextResponse.json(
        { error: "invalid_name", message: "방 이름을 입력하세요." },
        { status: 400 }
      );
    }
    const requestedIds = Array.isArray(body.memberUserIds)
      ? body.memberUserIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const candidates = (requestedIds.length
      ? await prisma.user.findMany({
          where: { id: { in: requestedIds } },
          select: {
            id: true,
            username: true,
            role: true,
            caddy: { select: { name: true, team: true, employmentStatus: true } },
          },
        })
      : []) as ChatUserRow[];
    const collected = collectChatInviteMembers({
      owner: {
        userId: issued.user.userId,
        displayName: issued.user.displayName,
        role: issued.user.role,
        team: issued.user.team,
      },
      candidates,
      requestedIds,
    });
    if (!collected.ok) {
      return NextResponse.json(
        { error: collected.code, message: collected.message },
        { status: 400 }
      );
    }
    const worker = chatHttpBaseUrl();
    if (!worker) {
      return NextResponse.json(
        { error: "chat_worker_unconfigured", message: "채팅 서버 주소가 없습니다." },
        { status: 503 }
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const roomId = generateCustomRoomId();
    const grant = await signDirectoryCreateGrant({
      v: 1,
      op: "create_room",
      roomId,
      name,
      ownerUserId: issued.user.userId,
      members: collected.members,
      iat: nowSec,
      exp: nowSec + CHAT_DIRECTORY_GRANT_TTL_SEC,
    });
    const res = await fetch(`${worker}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error || "room_create_failed", message: "채팅방을 만들지 못했습니다." },
        { status: res.status === 409 ? 409 : 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      room: {
        roomId,
        name,
        type: "CUSTOM",
        ownerUserId: issued.user.userId,
        members: collected.members,
      },
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[POST /api/chat/rooms]", e);
    return NextResponse.json({ error: "room_create_failed" }, { status: 500 });
  }
}
