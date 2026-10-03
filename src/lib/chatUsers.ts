import type { AppRole } from "@/lib/sessionCookies";
import { normalizeAppRole } from "@/lib/sessionCookies";
import { sanitizeChatDisplayName, normalizeChatTeam } from "@/lib/chatToken";
import { MAX_CUSTOM_MEMBERS } from "@/lib/chatRooms";

export type ChatUserSearchHit = {
  userId: number;
  displayName: string;
  team: string;
  role: AppRole;
  active: boolean;
};

export type ChatInviteMember = {
  userId: number;
  displayName: string;
  role: AppRole;
  team: string;
};

export type ChatUserRow = {
  id: number;
  username: string;
  role: string;
  caddy: {
    name: string | null;
    team: string | null;
    employmentStatus: string | null;
  } | null;
};

const SENSITIVE_KEYS = ["kakaoUserId", "phone", "phoneNormalized", "password", "token"];

export function isRetiredEmployment(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "RETIRED";
}

export function isInvitableChatUser(row: ChatUserRow): boolean {
  const role = normalizeAppRole(row.role);
  if (!role) return false;
  if (isRetiredEmployment(row.caddy?.employmentStatus)) return false;
  if (role === "admin") return row.id > 0;
  return row.caddy != null;
}

export function toChatUserSearchHit(row: ChatUserRow): ChatUserSearchHit | null {
  if (!isInvitableChatUser(row)) return null;
  const role = normalizeAppRole(row.role);
  if (!role) return null;
  const displayName =
    sanitizeChatDisplayName(row.caddy?.name || "") ||
    sanitizeChatDisplayName(row.username) ||
    (role === "admin" ? "관리자" : "이름없음");
  return {
    userId: row.id,
    displayName,
    team: normalizeChatTeam(row.caddy?.team || ""),
    role,
    active: true,
  };
}

export function matchesChatUserQuery(row: ChatUserRow, query: string): boolean {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return false;
  const name = String(row.caddy?.name || "").toLowerCase();
  const username = String(row.username || "").toLowerCase();
  const team = String(row.caddy?.team || "").toLowerCase();
  return name.includes(q) || username.includes(q) || team.includes(q);
}

export function sanitizeChatUserHit(hit: ChatUserSearchHit): ChatUserSearchHit {
  const clean = {
    userId: hit.userId,
    displayName: hit.displayName,
    team: hit.team,
    role: hit.role,
    active: hit.active,
  };
  for (const key of SENSITIVE_KEYS) {
    if (key in clean) {
      throw new Error(`sensitive field leaked: ${key}`);
    }
  }
  return clean;
}

export function collectChatInviteMembers(input: {
  owner: ChatInviteMember;
  candidates: ChatUserRow[];
  requestedIds: number[];
}): { ok: true; members: ChatInviteMember[] } | { ok: false; code: string; message: string } {
  const unique = new Set<number>();
  const members: ChatInviteMember[] = [];
  const add = (member: ChatInviteMember) => {
    if (unique.has(member.userId)) return;
    unique.add(member.userId);
    members.push(member);
  };
  add(input.owner);
  for (const id of input.requestedIds) {
    if (!Number.isInteger(id) || id <= 0) continue;
    const row = input.candidates.find((c) => c.id === id);
    if (!row) continue;
    const hit = toChatUserSearchHit(row);
    if (!hit) continue;
    add({
      userId: hit.userId,
      displayName: hit.displayName,
      role: hit.role,
      team: hit.team,
    });
  }
  if (members.length > MAX_CUSTOM_MEMBERS) {
    return {
      ok: false,
      code: "too_many_members",
      message: `멤버는 ${MAX_CUSTOM_MEMBERS}명까지입니다.`,
    };
  }
  return { ok: true, members };
}

export const CHAT_USER_PUBLIC_KEYS = [
  "userId",
  "displayName",
  "team",
  "role",
  "active",
] as const;
