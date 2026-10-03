import type { AppRole } from "@/lib/sessionCookies";
import type { ResolvedAuthUser } from "@/lib/auth";
import { resolveChatRoomAccess } from "@/lib/chatAcl";
import {
  CHAT_TOKEN_TTL_SEC,
  getChatAuthSecret,
  normalizeChatTeam,
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

function isRetired(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "RETIRED";
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

  if (input.role === "admin") {
    if (input.caddy && input.caddyId != null && input.caddy.id === input.caddyId && !isRetired(input.caddy.employmentStatus)) {
      const displayName =
        sanitizeChatDisplayName(input.caddy.name || "") ||
        sanitizeChatDisplayName(input.username) ||
        "관리자";
      return {
        ok: true,
        value: {
          userId: input.userId,
          displayName,
          role: "admin",
          team: normalizeChatTeam(input.caddy.team || ""),
        },
      };
    }
    return {
      ok: true,
      value: {
        userId: input.userId,
        displayName: sanitizeChatDisplayName(input.username) || "관리자",
        role: "admin",
        team: "-",
      },
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
  if (isRetired(input.caddy.employmentStatus)) {
    return {
      ok: false,
      code: "caddy_retired",
      status: 403,
      message: "퇴직 계정은 채팅할 수 없습니다.",
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
      team: normalizeChatTeam(input.caddy.team || ""),
    },
  };
}

export function assertTokenRoomMatch(
  claims: ChatTokenClaims,
  roomId: string,
  isMember = false
): boolean {
  return resolveChatRoomAccess({ claims, roomId, isMember }).ok;
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
    v: 2,
    userId: checked.value.userId,
    displayName: checked.value.displayName,
    role: checked.value.role,
    team: checked.value.team,
    iat: nowSec,
    exp: nowSec + CHAT_TOKEN_TTL_SEC,
  };
  const token = await signChatToken(claims, secret);
  return {
    token,
    exp: claims.exp,
    ttlSec: CHAT_TOKEN_TTL_SEC,
    user: {
      userId: checked.value.userId,
      displayName: checked.value.displayName,
      role: checked.value.role,
      team: checked.value.team,
    },
  };
}
