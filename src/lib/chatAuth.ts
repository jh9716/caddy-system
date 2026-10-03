import type { AppRole } from "@/lib/sessionCookies";
import type { ResolvedAuthUser } from "@/lib/auth";
import { isPrimaryTeam } from "@/lib/caddyManage";
import { chatRoomIdToTeam, teamToChatRoomId } from "@/lib/chatRooms";
import {
  CHAT_TOKEN_TTL_SEC,
  getChatAuthSecret,
  sanitizeChatDisplayName,
  signChatToken,
  type ChatTokenClaims,
} from "@/lib/chatToken";

export type ChatCaddyRow = {
  id: number;
  name: string | null;
  team: string | null;
  employmentStatus: string | null;
};

export type ChatAccess = {
  userId: number;
  displayName: string;
  role: AppRole;
  team: string;
  roomId: string;
};

export class ChatAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ChatAuthError";
    this.code = code;
    this.status = status;
  }
}

export function resolveChatEligibility(input: {
  userId: number | null;
  username: string;
  role: AppRole;
  caddyId: number | null;
  caddy: ChatCaddyRow | null;
}): { ok: true; value: ChatAccess } | { ok: false; code: string; status: number; message: string } {
  if (input.userId == null || input.userId <= 0) {
    return {
      ok: false,
      code: "chat_user_required",
      status: 403,
      message: "DB 사용자만 채팅할 수 있습니다.",
    };
  }
  if (input.caddyId == null || !input.caddy) {
    return {
      ok: false,
      code: "caddy_not_linked",
      status: 403,
      message: "연결된 캐디 계정이 필요합니다.",
    };
  }
  if (input.caddy.id !== input.caddyId) {
    return {
      ok: false,
      code: "caddy_not_linked",
      status: 403,
      message: "연결된 캐디 계정이 필요합니다.",
    };
  }
  if (String(input.caddy.employmentStatus ?? "").trim().toUpperCase() === "RETIRED") {
    return {
      ok: false,
      code: "caddy_retired",
      status: 403,
      message: "퇴직 계정은 채팅할 수 없습니다.",
    };
  }
  const team = String(input.caddy.team ?? "").trim();
  if (!isPrimaryTeam(team)) {
    return {
      ok: false,
      code: "no_primary_team",
      status: 403,
      message: "PRIMARY 조 채팅방만 사용할 수 있습니다.",
    };
  }
  const roomId = teamToChatRoomId(team);
  if (!roomId) {
    return {
      ok: false,
      code: "no_primary_team",
      status: 403,
      message: "PRIMARY 조 채팅방만 사용할 수 있습니다.",
    };
  }
  const displayName =
    sanitizeChatDisplayName(input.caddy.name || "") ||
    sanitizeChatDisplayName(input.username) ||
    "이름없음";
  return {
    ok: true,
    value: {
      userId: input.userId,
      displayName,
      role: input.role,
      team,
      roomId,
    },
  };
}

export function assertTokenRoomMatch(claims: ChatTokenClaims, roomId: string): boolean {
  return claims.room === roomId && chatRoomIdToTeam(roomId) === claims.team;
}

export async function issueChatAccessToken(
  db: {
    caddy: {
      findUnique: (args: {
        where: { id: number };
        select: { id: true; name: true; team: true; employmentStatus: true };
      }) => Promise<ChatCaddyRow | null>;
    };
  },
  auth: ResolvedAuthUser,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<{
  token: string;
  exp: number;
  ttlSec: number;
  room: { id: string; name: string };
  user: { userId: number; displayName: string; role: AppRole; team: string };
}> {
  const secret = getChatAuthSecret();
  if (!secret) {
    throw new ChatAuthError(
      "chat_auth_unconfigured",
      "채팅 인증이 설정되지 않았습니다.",
      503
    );
  }
  let caddy: ChatCaddyRow | null = null;
  if (auth.caddyId != null) {
    caddy = await db.caddy.findUnique({
      where: { id: auth.caddyId },
      select: { id: true, name: true, team: true, employmentStatus: true },
    });
  }
  const checked = resolveChatEligibility({
    userId: auth.userId,
    username: auth.username,
    role: auth.role,
    caddyId: auth.caddyId,
    caddy,
  });
  if (!checked.ok) {
    throw new ChatAuthError(checked.code, checked.message, checked.status);
  }
  const claims: ChatTokenClaims = {
    v: 1,
    userId: checked.value.userId,
    displayName: checked.value.displayName,
    role: checked.value.role,
    team: checked.value.team,
    room: checked.value.roomId,
    iat: nowSec,
    exp: nowSec + CHAT_TOKEN_TTL_SEC,
  };
  const token = await signChatToken(claims, secret);
  return {
    token,
    exp: claims.exp,
    ttlSec: CHAT_TOKEN_TTL_SEC,
    room: { id: checked.value.roomId, name: checked.value.team },
    user: {
      userId: checked.value.userId,
      displayName: checked.value.displayName,
      role: checked.value.role,
      team: checked.value.team,
    },
  };
}
