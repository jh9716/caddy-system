/**
 * /manage/caddies 현장표 배치 편집 — 로컬 초안.
 * 한 칸 이동은 서버 insert 와 같은 planCaddyReassign 을 쓰고,
 * 저장 placements 는 최종 스냅샷 explicit 로 구성한다.
 * DB 쓰기는 Preview/Apply API 가 담당한다.
 */
import {
  isPrimaryTeam,
  normalizeEmploymentStatus,
  THIRD_BAND_SUBGROUP_LABELS,
  type ThirdBandSubgroup,
} from "@/lib/caddyManage";
import {
  planCaddyReassign,
  type ReassignChange,
  type ReassignIssue,
  type ReassignPlacement,
} from "@/lib/caddyReassign";
import { getConfiguredSlotCapacity } from "@/lib/caddySlot";
import {
  hasAssignedRosterSlot,
  isRosterDrivingCaddy,
} from "@/lib/caddyRosterBoard";

export const ROSTER_REASSIGN_MODE = "explicit" as const;
export const ROSTER_REASSIGN_SEARCH_LOCK_MESSAGE =
  "검색 중에는 숨겨진 캐디 순번을 잘못 계산하지 않도록 이동을 막습니다. 검색을 지운 뒤 이동하세요.";

export type RosterDraftCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus?: string | null;
  caddyType?: string | null;
  thirdBandSubgroup?: ThirdBandSubgroup | null;
};

export type RosterEditSlot = {
  teamOrder: number;
  caddy: RosterDraftCaddy | null;
};

export type RosterMoveTarget = {
  teamOrder: number;
  occupantName: string | null;
  label: string;
};

export type RosterInsertMoveResult<T extends RosterDraftCaddy> =
  | { ok: true; rows: T[]; changes: ReassignChange[]; issues: ReassignIssue[] }
  | { ok: false; rows: T[]; changes: ReassignChange[]; issues: ReassignIssue[] };

function asPlanRow(row: RosterDraftCaddy) {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: row.teamOrder,
    employmentStatus: String(row.employmentStatus ?? ""),
    caddyType: row.caddyType ?? null,
    thirdBandSubgroup: row.thirdBandSubgroup ?? null,
  };
}

export function isRosterSearchLocked(query: unknown): boolean {
  return String(query ?? "").trim().length > 0;
}

export function canRosterReassignCaddy(caddy: {
  team?: string | null;
  caddyType?: string | null;
  employmentStatus?: string | null;
}): boolean {
  if (isRosterDrivingCaddy(caddy)) return false;
  if (normalizeEmploymentStatus(caddy.employmentStatus) === "RETIRED") {
    return false;
  }
  return isPrimaryTeam(String(caddy.team ?? ""));
}

export function rosterPlacementKey(
  team: string,
  teamOrder: number
): string {
  return `${team}#${teamOrder}`;
}

export function formatRosterSlotLabel(
  team: string,
  teamOrder: unknown
): string {
  const name = String(team ?? "").trim() || "조 없음";
  if (!hasAssignedRosterSlot(teamOrder)) return `${name} · 순번 없음`;
  return `${name} ${Math.floor(Number(teamOrder))}번`;
}

export function formatReassignTypeNote(change: ReassignChange): string | null {
  const notes: string[] = [];
  if (change.from.caddyType !== change.to.caddyType) {
    notes.push(
      `소속 ${change.from.caddyType ?? "—"} → ${change.to.caddyType ?? "—"}`
    );
  }
  if (change.from.thirdBandSubgroup !== change.to.thirdBandSubgroup) {
    const label = (value: ThirdBandSubgroup | null) =>
      value ? THIRD_BAND_SUBGROUP_LABELS[value] : "일반";
    notes.push(
      `3부반 ${label(change.from.thirdBandSubgroup)} → ${label(
        change.to.thirdBandSubgroup
      )}`
    );
  }
  return notes.length > 0 ? notes.join(" · ") : null;
}

export function rosterPlacementChanged(
  before: Pick<RosterDraftCaddy, "team" | "teamOrder"> | null | undefined,
  after: Pick<RosterDraftCaddy, "team" | "teamOrder"> | null | undefined
): boolean {
  if (!before || !after) return false;
  return before.team !== after.team || before.teamOrder !== after.teamOrder;
}

export function changedRosterPlacementIds(
  baseline: RosterDraftCaddy[],
  draft: RosterDraftCaddy[]
): number[] {
  const original = new Map(baseline.map((row) => [row.id, row]));
  const ids: number[] = [];
  for (const row of draft) {
    if (rosterPlacementChanged(original.get(row.id), row)) ids.push(row.id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * 최종 순번이 확정된 변경분만 explicit placements 로 보낸다.
 * 요청한 사람 + 밀린 사람 모두 포함해야 서버 explicit 과 로컬 insert 가 같다.
 */
export function explicitPlacementsFromDraft(
  baseline: RosterDraftCaddy[],
  draft: RosterDraftCaddy[]
): ReassignPlacement[] {
  const original = new Map(baseline.map((row) => [row.id, row]));
  const placements: ReassignPlacement[] = [];
  for (const row of draft) {
    if (!canRosterReassignCaddy(row)) continue;
    if (!hasAssignedRosterSlot(row.teamOrder)) continue;
    const before = original.get(row.id);
    if (!rosterPlacementChanged(before, row)) continue;
    placements.push({
      id: row.id,
      team: row.team,
      teamOrder: row.teamOrder,
    });
  }
  return placements.sort((a, b) => a.id - b.id);
}

export function applyRosterInsertMove<T extends RosterDraftCaddy>(
  rows: T[],
  placement: ReassignPlacement
): RosterInsertMoveResult<T> {
  const current = rows.find((row) => row.id === placement.id);
  if (!current) {
    return {
      ok: false,
      rows,
      changes: [],
      issues: [
        {
          code: "caddy_not_found",
          message: `캐디 없음: id=${placement.id}`,
          caddyIds: [placement.id],
        },
      ],
    };
  }
  if (!canRosterReassignCaddy(current)) {
    const driving = isRosterDrivingCaddy(current);
    return {
      ok: false,
      rows,
      changes: [],
      issues: [
        {
          code: driving ? "driving_forbidden" : "retired_forbidden",
          message: driving
            ? "드라이빙 캐디는 이번 재배치에서 제외합니다."
            : "삭제된 캐디는 재배치하지 않습니다.",
          caddyIds: [current.id],
        },
      ],
    };
  }
  if (current.team === placement.team && current.teamOrder === placement.teamOrder) {
    return { ok: true, rows, changes: [], issues: [] };
  }

  const plan = planCaddyReassign(rows.map(asPlanRow), [placement], {
    mode: "insert",
  });
  if (!plan.ok) {
    return { ok: false, rows, changes: plan.changes, issues: plan.issues };
  }

  const patchById = new Map(plan.patches.map((patch) => [patch.id, patch]));
  const next = rows.map((row) => {
    const patch = patchById.get(row.id);
    if (!patch) return row;
    return {
      ...row,
      team: patch.team,
      teamOrder: patch.teamOrder,
      caddyType: patch.caddyType,
      thirdBandSubgroup: patch.thirdBandSubgroup,
    };
  });
  return { ok: true, rows: next, changes: plan.changes, issues: plan.issues };
}

export function listRosterEditSlots(
  members: RosterDraftCaddy[],
  team: string
): { slots: RosterEditSlot[]; unset: RosterDraftCaddy[] } {
  const cap = getConfiguredSlotCapacity(team);
  const assigned = members.filter((row) => hasAssignedRosterSlot(row.teamOrder));
  const unset = members.filter((row) => !hasAssignedRosterSlot(row.teamOrder));
  const byOrder = new Map<number, RosterDraftCaddy[]>();
  let maxOrder = 0;
  for (const row of assigned) {
    const order = row.teamOrder;
    const list = byOrder.get(order) ?? [];
    list.push(row);
    byOrder.set(order, list);
    if (order > maxOrder) maxOrder = order;
  }
  const end = Math.min(cap, Math.max(1, maxOrder + (maxOrder < cap ? 1 : 0)));
  const last = Math.max(end, Math.min(cap, maxOrder));
  const slots: RosterEditSlot[] = [];
  for (let order = 1; order <= last; order += 1) {
    const occupants = byOrder.get(order) ?? [];
    if (occupants.length === 0) {
      slots.push({ teamOrder: order, caddy: null });
      continue;
    }
    for (const caddy of occupants) {
      slots.push({ teamOrder: order, caddy });
    }
  }
  return { slots, unset };
}

export function listRosterMoveTargets(
  rows: RosterDraftCaddy[],
  team: string,
  moverId: number
): RosterMoveTarget[] {
  const cap = getConfiguredSlotCapacity(team);
  const occupants = new Map<number, RosterDraftCaddy>();
  for (const row of rows) {
    if (row.id === moverId) continue;
    if (row.team !== team) continue;
    if (!canRosterReassignCaddy(row)) continue;
    if (!hasAssignedRosterSlot(row.teamOrder)) continue;
    if (!occupants.has(row.teamOrder)) occupants.set(row.teamOrder, row);
  }
  const targets: RosterMoveTarget[] = [];
  for (let order = 1; order <= cap; order += 1) {
    const occupant = occupants.get(order);
    targets.push({
      teamOrder: order,
      occupantName: occupant?.name ?? null,
      label: occupant
        ? `${order}번 · ${occupant.name}`
        : `${order}번 · 빈자리`,
    });
  }
  return targets;
}

export function pushRosterUndoSnapshot<T>(
  stack: T[],
  snapshot: T,
  limit = 40
): T[] {
  const next = [...stack, snapshot];
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}
