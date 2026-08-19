/**
 * 가용표 고정 슬롯 그리드 (읽기 전용 표시용).
 * Caddy row를 새로 만들지 않고, slot-holding 점유자 유무로 빈자리를 렌더.
 */

import { occupiesHouseThirdSlot, PRIMARY_TEAMS } from "@/lib/caddyManage";
import {
  isSlotHoldingStatus,
  resolveGridSlotCount,
} from "@/lib/caddySlot";
import type {
  AvailabilityResult,
  AvailabilityRow,
} from "@/lib/availabilityEngine";

export type SlotCellKind =
  | "empty"
  | "available"
  | "excluded"
  | "leave"
  | "special";

export type SlotCell = {
  team: string;
  slot: number;
  kind: SlotCellKind;
  /** 점유 ACTIVE/LEAVE 캐디. 빈자리면 null */
  caddyId: number | null;
  name: string | null;
  employmentStatus: string | null;
  /** 휴무/당번/마샬/병가/타구사고/경조사 등 */
  statusLabels: string[];
  /** 찾근/54/1·3 등 특수 표시 여지 */
  specialTags: string[];
};

export type TeamSlotColumn = {
  team: string;
  slots: SlotCell[];
};

export type TeamSlotGrid = {
  date: string;
  maxSlot: number;
  teams: TeamSlotColumn[];
};

type OccupantLite = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  caddyType?: string | null;
};

/**
 * availability 결과 + (선택) 전체 캐디 목록으로 1~12조 슬롯 그리드 구성.
 * RETIRED는 점유하지 않음 → 빈자리.
 */
export function buildTeamSlotGrid(input: {
  availability: AvailabilityResult;
  /** 없으면 availability rows에서 재구성 (LEAVE/ACTIVE만 점유) */
  occupants?: OccupantLite[];
  teams?: readonly string[];
}): TeamSlotGrid {
  const teams = input.teams ?? PRIMARY_TEAMS;
  const byId = new Map<number, AvailabilityRow>();
  for (const r of [
    ...input.availability.available.all,
    ...input.availability.special,
    ...input.availability.excluded,
  ]) {
    byId.set(r.id, r);
  }

  const occupants: OccupantLite[] =
    input.occupants ??
    [...byId.values()]
      .filter((r) => {
        const emp = r.excludedReasons.some(
          (x) => x.includes("LEAVE") || x.includes("휴직")
        )
          ? "LEAVE"
          : r.excludedReasons.some(
                (x) => x.includes("RETIRED") || x.includes("퇴사")
              )
            ? "RETIRED"
            : "ACTIVE";
        return isSlotHoldingStatus(emp);
      })
      .map((r) => {
        const emp = r.excludedReasons.some(
          (x) => x.includes("LEAVE") || x.includes("휴직")
        )
          ? "LEAVE"
          : "ACTIVE";
        return {
          id: r.id,
          name: r.name,
          team: r.team,
          teamOrder: r.teamOrder,
          employmentStatus: emp,
          caddyType: r.caddyType,
        };
      });

  const holders = occupants.filter(
    (o) =>
      occupiesHouseThirdSlot(o) &&
      isSlotHoldingStatus(o.employmentStatus) &&
      (teams as readonly string[]).includes(o.team) &&
      Number(o.teamOrder) >= 1
  );

  // 렌더: max(capacity, 관측 max) — trailing empty 포함. RETIRED 등 높은 teamOrder도 관측에 포함해 숨김 방지
  const observedRows = [
    ...occupants
      .filter((o) => occupiesHouseThirdSlot(o))
      .map((o) => ({ team: o.team, teamOrder: o.teamOrder })),
    ...[...byId.values()]
      .filter((r) => occupiesHouseThirdSlot(r))
      .map((r) => ({
        team: r.team,
        teamOrder: r.teamOrder,
      })),
  ];
  const maxSlot = resolveGridSlotCount(teams, observedRows);

  const holderAt = new Map<string, OccupantLite>();
  for (const h of holders) {
    holderAt.set(`${h.team}#${h.teamOrder}`, h);
  }

  const columns: TeamSlotColumn[] = teams.map((team) => {
    const slots: SlotCell[] = [];
    for (let slot = 1; slot <= maxSlot; slot++) {
      const h = holderAt.get(`${team}#${slot}`);
      if (!h) {
        slots.push({
          team,
          slot,
          kind: "empty",
          caddyId: null,
          name: null,
          employmentStatus: null,
          statusLabels: [],
          specialTags: [],
        });
        continue;
      }

      const emp = String(h.employmentStatus).toUpperCase();
      if (emp === "LEAVE") {
        slots.push({
          team,
          slot,
          kind: "leave",
          caddyId: h.id,
          name: h.name,
          employmentStatus: "LEAVE",
          statusLabels: ["휴직"],
          specialTags: [],
        });
        continue;
      }

      const row = byId.get(h.id);
      const statusLabels = row?.assignmentLabels ?? [];
      const specialTags = row?.specialTags ?? [];

      if (row?.bucket === "special" || specialTags.length > 0) {
        if (row?.bucket === "excluded") {
          slots.push({
            team,
            slot,
            kind: "excluded",
            caddyId: h.id,
            name: h.name,
            employmentStatus: "ACTIVE",
            statusLabels:
              statusLabels.length > 0
                ? statusLabels
                : row.excludedReasons.filter(
                    (x) => !x.includes("RETIRED") && !x.includes("LEAVE")
                  ),
            specialTags,
          });
        } else if (row?.bucket === "special") {
          slots.push({
            team,
            slot,
            kind: "special",
            caddyId: h.id,
            name: h.name,
            employmentStatus: "ACTIVE",
            statusLabels,
            specialTags,
          });
        } else {
          slots.push({
            team,
            slot,
            kind: "available",
            caddyId: h.id,
            name: h.name,
            employmentStatus: "ACTIVE",
            statusLabels,
            specialTags,
          });
        }
        continue;
      }

      if (row?.bucket === "excluded") {
        slots.push({
          team,
          slot,
          kind: "excluded",
          caddyId: h.id,
          name: h.name,
          employmentStatus: "ACTIVE",
          statusLabels:
            statusLabels.length > 0
              ? statusLabels
              : (row.excludedReasons ?? []).filter(
                  (x) => !x.includes("퇴사") && !x.includes("휴직")
                ),
          specialTags: [],
        });
        continue;
      }

      slots.push({
        team,
        slot,
        kind: "available",
        caddyId: h.id,
        name: h.name,
        employmentStatus: "ACTIVE",
        statusLabels,
        specialTags,
      });
    }
    return { team, slots };
  });

  return {
    date: input.availability.date,
    maxSlot,
    teams: columns,
  };
}
