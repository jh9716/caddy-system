/**
 * XLSX v1 안전 반영 — 클라이언트/서버 공유.
 * 파일 위→아래 순서·rowNumber·카트 번호를 teamOrder로 쓰지 않는다.
 */
import {
  listSelectableEmptySlots,
  type SlotOccupant,
} from "@/lib/caddySlot";

export type V1SafeKind =
  | "keep"
  | "move"
  | "create"
  | "needsReview"
  | "missing"
  | "extraOnly"
  | "invalid";

export type V1SafeCandidate = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus?: string | null;
};

export type V1SafeDecisionRow = {
  key: string;
  kind: V1SafeKind;
  name: string;
  fileTeam: string | null;
  currentId: number | null;
  currentTeam: string | null;
  currentTeamOrder: number | null;
  reason?: string;
  candidates: V1SafeCandidate[];
};

export type V1SafeResolution = {
  name: string;
  matchId?: number | null;
  asCreate?: boolean;
  teamOrder?: number | null;
};

export type V1SafeImportPerson = {
  name: string;
  team: string;
};

export type V1UiDecision = V1SafeDecisionRow & {
  matchId?: number | null;
  asCreate?: boolean;
  teamOrder?: number | null;
};

function empHolding(emp: string | null | undefined): boolean {
  const u = String(emp ?? "").toUpperCase();
  return u === "ACTIVE" || u === "LEAVE" || emp === "재직" || emp === "휴직";
}

export function mergeV1SafeResolutions(
  rows: V1SafeDecisionRow[],
  resolutions: Record<string, V1SafeResolution | undefined>
): V1UiDecision[] {
  return rows.map((row) => {
    const res = resolutions[row.name];
    if (!res) return row;
    return {
      ...row,
      matchId: res.matchId,
      asCreate: res.asCreate,
      teamOrder: res.teamOrder,
    };
  });
}

export function v1LeavingIds(rows: V1UiDecision[]): number[] {
  const ids: number[] = [];
  for (const r of rows) {
    if (r.kind === "move" && r.currentId != null) ids.push(r.currentId);
    if (r.kind === "needsReview" && r.asCreate) continue;
    if (r.kind === "needsReview" && r.matchId != null) {
      const cand = r.candidates.find((c) => c.id === r.matchId);
      const curTeam = cand?.team ?? r.currentTeam;
      if (r.fileTeam && curTeam && r.fileTeam !== curTeam) {
        ids.push(r.matchId);
      }
    }
  }
  return ids;
}

export function v1ChosenPlacements(rows: V1UiDecision[]): Array<{
  name: string;
  id: number | null;
  team: string;
  teamOrder: number;
}> {
  const out: Array<{
    name: string;
    id: number | null;
    team: string;
    teamOrder: number;
  }> = [];
  for (const r of rows) {
    if (!r.fileTeam || r.teamOrder == null || r.teamOrder < 1) continue;
    if (r.kind === "move") {
      out.push({
        name: r.name,
        id: r.currentId,
        team: r.fileTeam,
        teamOrder: r.teamOrder,
      });
      continue;
    }
    if (r.kind === "create" || (r.kind === "needsReview" && r.asCreate)) {
      out.push({
        name: r.name,
        id: null,
        team: r.fileTeam,
        teamOrder: r.teamOrder,
      });
      continue;
    }
    if (r.kind === "needsReview" && r.matchId != null && !r.asCreate) {
      const cand = r.candidates.find((c) => c.id === r.matchId);
      const curTeam = cand?.team ?? r.currentTeam;
      if (r.fileTeam && curTeam && r.fileTeam !== curTeam) {
        out.push({
          name: r.name,
          id: r.matchId,
          team: r.fileTeam,
          teamOrder: r.teamOrder,
        });
      }
    }
  }
  return out;
}

export function projectV1SafeOccupants(
  existing: SlotOccupant[],
  rows: V1UiDecision[],
  options?: { excludeName?: string }
): SlotOccupant[] {
  const leaving = new Set(v1LeavingIds(rows));
  const remaining = existing.filter(
    (e) => !leaving.has(e.id) && empHolding(e.employmentStatus)
  );
  const placements = v1ChosenPlacements(
    rows.filter((r) => r.name !== options?.excludeName)
  );
  let synth = -1;
  const added: SlotOccupant[] = placements.map((p) => ({
    id: p.id ?? synth--,
    name: p.name,
    team: p.team,
    teamOrder: p.teamOrder,
    employmentStatus: "ACTIVE",
  }));
  return [...remaining, ...added];
}

export function listV1ProjectedEmptySlots(
  existing: SlotOccupant[],
  rows: V1UiDecision[],
  team: string,
  excludeName?: string
): number[] {
  if (!team) return [];
  const projected = projectV1SafeOccupants(existing, rows, { excludeName });
  return listSelectableEmptySlots(projected, team);
}

export function v1DuplicateSlotChoices(rows: V1UiDecision[]): Array<{
  team: string;
  teamOrder: number;
  names: string[];
}> {
  const groups = new Map<string, string[]>();
  for (const p of v1ChosenPlacements(rows)) {
    const key = `${p.team}#${p.teamOrder}`;
    const list = groups.get(key) ?? [];
    list.push(p.name);
    groups.set(key, list);
  }
  const out: Array<{ team: string; teamOrder: number; names: string[] }> = [];
  for (const [key, names] of groups) {
    if (names.length < 2) continue;
    const [team, order] = key.split("#");
    out.push({ team, teamOrder: Number(order), names });
  }
  return out;
}

export function v1SafeApplyReady(rows: V1UiDecision[]): {
  ready: boolean;
  reasons: string[];
  autoKeep: number;
  move: number;
  create: number;
  needsReview: number;
  missing: number;
  extraOnly: number;
  unresolved: number;
} {
  const reasons: string[] = [];
  let autoKeep = 0;
  let move = 0;
  let create = 0;
  let needsReview = 0;
  let missing = 0;
  let extraOnly = 0;
  let unresolved = 0;

  for (const r of rows) {
    if (r.kind === "keep") autoKeep++;
    else if (r.kind === "missing") missing++;
    else if (r.kind === "extraOnly") extraOnly++;
    else if (r.kind === "invalid") {
      /* 숫자-only 성명: 신규 생성 금지, 나머지 Apply는 막지 않음 */
    }
    else if (r.kind === "move") {
      move++;
      if (r.teamOrder == null || r.teamOrder < 1) {
        unresolved++;
        reasons.push(`${r.name}: 조 이동 순번 미선택`);
      }
    } else if (r.kind === "create") {
      create++;
      if (r.teamOrder == null || r.teamOrder < 1) {
        unresolved++;
        reasons.push(`${r.name}: 신규 순번 미선택`);
      }
    } else if (r.kind === "needsReview") {
      needsReview++;
      if (r.asCreate) {
        create++;
        if (r.teamOrder == null || r.teamOrder < 1) {
          unresolved++;
          reasons.push(`${r.name}: 신규 순번 미선택`);
        }
      } else if (r.matchId != null) {
        const cand = r.candidates.find((c) => c.id === r.matchId);
        const curTeam = cand?.team ?? null;
        if (r.fileTeam && curTeam && r.fileTeam !== curTeam) {
          move++;
          if (r.teamOrder == null || r.teamOrder < 1) {
            unresolved++;
            reasons.push(`${r.name}: 조 이동 순번 미선택`);
          }
        } else {
          autoKeep++;
        }
      } else {
        unresolved++;
        reasons.push(`${r.name}: 검토필요 미해결`);
      }
    }
  }

  const dups = v1DuplicateSlotChoices(rows);
  for (const d of dups) {
    unresolved++;
    reasons.push(
      `${d.team} ${d.teamOrder}번을 동시에 선택: ${d.names.join(", ")}`
    );
  }

  return {
    ready: unresolved === 0 && reasons.length === 0,
    reasons,
    autoKeep,
    move,
    create,
    needsReview,
    missing,
    extraOnly,
    unresolved,
  };
}
