/**
 * 캐디관리 V2 — 조/순번 일괄 재배치 (순수 계획·검증).
 *
 * 기존 PATCH /api/caddies/:id 와 Import Apply 를 대체하지 않는다.
 * Caddy.id / User.caddyId / 카카오 연결 / 근무·휴무 / 마샬 / 카트 / 자동배치 엔진은
 * 이 모듈이 읽거나 쓰지 않는다. DB 컬럼 추가 없음.
 *
 * 점유: ACTIVE+LEAVE 가 HOUSE/THIRD 고정 슬롯을 보유. RETIRED·DRIVING 은 빈자리.
 * 최종 occupancy 만 검증하므로 중간 슬롯 겹침(맞교환)은 허용.
 */
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  DRIVING_POOL_TEAM,
  isDrivingCaddyType,
  isPrimaryTeam,
  occupiesHouseThirdSlot,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
  type TeamCaddyType,
  type ThirdBandSubgroup,
} from "@/lib/caddyManage";
import {
  findSlotHoldingConflicts,
  findSlotOccupant,
  getConfiguredSlotCapacity,
  isSlotHoldingStatus,
} from "@/lib/caddySlot";

export const CADDY_REASSIGN_AUDIT_ACTION = "REASSIGN_CADDY_SLOTS";
export const CADDY_REASSIGN_AUDIT_ENTITY = "Caddy";
export const CADDY_REASSIGN_MAX_PLACEMENTS = 400;

export const CADDY_REASSIGN_APPLY_TX_TIMEOUT_MS = 20_000;
export const CADDY_REASSIGN_APPLY_TX_MAX_WAIT_MS = 10_000;

export const REASSIGN_MODES = ["explicit", "insert"] as const;
export type ReassignMode = (typeof REASSIGN_MODES)[number];

export type ReassignPlacement = {
  id: number;
  team: string;
  teamOrder: number;
};

export type ReassignCaddyRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  caddyType?: string | null;
  thirdBandSubgroup?: ThirdBandSubgroup | null;
  updatedAt?: Date | string | null;
};

export type ReassignSlotRef = {
  team: string;
  teamOrder: number;
  caddyType: TeamCaddyType | string | null;
  thirdBandSubgroup: ThirdBandSubgroup | null;
};

export type ReassignChange = {
  id: number;
  name: string;
  from: ReassignSlotRef;
  to: ReassignSlotRef;
};

export type ReassignBaseRow = {
  id: number;
  team: string;
  teamOrder: number;
  updatedAt: string;
};

export type ReassignIssueCode =
  | "empty_placements"
  | "too_many_placements"
  | "duplicate_placement_id"
  | "duplicate_target_slot"
  | "invalid_placement"
  | "caddy_not_found"
  | "retired_forbidden"
  | "driving_forbidden"
  | "existing_slot_conflict"
  | "existing_unspecified_order"
  | "slot_conflict"
  | "unspecified_order"
  | "capacity_exceeded"
  | "stale_roster"
  | "apply_failed";

export type ReassignIssue = {
  code: ReassignIssueCode;
  message: string;
  caddyIds?: number[];
  names?: string[];
  team?: string;
  teamOrder?: number;
};

export type ReassignPlan = {
  ok: boolean;
  mode: ReassignMode;
  requestedIds: number[];
  affectedIds: number[];
  affectedTeams: string[];
  changes: ReassignChange[];
  issues: ReassignIssue[];
  existingAnomalies: ReassignIssue[];
  base: ReassignBaseRow[];
  patches: ReassignPatch[];
};

export type ReassignPatch = {
  id: number;
  team: string;
  teamOrder: number;
  caddyType: TeamCaddyType;
  thirdBandSubgroup: ThirdBandSubgroup | null;
};

const placementSchema = z.object({
  id: z.coerce.number().int().positive(),
  team: z.string().trim().min(1),
  teamOrder: z.coerce.number().int().min(1),
});

const baseRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  team: z.string(),
  teamOrder: z.coerce.number().int(),
  updatedAt: z.string().min(1),
});

export const caddyReassignRequestSchema = z.object({
  placements: z.array(placementSchema).min(1).max(CADDY_REASSIGN_MAX_PLACEMENTS),
  mode: z.enum(REASSIGN_MODES).optional().default("explicit"),
  base: z.array(baseRowSchema).optional(),
});

export type CaddyReassignRequest = z.infer<typeof caddyReassignRequestSchema>;

export class CaddyReassignError extends Error {
  status: number;
  code: ReassignIssueCode;
  issues: ReassignIssue[];
  constructor(
    message: string,
    options?: {
      status?: number;
      code?: ReassignIssueCode;
      issues?: ReassignIssue[];
    }
  ) {
    super(message);
    this.name = "CaddyReassignError";
    this.status = options?.status ?? 400;
    this.code = options?.code ?? "invalid_placement";
    this.issues = options?.issues ?? [
      { code: this.code, message },
    ];
  }
}

type MutableRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  caddyType: string | null;
  thirdBandSubgroup: ThirdBandSubgroup | null;
};

function asIssue(
  code: ReassignIssueCode,
  message: string,
  extra?: Partial<ReassignIssue>
): ReassignIssue {
  return { code, message, ...extra };
}

function slotRef(row: MutableRow): ReassignSlotRef {
  return {
    team: row.team,
    teamOrder: row.teamOrder,
    caddyType: row.caddyType,
    thirdBandSubgroup: row.thirdBandSubgroup,
  };
}

function cloneRow(row: ReassignCaddyRow): MutableRow {
  return {
    id: row.id,
    name: row.name,
    team: String(row.team ?? "").trim(),
    teamOrder: Number(row.teamOrder) || 0,
    employmentStatus: String(row.employmentStatus ?? ""),
    caddyType: row.caddyType ?? null,
    thirdBandSubgroup: row.thirdBandSubgroup ?? null,
  };
}

function occupies(row: MutableRow): boolean {
  return (
    occupiesHouseThirdSlot(row) &&
    isSlotHoldingStatus(row.employmentStatus)
  );
}

function toOccupant(row: MutableRow) {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: row.teamOrder,
    employmentStatus: row.employmentStatus,
    caddyType: row.caddyType,
  };
}

function conflictPeople(rows: MutableRow[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: row.teamOrder,
    emp: row.employmentStatus,
    caddyType: row.caddyType,
  }));
}

export function serializeReassignUpdatedAt(
  value: Date | string | null | undefined
): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString();
}

function sameUpdatedAt(
  current: Date | string | null | undefined,
  expected: string
): boolean {
  return serializeReassignUpdatedAt(current) === serializeReassignUpdatedAt(expected);
}

function applyTypeInvariant(row: MutableRow): void {
  if (!isPrimaryTeam(row.team)) return;
  row.caddyType = resolveCaddyTypeFromTeam(row.team);
  row.thirdBandSubgroup = resolveThirdBandSubgroup({
    team: row.team,
    requested: undefined,
    current: row.thirdBandSubgroup,
  });
}

function destOccupied(
  rows: MutableRow[],
  team: string,
  teamOrder: number,
  excludeId: number
): boolean {
  return (
    findSlotOccupant(
      rows.filter(occupies).map(toOccupant),
      team,
      teamOrder,
      excludeId
    ) != null
  );
}

function holdersInTeam(rows: MutableRow[], team: string, excludeId: number) {
  return rows.filter(
    (row) =>
      occupies(row) &&
      row.team === team &&
      row.id !== excludeId &&
      row.teamOrder >= 1
  );
}

/**
 * insert 모드 한 건.
 * - 다른 조: 출발 슬롯은 비우고(재정렬 금지), 도착 점유 시 그 조에서 dest 이상만 +1.
 * - 같은 조 점유 슬롯: 출발~도착 구간만 회전. 조 전체를 1번부터 재번호하지 않음.
 * - 빈 슬롯: 그 위치로만 이동. 사이 구멍을 메우지 않음.
 */
function applyInsertPlacement(
  rows: MutableRow[],
  placement: ReassignPlacement
): void {
  const mover = rows.find((row) => row.id === placement.id);
  if (!mover) return;
  const fromTeam = mover.team;
  const fromOrder = mover.teamOrder;
  const toTeam = placement.team;
  const toOrder = placement.teamOrder;
  if (fromTeam === toTeam && fromOrder === toOrder) return;

  if (fromTeam === toTeam) {
    const occupied = destOccupied(rows, toTeam, toOrder, mover.id);
    if (occupied && fromOrder >= 1) {
      if (toOrder < fromOrder) {
        for (const holder of holdersInTeam(rows, toTeam, mover.id)) {
          if (holder.teamOrder >= toOrder && holder.teamOrder < fromOrder) {
            holder.teamOrder += 1;
          }
        }
      } else {
        for (const holder of holdersInTeam(rows, toTeam, mover.id)) {
          if (holder.teamOrder > fromOrder && holder.teamOrder <= toOrder) {
            holder.teamOrder -= 1;
          }
        }
      }
      mover.teamOrder = toOrder;
      applyTypeInvariant(mover);
      return;
    }
    if (occupied && fromOrder < 1) {
      for (const holder of holdersInTeam(rows, toTeam, mover.id)) {
        if (holder.teamOrder >= toOrder) holder.teamOrder += 1;
      }
    }
    mover.teamOrder = toOrder;
    applyTypeInvariant(mover);
    return;
  }

  if (destOccupied(rows, toTeam, toOrder, mover.id)) {
    for (const holder of holdersInTeam(rows, toTeam, mover.id)) {
      if (holder.teamOrder >= toOrder) holder.teamOrder += 1;
    }
  }
  mover.team = toTeam;
  mover.teamOrder = toOrder;
  applyTypeInvariant(mover);
}

function applyExplicitPlacement(
  rows: MutableRow[],
  placement: ReassignPlacement
): void {
  const mover = rows.find((row) => row.id === placement.id);
  if (!mover) return;
  if (mover.team === placement.team && mover.teamOrder === placement.teamOrder) {
    return;
  }
  mover.team = placement.team;
  mover.teamOrder = placement.teamOrder;
  applyTypeInvariant(mover);
}

function collectExistingAnomalies(
  rows: MutableRow[],
  affectedTeams: Set<string>
): ReassignIssue[] {
  const scoped = rows.filter(
    (row) => affectedTeams.has(row.team) && occupies(row)
  );
  const issues: ReassignIssue[] = [];
  for (const row of scoped) {
    if (!Number.isInteger(row.teamOrder) || row.teamOrder < 1) {
      issues.push(
        asIssue(
          "existing_unspecified_order",
          `${row.team} ${row.name}(id=${row.id})의 순번이 미지정(teamOrder=${row.teamOrder})입니다. 임의로 재번호하지 않습니다.`,
          { caddyIds: [row.id], names: [row.name], team: row.team, teamOrder: row.teamOrder }
        )
      );
    }
  }
  const conflicts = findSlotHoldingConflicts(conflictPeople(scoped));
  for (const conflict of conflicts) {
    issues.push(
      asIssue(
        "existing_slot_conflict",
        `${conflict.team} ${conflict.teamOrder}번 슬롯이 이미 중복입니다: ${conflict.names.join(", ")}. 임의로 재번호하지 않습니다.`,
        {
          team: conflict.team,
          teamOrder: conflict.teamOrder,
          names: conflict.names,
          caddyIds: conflict.ids.filter((id): id is number => id != null),
        }
      )
    );
  }
  return issues;
}

function collectFinalIssues(
  original: Map<number, MutableRow>,
  rows: MutableRow[],
  affectedTeams: Set<string>
): ReassignIssue[] {
  const scoped = rows.filter(
    (row) => affectedTeams.has(row.team) && occupies(row)
  );
  const issues: ReassignIssue[] = [];
  for (const row of scoped) {
    if (!Number.isInteger(row.teamOrder) || row.teamOrder < 1) {
      const before = original.get(row.id);
      const weMovedThem =
        before != null &&
        (before.team !== row.team || before.teamOrder !== row.teamOrder);
      if (!weMovedThem) continue;
      issues.push(
        asIssue(
          "unspecified_order",
          `${row.team} ${row.name}(id=${row.id})의 최종 순번이 미지정입니다.`,
          { caddyIds: [row.id], names: [row.name], team: row.team, teamOrder: row.teamOrder }
        )
      );
    }
  }
  const conflicts = findSlotHoldingConflicts(conflictPeople(scoped));
  for (const conflict of conflicts) {
    issues.push(
      asIssue(
        "slot_conflict",
        `${conflict.team} ${conflict.teamOrder}번 슬롯이 최종 상태에서 중복입니다: ${conflict.names.join(", ")}`,
        {
          team: conflict.team,
          teamOrder: conflict.teamOrder,
          names: conflict.names,
          caddyIds: conflict.ids.filter((id): id is number => id != null),
        }
      )
    );
  }
  for (const row of rows) {
    if (!occupies(row)) continue;
    if (!affectedTeams.has(row.team) && !original.has(row.id)) continue;
    if (!Number.isInteger(row.teamOrder) || row.teamOrder < 1) continue;
    const cap = getConfiguredSlotCapacity(row.team);
    if (row.teamOrder <= cap) continue;
    const before = original.get(row.id);
    const keepingOverCapacity =
      before != null &&
      before.team === row.team &&
      before.teamOrder === row.teamOrder &&
      before.teamOrder > cap;
    if (keepingOverCapacity) continue;
    issues.push(
      asIssue(
        "capacity_exceeded",
        `${row.team} 슬롯은 1~${cap}만 선택 가능합니다. (id=${row.id} ${row.name}, 요청: ${row.teamOrder})`,
        {
          caddyIds: [row.id],
          names: [row.name],
          team: row.team,
          teamOrder: row.teamOrder,
        }
      )
    );
  }
  return issues;
}

function buildBaseFromOriginals(
  originals: Map<number, MutableRow>,
  source: ReassignCaddyRow[],
  affectedTeams: Set<string>,
  requestedIds: Set<number>
): ReassignBaseRow[] {
  const byId = new Map(source.map((row) => [row.id, row]));
  const out: ReassignBaseRow[] = [];
  for (const row of originals.values()) {
    if (!affectedTeams.has(row.team) && !requestedIds.has(row.id)) continue;
    out.push({
      id: row.id,
      team: row.team,
      teamOrder: row.teamOrder,
      updatedAt: serializeReassignUpdatedAt(byId.get(row.id)?.updatedAt),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

export function planCaddyReassign(
  rows: ReassignCaddyRow[],
  placements: ReassignPlacement[],
  options?: { mode?: ReassignMode }
): ReassignPlan {
  const mode: ReassignMode = options?.mode === "insert" ? "insert" : "explicit";
  const issues: ReassignIssue[] = [];
  const requestedIds = placements.map((p) => p.id);

  if (placements.length === 0) {
    issues.push(asIssue("empty_placements", "placements가 비어 있습니다."));
  }
  if (placements.length > CADDY_REASSIGN_MAX_PLACEMENTS) {
    issues.push(
      asIssue(
        "too_many_placements",
        `한 번에 ${CADDY_REASSIGN_MAX_PLACEMENTS}명까지만 재배치할 수 있습니다.`
      )
    );
  }

  const seenIds = new Set<number>();
  const targetSlots = new Map<string, number>();
  for (const placement of placements) {
    if (seenIds.has(placement.id)) {
      issues.push(
        asIssue("duplicate_placement_id", `캐디 id=${placement.id}가 placements에 중복입니다.`, {
          caddyIds: [placement.id],
        })
      );
    }
    seenIds.add(placement.id);
    const team = String(placement.team ?? "").trim();
    if (!isPrimaryTeam(team)) {
      issues.push(
        asIssue(
          "invalid_placement",
          `조는 1~12조만 지정할 수 있습니다: id=${placement.id} team=${placement.team}`,
          { caddyIds: [placement.id], team }
        )
      );
    }
    if (!Number.isInteger(placement.teamOrder) || placement.teamOrder < 1) {
      issues.push(
        asIssue(
          "invalid_placement",
          `슬롯(teamOrder)은 1 이상이어야 합니다: id=${placement.id}`,
          { caddyIds: [placement.id], team, teamOrder: placement.teamOrder }
        )
      );
    } else {
      const cap = getConfiguredSlotCapacity(team);
      if (placement.teamOrder > cap) {
        issues.push(
          asIssue(
            "capacity_exceeded",
            `${team} 슬롯은 1~${cap}만 선택 가능합니다. (id=${placement.id}, 요청: ${placement.teamOrder})`,
            { caddyIds: [placement.id], team, teamOrder: placement.teamOrder }
          )
        );
      }
    }
    if (mode === "explicit") {
      const slotKey = `${team}#${placement.teamOrder}`;
      if (targetSlots.has(slotKey)) {
        issues.push(
          asIssue(
            "duplicate_target_slot",
            `같은 배치에서 ${team} ${placement.teamOrder}번을 두 명이 지정했습니다.`,
            {
              team,
              teamOrder: placement.teamOrder,
              caddyIds: [targetSlots.get(slotKey)!, placement.id],
            }
          )
        );
      } else {
        targetSlots.set(slotKey, placement.id);
      }
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const originals = new Map<number, MutableRow>();
  const working = rows.map((row) => {
    const cloned = cloneRow(row);
    originals.set(cloned.id, { ...cloned });
    return cloned;
  });

  const affectedTeams = new Set<string>();
  for (const placement of placements) {
    const current = byId.get(placement.id);
    if (!current) {
      issues.push(
        asIssue("caddy_not_found", `캐디 없음: id=${placement.id}`, {
          caddyIds: [placement.id],
        })
      );
      continue;
    }
    const currentTeam = String(current.team ?? "").trim();
    if (isPrimaryTeam(currentTeam)) affectedTeams.add(currentTeam);
    if (isPrimaryTeam(placement.team)) affectedTeams.add(placement.team);

    if (isDrivingCaddyType(current.caddyType) || currentTeam === DRIVING_POOL_TEAM) {
      issues.push(
        asIssue(
          "driving_forbidden",
          `드라이빙 캐디는 이 API로 조/순번을 바꿀 수 없습니다: id=${placement.id}`,
          { caddyIds: [placement.id] }
        )
      );
      continue;
    }
    if (String(current.employmentStatus).toUpperCase() === "RETIRED") {
      issues.push(
        asIssue(
          "retired_forbidden",
          `퇴사(RETIRED) 캐디는 재배치하지 않습니다: id=${placement.id}`,
          { caddyIds: [placement.id] }
        )
      );
    }
  }

  const existingAnomalies = collectExistingAnomalies(working, affectedTeams);
  const requestIssueCount = issues.length;

  if (requestIssueCount === 0) {
    for (const placement of placements) {
      if (mode === "insert") applyInsertPlacement(working, placement);
      else applyExplicitPlacement(working, placement);
    }
    issues.push(...collectFinalIssues(originals, working, affectedTeams));
  }

  const changes: ReassignChange[] = [];
  const patches: ReassignPatch[] = [];
  if (requestIssueCount === 0) {
    for (const row of working) {
      const before = originals.get(row.id);
      if (!before) continue;
      if (
        before.team === row.team &&
        before.teamOrder === row.teamOrder &&
        before.caddyType === row.caddyType &&
        before.thirdBandSubgroup === row.thirdBandSubgroup
      ) {
        continue;
      }
      if (!isPrimaryTeam(row.team)) continue;
      changes.push({
        id: row.id,
        name: row.name,
        from: slotRef(before),
        to: slotRef(row),
      });
      patches.push({
        id: row.id,
        team: row.team,
        teamOrder: row.teamOrder,
        caddyType: resolveCaddyTypeFromTeam(row.team),
        thirdBandSubgroup: row.thirdBandSubgroup,
      });
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    mode,
    requestedIds,
    affectedIds: changes.map((change) => change.id),
    affectedTeams: [...affectedTeams].sort(
      (a, b) => Number(a.replace("조", "")) - Number(b.replace("조", ""))
    ),
    changes: ok ? changes : requestIssueCount === 0 ? changes : [],
    issues,
    existingAnomalies,
    base: buildBaseFromOriginals(originals, rows, affectedTeams, seenIds),
    patches: ok ? patches : [],
  };
}

/** 스냅샷(base)과 잠금된 현재 행 비교. 불일치 시 409. */
export function assertReassignBase(
  locked: ReassignCaddyRow[],
  base: ReassignBaseRow[] | undefined,
  affectedTeams: string[],
  requestedIds: number[]
): void {
  if (!base || base.length === 0) {
    throw new CaddyReassignError("동시 수정 확인을 위해 base 스냅샷이 필요합니다.", {
      status: 400,
      code: "stale_roster",
    });
  }
  const teamSet = new Set(affectedTeams);
  const idSet = new Set(requestedIds);
  const relevant = locked.filter(
    (row) => teamSet.has(String(row.team ?? "").trim()) || idSet.has(row.id)
  );
  const baseById = new Map(base.map((row) => [row.id, row]));
  if (baseById.size !== base.length) {
    throw new CaddyReassignError("base 스냅샷에 중복 id가 있습니다.", {
      status: 400,
      code: "stale_roster",
    });
  }
  if (relevant.length !== base.length) {
    throw new CaddyReassignError(
      "명단이 다른 관리자에 의해 변경되었습니다. 다시 불러온 뒤 저장하세요.",
      {
        status: 409,
        code: "stale_roster",
        issues: [
          asIssue(
            "stale_roster",
            "명단이 다른 관리자에 의해 변경되었습니다. 다시 불러온 뒤 저장하세요."
          ),
        ],
      }
    );
  }
  for (const row of relevant) {
    const expected = baseById.get(row.id);
    if (
      !expected ||
      expected.team !== String(row.team ?? "").trim() ||
      expected.teamOrder !== (Number(row.teamOrder) || 0) ||
      !sameUpdatedAt(row.updatedAt, expected.updatedAt)
    ) {
      throw new CaddyReassignError(
        "명단이 다른 관리자에 의해 변경되었습니다. 다시 불러온 뒤 저장하세요.",
        {
          status: 409,
          code: "stale_roster",
          issues: [
            asIssue("stale_roster", `캐디 id=${row.id} 스냅샷이 현재 값과 다릅니다.`, {
              caddyIds: [row.id],
              team: String(row.team ?? ""),
              teamOrder: Number(row.teamOrder) || 0,
            }),
          ],
        }
      );
    }
  }
}

export function throwIfPlanBlocked(plan: ReassignPlan): void {
  if (plan.ok) return;
  const first = plan.issues[0];
  const staleLike =
    first?.code === "slot_conflict" ||
    first?.code === "existing_slot_conflict" ||
    first?.code === "existing_unspecified_order" ||
    first?.code === "unspecified_order" ||
    first?.code === "stale_roster";
  throw new CaddyReassignError(first?.message ?? "재배치를 적용할 수 없습니다.", {
    status: staleLike ? 409 : 400,
    code: first?.code ?? "invalid_placement",
    issues: plan.issues,
  });
}

/**
 * Caddy 조/순번/타입/3부반만 갱신. id 및 그 외 컬럼은 SQL에 등장하지 않는다.
 */
export function buildCaddyReassignUpdateSql(patches: ReassignPatch[]): Prisma.Sql {
  if (patches.length === 0) {
    throw new Error("reassign update requires at least one row");
  }
  const values = patches.map(
    (patch) => Prisma.sql`(
      ${patch.id}::integer,
      ${patch.team}::text,
      ${patch.teamOrder}::integer,
      ${patch.caddyType}::text,
      ${patch.thirdBandSubgroup}::text
    )`
  );
  return Prisma.sql`
    UPDATE "Caddy" AS c
    SET
      "team" = v."team",
      "teamOrder" = v."teamOrder",
      "caddyType" = v."caddyType"::"CaddyType",
      "thirdBandSubgroup" = v."thirdBandSubgroup"::"ThirdBandSubgroup",
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      VALUES ${Prisma.join(values, ",")}
    ) AS v(
      "id",
      "team",
      "teamOrder",
      "caddyType",
      "thirdBandSubgroup"
    )
    WHERE c."id" = v."id"
  `;
}

export function buildCaddyReassignLockSql(
  teams: string[],
  ids: number[]
): Prisma.Sql {
  const teamList = teams
    .filter((team) => isPrimaryTeam(team))
    .sort((a, b) => Number(a.replace("조", "")) - Number(b.replace("조", "")));
  const idList = ids
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (teamList.length === 0 && idList.length === 0) {
    throw new Error("reassign lock requires teams or ids");
  }
  if (teamList.length > 0 && idList.length > 0) {
    return Prisma.sql`
      SELECT
        id,
        name,
        team,
        "teamOrder",
        "employmentStatus"::text AS "employmentStatus",
        "caddyType"::text AS "caddyType",
        "thirdBandSubgroup"::text AS "thirdBandSubgroup",
        "updatedAt"
      FROM "Caddy"
      WHERE team IN (${Prisma.join(teamList)})
         OR id IN (${Prisma.join(idList)})
      FOR UPDATE
    `;
  }
  if (teamList.length > 0) {
    return Prisma.sql`
      SELECT
        id,
        name,
        team,
        "teamOrder",
        "employmentStatus"::text AS "employmentStatus",
        "caddyType"::text AS "caddyType",
        "thirdBandSubgroup"::text AS "thirdBandSubgroup",
        "updatedAt"
      FROM "Caddy"
      WHERE team IN (${Prisma.join(teamList)})
      FOR UPDATE
    `;
  }
  return Prisma.sql`
    SELECT
      id,
      name,
      team,
      "teamOrder",
      "employmentStatus"::text AS "employmentStatus",
      "caddyType"::text AS "caddyType",
      "thirdBandSubgroup"::text AS "thirdBandSubgroup",
      "updatedAt"
    FROM "Caddy"
    WHERE id IN (${Prisma.join(idList)})
    FOR UPDATE
  `;
}
