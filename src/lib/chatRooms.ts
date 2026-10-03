import { PRIMARY_TEAMS, isPrimaryTeam } from "@/lib/caddyManage";

/**
 * Phase 1 room ids are ASCII `team-1` … `team-12`.
 * Display stays `1조` … `12조`. FCM tag/group/collapse can reuse the same roomId.
 */
export const CHAT_ROOM_ID_RE = /^team-([1-9]|1[0-2])$/;

export function teamToChatRoomId(team: string): string | null {
  const trimmed = String(team ?? "").trim();
  if (!isPrimaryTeam(trimmed)) return null;
  const n = trimmed.replace(/조$/, "");
  const room = `team-${n}`;
  return CHAT_ROOM_ID_RE.test(room) ? room : null;
}

export function chatRoomIdToTeam(roomId: string): string | null {
  const match = CHAT_ROOM_ID_RE.exec(String(roomId ?? "").trim());
  if (!match) return null;
  const team = `${match[1]}조`;
  return isPrimaryTeam(team) ? team : null;
}

export const CHAT_ROOM_IDS = PRIMARY_TEAMS.map((team) => {
  const id = teamToChatRoomId(team);
  if (!id) throw new Error(`missing room id for ${team}`);
  return id;
}) as readonly string[];

export function isChatRoomId(roomId: string): boolean {
  return chatRoomIdToTeam(roomId) != null;
}
