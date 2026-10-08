import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import { resolveChatRoomAccess } from "@/lib/chatAcl";
import { chatDirectoryMembersUrl } from "@/lib/chatClientConfig";
import { isAllRoomId, isCustomRoomId, isDmRoomId } from "@/lib/chatRooms";
import { verifyChatToken } from "@/lib/chatToken";
import type { PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";

export function isChatPhotoRoomId(roomId: string): boolean {
  return isAllRoomId(roomId) || isCustomRoomId(roomId) || isDmRoomId(roomId);
}

export async function isDirectoryMember(token: string, roomId: string): Promise<boolean> {
  const url = chatDirectoryMembersUrl(roomId, token);
  if (!url) return false;
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function requireChatPhotoRoomAccess(
  db: PrismaClient,
  auth: ResolvedAuthUser,
  roomId: string
): Promise<{ userId: number; token: string }> {
  if (!isChatPhotoRoomId(roomId)) {
    throw new ChatAuthError("invalid_room", "invalid room", 400);
  }
  const issued = await issueChatAccessToken(db, auth);
  const member = isAllRoomId(roomId) || (await isDirectoryMember(issued.token, roomId));
  const access = resolveChatRoomAccess({
    claims: {
      v: 2,
      userId: issued.user.userId,
      displayName: issued.user.displayName,
      role: issued.user.role,
      team: issued.user.team,
      iat: 0,
      exp: issued.exp,
    },
    roomId,
    isMember: member,
  });
  if (!access.ok) {
    throw new ChatAuthError(access.code, "room forbidden", 403);
  }
  return { userId: issued.user.userId, token: issued.token };
}

export type ChatPhotoRoomAccess = {
  userId: number;
  token: string;
  fastPath: boolean;
};

/**
 * Cookie auth already happened. A still-valid chat token matching the
 * authenticated user skips issueChatAccessToken (caddy DB). ALL rooms use
 * local ACL only. CUSTOM/DM still check directory membership with the
 * provided token. Missing/expired/mismatched tokens fall back to the
 * existing requireChatPhotoRoomAccess path.
 */
export async function resolveChatPhotoRoomAccess(
  db: PrismaClient,
  auth: ResolvedAuthUser,
  roomId: string,
  opts?: { chatToken?: string | null }
): Promise<ChatPhotoRoomAccess> {
  if (!isChatPhotoRoomId(roomId)) {
    throw new ChatAuthError("invalid_room", "invalid room", 400);
  }
  const raw = String(opts?.chatToken || "").trim();
  if (raw && auth.userId && auth.userId > 0) {
    const claims = await verifyChatToken(raw);
    if (claims && claims.userId === auth.userId) {
      const member = isAllRoomId(roomId) || (await isDirectoryMember(raw, roomId));
      const access = resolveChatRoomAccess({
        claims,
        roomId,
        isMember: member,
      });
      if (access.ok) {
        return { userId: claims.userId, token: raw, fastPath: true };
      }
    }
  }
  const issued = await requireChatPhotoRoomAccess(db, auth, roomId);
  return { ...issued, fastPath: false };
}
