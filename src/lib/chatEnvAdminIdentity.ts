/**
 * Env-only admin (session.uid / userId = null) has no DB User on login.
 * Chat needs a stable server-side User.id for sender, membership, unread.
 *
 * Mapping is server-only and never uses client-supplied ids:
 * 1. ADMIN_CHAT_USER_ID (optional explicit id) — must already be a DB admin
 * 2. else the dedicated SUPER_ADMIN_USERNAME ("admin") User — role=admin
 *
 * No displayName / first-admin / fuzzy match. Login/session stay env-only.
 */

import { normalizeAppRole } from "@/lib/sessionCookies";
import { SUPER_ADMIN_USERNAME } from "@/lib/staffAdminAccounts";

type LinkedCaddyRow = {
  id: number;
  name: string | null;
  team: string | null;
  employmentStatus: string | null;
};

export const ADMIN_CHAT_USER_ID_ENV = "ADMIN_CHAT_USER_ID";

export type ChatEnvAdminUserRow = {
  id: number;
  username: string;
  role: string;
  caddyId: number | null;
  caddy: LinkedCaddyRow | null;
};

export type ChatEnvAdminUserDb = {
  user: {
    findUnique: (args: {
      where: { id: number } | { username: string };
      select: {
        id: true;
        username: true;
        role: true;
        caddyId: true;
        caddy: {
          select: { id: true; name: true; team: true; employmentStatus: true };
        };
      };
    }) => Promise<ChatEnvAdminUserRow | null>;
  };
};

export type EnvAdminChatIdentity = {
  userId: number;
  username: string;
  caddyId: number | null;
  caddy: LinkedCaddyRow | null;
};

export type EnvAdminChatIdentityResult =
  | { ok: true; value: EnvAdminChatIdentity }
  | { ok: false; code: string; status: number; message: string };

const ENV_ADMIN_USER_SELECT = {
  id: true,
  username: true,
  role: true,
  caddyId: true,
  caddy: {
    select: { id: true, name: true, team: true, employmentStatus: true },
  },
} as const;

export function readAdminChatUserIdEnv(
  env: NodeJS.ProcessEnv = process.env
): string {
  return String(env[ADMIN_CHAT_USER_ID_ENV] ?? "").trim();
}

export function parseAdminChatUserId(
  raw: string | null | undefined
): { status: "unset" } | { status: "ok"; userId: number } | { status: "invalid" } {
  const value = String(raw ?? "").trim();
  if (!value) return { status: "unset" };
  if (!/^[1-9][0-9]{0,8}$/.test(value)) return { status: "invalid" };
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId <= 0) return { status: "invalid" };
  return { status: "ok", userId };
}

function missingAdminChatUser(): EnvAdminChatIdentityResult {
  return {
    ok: false,
    code: "chat_admin_user_missing",
    status: 403,
    message: "관리자 채팅 계정이 없습니다.",
  };
}

function invalidAdminChatMapping(): EnvAdminChatIdentityResult {
  return {
    ok: false,
    code: "chat_admin_mapping_invalid",
    status: 403,
    message: "관리자 채팅 계정 연결이 올바르지 않습니다.",
  };
}

function identityFromAdminRow(
  row: ChatEnvAdminUserRow | null,
  expected?: { id?: number; username?: string }
): EnvAdminChatIdentityResult {
  if (!row) return missingAdminChatUser();
  if (!Number.isInteger(row.id) || row.id <= 0) return invalidAdminChatMapping();
  if (expected?.id != null && row.id !== expected.id) {
    return invalidAdminChatMapping();
  }
  if (
    expected?.username != null &&
    row.username !== expected.username
  ) {
    return invalidAdminChatMapping();
  }
  if (normalizeAppRole(row.role) !== "admin") return invalidAdminChatMapping();
  return {
    ok: true,
    value: {
      userId: row.id,
      username: row.username,
      caddyId: row.caddyId ?? null,
      caddy: row.caddy ?? null,
    },
  };
}

/**
 * Resolve the dedicated DB admin User for an already-authenticated env-only admin.
 * Caller must have verified session role=admin and userId==null.
 */
export async function resolveEnvAdminChatIdentity(
  db: ChatEnvAdminUserDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<EnvAdminChatIdentityResult> {
  const mappedId = parseAdminChatUserId(readAdminChatUserIdEnv(env));
  if (mappedId.status === "invalid") return invalidAdminChatMapping();

  if (mappedId.status === "ok") {
    const row = await db.user.findUnique({
      where: { id: mappedId.userId },
      select: ENV_ADMIN_USER_SELECT,
    });
    return identityFromAdminRow(row, { id: mappedId.userId });
  }

  const row = await db.user.findUnique({
    where: { username: SUPER_ADMIN_USERNAME },
    select: ENV_ADMIN_USER_SELECT,
  });
  return identityFromAdminRow(row, { username: SUPER_ADMIN_USERNAME });
}
