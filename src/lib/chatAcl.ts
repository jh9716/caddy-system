import { isAllRoomId, isCustomRoomId, isLegacyTeamRoomId } from "@/lib/chatRooms";
import type { ChatTokenClaims } from "@/lib/chatToken";
import { isChatTokenV2 } from "@/lib/chatToken";

export function resolveChatRoomAccess(input: {
  claims: ChatTokenClaims;
  roomId: string;
  isMember: boolean;
}): { ok: true } | { ok: false; code: "invalid_room" | "room_forbidden" } {
  const roomId = String(input.roomId ?? "").trim();
  if (isAllRoomId(roomId)) {
    return isChatTokenV2(input.claims) ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (isCustomRoomId(roomId)) {
    if (!isChatTokenV2(input.claims)) return { ok: false, code: "room_forbidden" };
    return input.isMember ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (isLegacyTeamRoomId(roomId)) {
    if (input.claims.v === 1 && input.claims.room === roomId) return { ok: true };
    return { ok: false, code: "room_forbidden" };
  }
  return { ok: false, code: "invalid_room" };
}

export function isVerifiedAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

export function senderRoleFromClaims(claims: { role: string }): "admin" | "caddy" | "leader" {
  if (claims.role === "admin") return "admin";
  if (claims.role === "leader") return "leader";
  return "caddy";
}
