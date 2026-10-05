/**
 * 관리자 /manage/users 캐디 명단 중심 연결 뷰.
 * 기존 GET 응답만 조합한다. 승인/연결 규칙은 서버가 유지한다.
 */

export type AdminLinkStatus = "linked" | "pending" | "unlinked";

export type RosterCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

export type RosterUser = {
  id: number;
  username: string;
  role?: string;
  kakaoUserId?: string;
  caddyId: number | null;
  linked: boolean;
};

export type RosterPendingCandidate = {
  id: number;
  name?: string;
  team?: string;
  teamOrder?: number;
  employmentStatus?: string;
};

export type RosterPending = {
  id: number;
  submittedName: string;
  maskedPhone: string | null;
  requestedAt?: string;
  user: { id: number; username: string };
  candidates: RosterPendingCandidate[];
};

export type AdminCaddyLinkRow = {
  caddy: RosterCaddy;
  status: AdminLinkStatus;
  linkedUser: RosterUser | null;
  pendingForCaddy: RosterPending[];
};

export type AdminCaddyLinkFilters = {
  team?: string;
  nameQuery?: string;
  status?: AdminLinkStatus | "";
};

export type AdminCaddyLinkSummary = {
  total: number;
  linked: number;
  pending: number;
  unlinked: number;
};

export const ADMIN_LINK_STATUS_LABELS: Record<AdminLinkStatus, string> = {
  linked: "연결됨",
  pending: "승인대기",
  unlinked: "미연결",
};

export function toSafeRosterCaddy(raw: {
  id: number;
  name?: string | null;
  team?: string | null;
  teamOrder?: number | null;
  employmentStatus?: string | null;
}): RosterCaddy {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? "").trim(),
    team: String(raw.team ?? "").trim(),
    teamOrder: Number(raw.teamOrder ?? 0),
    employmentStatus: String(raw.employmentStatus ?? "").trim() || "ACTIVE",
  };
}

export function isActiveRosterCaddy(caddy: Pick<RosterCaddy, "employmentStatus">): boolean {
  return caddy.employmentStatus === "ACTIVE";
}

export function resolveAdminLinkStatus(input: {
  linkedUser: RosterUser | null;
  pendingForCaddy: RosterPending[];
}): AdminLinkStatus {
  if (input.linkedUser) return "linked";
  if (input.pendingForCaddy.length > 0) return "pending";
  return "unlinked";
}

export function pendingRequestsForCaddy(
  caddyId: number,
  pending: RosterPending[]
): RosterPending[] {
  return pending.filter((req) =>
    (req.candidates ?? []).some((c) => c.id === caddyId)
  );
}

export function canApprovePendingForCaddy(
  request: Pick<RosterPending, "candidates">,
  caddyId: number
): boolean {
  return (request.candidates ?? []).some((c) => c.id === caddyId);
}

export function buildAdminCaddyLinkRoster(
  caddies: RosterCaddy[],
  users: RosterUser[],
  pending: RosterPending[]
): AdminCaddyLinkRow[] {
  const linkedByCaddy = new Map<number, RosterUser>();
  for (const user of users) {
    if (user.caddyId == null) continue;
    if (!linkedByCaddy.has(user.caddyId)) linkedByCaddy.set(user.caddyId, user);
  }

  return caddies
    .filter(isActiveRosterCaddy)
    .slice()
    .sort((a, b) => {
      const byTeam = a.team.localeCompare(b.team, "ko");
      if (byTeam !== 0) return byTeam;
      if (a.teamOrder !== b.teamOrder) return a.teamOrder - b.teamOrder;
      return a.id - b.id;
    })
    .map((caddy) => {
      const linkedUser = linkedByCaddy.get(caddy.id) ?? null;
      const pendingForCaddy = pendingRequestsForCaddy(caddy.id, pending);
      return {
        caddy,
        linkedUser,
        pendingForCaddy,
        status: resolveAdminLinkStatus({ linkedUser, pendingForCaddy }),
      };
    });
}

export function filterAdminCaddyLinkRoster(
  rows: AdminCaddyLinkRow[],
  filters: AdminCaddyLinkFilters = {}
): AdminCaddyLinkRow[] {
  const team = String(filters.team ?? "").trim();
  const q = String(filters.nameQuery ?? "").trim().toLowerCase();
  const status = filters.status || "";
  return rows.filter((row) => {
    if (team && row.caddy.team !== team) return false;
    if (status && row.status !== status) return false;
    if (!q) return true;
    const hay = [
      row.caddy.name,
      row.caddy.team,
      row.linkedUser?.username ?? "",
      ...row.pendingForCaddy.map((req) => req.user.username),
      ...row.pendingForCaddy.map((req) => req.submittedName),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function summarizeAdminCaddyLinkRoster(
  rows: AdminCaddyLinkRow[]
): AdminCaddyLinkSummary {
  const summary: AdminCaddyLinkSummary = {
    total: rows.length,
    linked: 0,
    pending: 0,
    unlinked: 0,
  };
  for (const row of rows) {
    summary[row.status] += 1;
  }
  return summary;
}

export function uniqueRosterTeams(caddies: Array<Pick<RosterCaddy, "team">>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const caddy of caddies) {
    const team = String(caddy.team ?? "").trim();
    if (!team || seen.has(team)) continue;
    seen.add(team);
    out.push(team);
  }
  return out.sort((a, b) => a.localeCompare(b, "ko"));
}

export function unlinkedKakaoAccounts(users: RosterUser[]): RosterUser[] {
  return users.filter((user) => !user.linked && user.caddyId == null);
}

export function isCaddyOccupied(
  caddyId: number,
  occupiedCaddyIds: Iterable<number>
): boolean {
  for (const id of occupiedCaddyIds) {
    if (id === caddyId) return true;
  }
  return false;
}
