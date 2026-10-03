import type { AppRole } from "@/lib/sessionCookies";
import type { ChatUserSearchHit } from "@/lib/chatUsers";

export type InviteRoleChip = { role: AppRole; label: string };
export type InviteTeamChip = { team: string; label: string };

/**
 * AppRole is admin | caddy | leader. `캐디 전체` is role===caddy only.
 * Leaders are a separate chip — they are not a caddy subtype in this model.
 */
const ROLE_LABEL: Record<AppRole, string> = {
  caddy: "캐디 전체",
  leader: "리더",
  admin: "관리자",
};

const ROLE_ORDER: AppRole[] = ["caddy", "leader", "admin"];

export function invitePoolExcludingOwner(
  users: ChatUserSearchHit[],
  ownerUserId: number | null | undefined
): ChatUserSearchHit[] {
  const owner = Number(ownerUserId);
  return users.filter((user) => {
    if (!user.active) return false;
    if (Number.isInteger(owner) && owner > 0 && user.userId === owner) return false;
    return true;
  });
}

export function visibleInviteTeams(users: ChatUserSearchHit[]): InviteTeamChip[] {
  const seen = new Set<string>();
  for (const user of users) {
    const team = String(user.team || "").trim();
    if (team && team !== "-") seen.add(team);
  }
  const numbered: InviteTeamChip[] = [];
  for (let n = 1; n <= 12; n++) {
    const team = `${n}조`;
    if (seen.has(team)) {
      numbered.push({ team, label: team });
      seen.delete(team);
    }
  }
  const extra = [...seen]
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((team) => ({ team, label: team }));
  return [...numbered, ...extra];
}

export function visibleInviteRoles(users: ChatUserSearchHit[]): InviteRoleChip[] {
  const seen = new Set(users.map((user) => user.role));
  return ROLE_ORDER.filter((role) => seen.has(role)).map((role) => ({
    role,
    label: ROLE_LABEL[role],
  }));
}

export function filterInviteUsers(
  users: ChatUserSearchHit[],
  query: string
): ChatUserSearchHit[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return users;
  return users.filter((user) => {
    return (
      user.displayName.toLowerCase().includes(q) ||
      user.team.toLowerCase().includes(q) ||
      user.role.toLowerCase().includes(q)
    );
  });
}

export function uniqueInviteIds(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function inviteSelectionCount(selected: number[]): number {
  return uniqueInviteIds(selected).length;
}

export function toggleInviteId(selected: number[], userId: number): number[] {
  if (!Number.isInteger(userId) || userId <= 0) return uniqueInviteIds(selected);
  if (selected.includes(userId)) return selected.filter((id) => id !== userId);
  return uniqueInviteIds([...selected, userId]);
}

export function selectAllInviteIds(users: ChatUserSearchHit[]): number[] {
  return uniqueInviteIds(users.map((user) => user.userId));
}

export function clearInviteIds(): number[] {
  return [];
}

function toggleGroup(selected: number[], groupIds: number[]): number[] {
  const ids = uniqueInviteIds(groupIds);
  if (ids.length === 0) return uniqueInviteIds(selected);
  const set = new Set(uniqueInviteIds(selected));
  const allOn = ids.every((id) => set.has(id));
  if (allOn) {
    for (const id of ids) set.delete(id);
  } else {
    for (const id of ids) set.add(id);
  }
  return [...set];
}

export function toggleTeamInviteIds(
  selected: number[],
  users: ChatUserSearchHit[],
  team: string
): number[] {
  return toggleGroup(
    selected,
    users.filter((user) => user.team === team).map((user) => user.userId)
  );
}

export function toggleRoleInviteIds(
  selected: number[],
  users: ChatUserSearchHit[],
  role: AppRole
): number[] {
  return toggleGroup(
    selected,
    users.filter((user) => user.role === role).map((user) => user.userId)
  );
}

export function isTeamFullySelected(
  selected: number[],
  users: ChatUserSearchHit[],
  team: string
): boolean {
  const ids = uniqueInviteIds(
    users.filter((user) => user.team === team).map((user) => user.userId)
  );
  return ids.length > 0 && ids.every((id) => selected.includes(id));
}

export function isRoleFullySelected(
  selected: number[],
  users: ChatUserSearchHit[],
  role: AppRole
): boolean {
  const ids = uniqueInviteIds(
    users.filter((user) => user.role === role).map((user) => user.userId)
  );
  return ids.length > 0 && ids.every((id) => selected.includes(id));
}
