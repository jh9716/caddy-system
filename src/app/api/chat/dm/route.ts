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
import { canonicalDmRoomId } from "@/lib/chatRooms";
import {
  isInvitableChatUser,
  toChatUserSearchHit,
  type ChatUserRow,
} from "@/lib/chatUsers";
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
    let body: { peerUserId?: unknown };
    try {
      body = (await req.json()) as { peerUserId?: unknown };
    } catch {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    const peerUserId = Number(body.peerUserId);
    if (!Number.isInteger(peerUserId) || peerUserId <= 0) {
      return NextResponse.json({ error: "invalid_peer" }, { status: 400 });
    }
    if (peerUserId === issued.user.userId) {
      return NextResponse.json({ error: "self_dm", message: "나와의 1:1 채팅은 할 수 없습니다." }, { status: 400 });
    }
    const roomId = canonicalDmRoomId(issued.user.userId, peerUserId);
    if (!roomId) {
      return NextResponse.json({ error: "invalid_peer" }, { status: 400 });
    }
    const peer = (await prisma.user.findUnique({
      where: { id: peerUserId },
      select: {
        id: true,
        username: true,
        role: true,
        caddy: { select: { name: true, team: true, employmentStatus: true } },
      },
    })) as ChatUserRow | null;
    if (!peer || !isInvitableChatUser(peer)) {
      return NextResponse.json({ error: "peer_unavailable", message: "1:1 채팅을 할 수 없는 사용자입니다." }, { status: 404 });
    }
    const hit = toChatUserSearchHit(peer);
    if (!hit) {
      return NextResponse.json({ error: "peer_unavailable" }, { status: 404 });
    }
    const worker = chatHttpBaseUrl();
    if (!worker) {
      return NextResponse.json(
        { error: "chat_worker_unconfigured", message: "채팅 서버 주소가 없습니다." },
        { status: 503 }
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const grant = await signDirectoryCreateGrant({
      v: 1,
      op: "create_room",
      roomId,
      name: "DM",
      ownerUserId: issued.user.userId,
      members: [
        {
          userId: issued.user.userId,
          displayName: issued.user.displayName,
          role: issued.user.role,
          team: issued.user.team,
        },
        {
          userId: hit.userId,
          displayName: hit.displayName,
          role: hit.role,
          team: hit.team,
        },
      ],
      iat: nowSec,
      exp: nowSec + CHAT_DIRECTORY_GRANT_TTL_SEC,
    });
    const res = await fetch(`${worker}/directory/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { error?: string; idempotent?: boolean } | null;
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error || "dm_create_failed", message: "1:1 채팅을 시작하지 못했습니다." },
        { status: res.status === 403 ? 403 : 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      idempotent: data?.idempotent === true,
      room: {
        roomId,
        name: hit.displayName,
        type: "DM",
        ownerUserId: issued.user.userId,
        peerUserId: hit.userId,
        peerDisplayName: hit.displayName,
        peerRole: hit.role,
        peerTeam: hit.team,
        memberCount: 2,
      },
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[POST /api/chat/dm]", e);
    return NextResponse.json({ error: "dm_create_failed" }, { status: 500 });
  }
}
