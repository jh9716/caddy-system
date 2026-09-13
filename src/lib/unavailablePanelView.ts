/**
 * 비가용 패널 presentation-only.
 * buildUnavailablePanelGroups / hydrate / source 는 변경하지 않는다.
 *
 * grouping이 병가를 먼저 고정해도, 이미 있는 reason / opsDuty role로
 * 상태(휴무·병가·결근)와 역할(당번·마샬·조장)을 다시 나눈다.
 */

import type {
  UnavailablePanelGroup,
  UnavailablePanelItem,
} from "@/lib/assignmentBoardDirectEdit";
import { unavailablePanelTotal } from "@/lib/assignmentBoardDirectEdit";

export const UNAVAILABLE_SUPPORT_BADGES = [
  "1부지원",
  "2부지원",
  "3부지원",
] as const;

export type UnavailableSupportBadge =
  (typeof UNAVAILABLE_SUPPORT_BADGES)[number];

export const UNAVAILABLE_SPECIAL_BANDS = [
  "주중반",
  "주말반",
  "드라이빙",
] as const;

export type UnavailableSpecialBand =
  (typeof UNAVAILABLE_SPECIAL_BANDS)[number];

export const DUTY_SLOT_LABELS = ["조출1", "조출2", "후출1", "후출2"] as const;
export const MARSHAL_SLOT_LABELS = ["조출1", "조출2", "후출1"] as const;

export const DUTY_ROLEKEY_SLOTS: Record<string, string> = {
  당번_조출_1: "조출1",
  당번_조출_2: "조출2",
  당번_후출_1: "후출1",
  당번_후출_2: "후출2",
};

export const MARSHAL_ROLEKEY_SLOTS: Record<string, string> = {
  마샬_조출_1: "조출1",
  마샬_조출_2: "조출2",
  마샬_후출_1: "후출1",
};

export type UnavailableBoardPerson = {
  caddyId: number;
  name: string;
  badges: UnavailableSupportBadge[];
};

export type UnavailableTeamBlock = {
  team: string;
  people: UnavailableBoardPerson[];
};

export type UnavailableSlotBlock = {
  label: string;
  people: UnavailableBoardPerson[];
};

export type UnavailableSourceConflict = {
  caddyId: number;
  name: string;
  status: "병가" | "결근";
  role: string;
};

export type UnavailableBoardView = {
  total: number;
  offTeams: UnavailableTeamBlock[];
  sick: UnavailableBoardPerson[];
  absent: UnavailableBoardPerson[];
  dutySlots: UnavailableSlotBlock[];
  marshalSlots: UnavailableSlotBlock[];
  leaders: UnavailableBoardPerson[];
  specialBands: UnavailableTeamBlock[];
  other: UnavailableBoardPerson[];
  conflicts: UnavailableSourceConflict[];
};

export type OpsStatusSummary = {
  employed: number | null;
  off: number | null;
  finalAvailable: number | null;
  sick: number;
  absent: number;
};

export type UnavailableBoardSources = {
  opsDuties?: Array<{
    caddyId: number;
    role?: string;
    roleKey?: string;
  }> | null;
  dailyUnavailables?: Array<{
    caddyId: number;
    reason?: string;
  }> | null;
};

export type OpsRoleKind = "당번" | "마샬" | "조장";

export function pickOpsStatusSummary(
  dailySummary:
    | {
        baseAvailable: number;
        off: number;
        finalAvailable: number;
      }
    | null
    | undefined,
  groups: readonly UnavailablePanelGroup[],
  view?: Pick<UnavailableBoardView, "sick" | "absent"> | null
): OpsStatusSummary {
  return {
    employed: dailySummary != null ? dailySummary.baseAvailable : null,
    off:
      dailySummary != null ? dailySummary.off : itemsOf(groups, "휴무").length,
    finalAvailable: dailySummary != null ? dailySummary.finalAvailable : null,
    sick: view ? view.sick.length : itemsOf(groups, "병가").length,
    absent: view ? view.absent.length : itemsOf(groups, "결근").length,
  };
}

export function supportBadgesFromReason(
  reason: string
): UnavailableSupportBadge[] {
  const text = String(reason || "");
  if (!/지원/.test(text)) return [];
  const badges: UnavailableSupportBadge[] = [];
  if (/1부/.test(text)) badges.push("1부지원");
  if (/2부/.test(text)) badges.push("2부지원");
  if (/3부/.test(text)) badges.push("3부지원");
  return badges;
}

export function houseTeamNumber(team: string): number | null {
  const m = String(team || "")
    .trim()
    .match(/^(\d{1,2})\s*조$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}

export function specialBandFromTeam(
  team: string
): UnavailableSpecialBand | null {
  const t = String(team || "").trim();
  for (const band of UNAVAILABLE_SPECIAL_BANDS) {
    if (t === band) return band;
  }
  return null;
}

export function slotLabelFromRoleKey(roleKey: string): string | null {
  const key = String(roleKey || "").trim();
  return DUTY_ROLEKEY_SLOTS[key] || MARSHAL_ROLEKEY_SLOTS[key] || null;
}

export function opsRoleFromReason(reason: string): OpsRoleKind | null {
  const text = String(reason || "");
  if (/조장|LEADER/.test(text)) return "조장";
  if (/마샬|MARSHAL/.test(text)) return "마샬";
  if (/당번|DUTY/.test(text)) return "당번";
  return null;
}

export function opsRoleFromStoredRole(role: string | null | undefined): OpsRoleKind | null {
  const r = String(role || "").trim().toUpperCase();
  if (r === "LEADER") return "조장";
  if (r === "MARSHAL_AM" || r === "MARSHAL_PM") return "마샬";
  if (r === "DUTY_AM" || r === "DUTY_PM") return "당번";
  return null;
}

function itemsOf(
  groups: readonly UnavailablePanelGroup[],
  category: UnavailablePanelGroup["category"]
): UnavailablePanelItem[] {
  return groups.find((group) => group.category === category)?.items || [];
}

function flattenItems(
  groups: readonly UnavailablePanelGroup[]
): UnavailablePanelItem[] {
  const byId = new Map<number, UnavailablePanelItem>();
  for (const group of groups) {
    for (const item of group.items) {
      if (!byId.has(item.caddyId)) byId.set(item.caddyId, item);
    }
  }
  return [...byId.values()];
}

function toPerson(item: UnavailablePanelItem): UnavailableBoardPerson {
  return {
    caddyId: item.caddyId,
    name: item.name,
    badges: supportBadgesFromReason(item.reason),
  };
}

function isOffItem(item: UnavailablePanelItem): boolean {
  if (item.category === "휴무") return true;
  return /휴무|^OFF\b/.test(item.reason);
}

function isConfirmedSick(
  item: UnavailablePanelItem,
  sickIds: Set<number> | null,
  hasOpsRole: boolean
): boolean {
  if (hasOpsRole) return Boolean(sickIds?.has(item.caddyId));
  if (sickIds?.has(item.caddyId)) return true;
  return item.category === "병가" || /병가|SICK/.test(item.reason);
}

function isConfirmedAbsent(
  item: UnavailablePanelItem,
  absentIds: Set<number> | null,
  hasOpsRole: boolean
): boolean {
  if (hasOpsRole) return Boolean(absentIds?.has(item.caddyId));
  if (absentIds?.has(item.caddyId)) return true;
  return item.category === "결근" || /결근|미출근|ATTENDANCE/.test(item.reason);
}

function dailyStatusSets(
  rows: UnavailableBoardSources["dailyUnavailables"]
): { sickIds: Set<number> | null; absentIds: Set<number> | null } {
  if (rows == null) return { sickIds: null, absentIds: null };
  const sickIds = new Set<number>();
  const absentIds = new Set<number>();
  for (const row of rows) {
    const id = Number(row.caddyId);
    if (!id) continue;
    const raw = String(row.reason || "").trim();
    if (/ATTENDANCE|결근|미출근/.test(raw)) absentIds.add(id);
    else if (/SICK|병가/.test(raw)) sickIds.add(id);
  }
  return { sickIds, absentIds };
}

function dutyPeriod(reason: string, role?: string): "am" | "pm" | "unknown" {
  const text = `${reason || ""} ${role || ""}`;
  if (/후출당번|DUTY_PM/.test(text)) return "pm";
  if (/조출당번|DUTY_AM/.test(text)) return "am";
  if (/후출/.test(text) && !/마샬|MARSHAL/.test(text)) return "pm";
  if (/조출/.test(text) && !/마샬|MARSHAL/.test(text)) return "am";
  return "unknown";
}

function marshalPeriod(reason: string, role?: string): "am" | "pm" | "unknown" {
  const text = `${reason || ""} ${role || ""}`;
  if (/후출마샬|MARSHAL_PM/.test(text)) return "pm";
  if (/조출마샬|MARSHAL_AM/.test(text)) return "am";
  if (/후출/.test(text)) return "pm";
  if (/조출/.test(text)) return "am";
  return "unknown";
}

function fillNamedSlots(
  buckets: UnavailableBoardPerson[][],
  labels: readonly string[]
): UnavailableSlotBlock[] {
  return labels.map((label, index) => ({
    label,
    people: buckets[index] || [],
  }));
}

type SlotCandidate = {
  item: UnavailablePanelItem;
  slotLabel: string | null;
  period: "am" | "pm" | "unknown";
};

function assignSlots(
  candidates: SlotCandidate[],
  labels: readonly string[],
  amCount: number
): UnavailableSlotBlock[] {
  if (candidates.length === 0) return [];
  const buckets: UnavailableBoardPerson[][] = labels.map(() => []);
  const used = new Set<number>();
  for (const row of candidates) {
    if (!row.slotLabel) continue;
    const index = labels.indexOf(row.slotLabel);
    if (index < 0) continue;
    buckets[index].push(toPerson(row.item));
    used.add(row.item.caddyId);
  }
  const leftover = candidates.filter((row) => !used.has(row.item.caddyId));
  const am = leftover.filter((row) => row.period === "am");
  const pm = leftover.filter((row) => row.period === "pm");
  const unknown = leftover.filter((row) => row.period === "unknown");
  const place = (list: SlotCandidate[], start: number, count: number) => {
    list.forEach((row, index) => {
      const slot = start + Math.min(index, Math.max(count, 1) - 1);
      buckets[slot].push(toPerson(row.item));
    });
  };
  place(am, 0, amCount);
  place(pm, amCount, labels.length - amCount);
  place(unknown, 0, labels.length);
  return fillNamedSlots(buckets, labels);
}

export function countUnavailableBoardPeople(view: UnavailableBoardView): number {
  const named = (blocks: UnavailableTeamBlock[] | UnavailableSlotBlock[]) =>
    blocks.reduce((n, block) => n + block.people.length, 0);
  return (
    named(view.offTeams) +
    view.sick.length +
    view.absent.length +
    named(view.dutySlots) +
    named(view.marshalSlots) +
    view.leaders.length +
    named(view.specialBands) +
    view.other.length +
    (view.conflicts || []).length
  );
}

export function buildUnavailableBoardView(
  groups: readonly UnavailablePanelGroup[],
  sources?: UnavailableBoardSources | null
): UnavailableBoardView {
  const dutyHint = new Map<
    number,
    { role?: string; roleKey?: string; kind: OpsRoleKind }
  >();
  for (const row of sources?.opsDuties || []) {
    const id = Number(row.caddyId);
    const kind = opsRoleFromStoredRole(row.role);
    if (!id || !kind) continue;
    dutyHint.set(id, { role: row.role, roleKey: row.roleKey, kind });
  }
  const { sickIds, absentIds } = dailyStatusSets(sources?.dailyUnavailables);

  const specialByBand = new Map<
    UnavailableSpecialBand,
    UnavailableBoardPerson[]
  >();
  const takeSpecialOr = (
    item: UnavailablePanelItem,
    fallback: (person: UnavailableBoardPerson) => void
  ) => {
    const band = specialBandFromTeam(item.team);
    if (!band) {
      fallback(toPerson(item));
      return;
    }
    const list = specialByBand.get(band) || [];
    list.push(toPerson(item));
    specialByBand.set(band, list);
  };

  const offByTeam = new Map<number, UnavailableBoardPerson[]>();
  const offOther: UnavailableBoardPerson[] = [];
  const sick: UnavailableBoardPerson[] = [];
  const absent: UnavailableBoardPerson[] = [];
  const dutyCandidates: SlotCandidate[] = [];
  const marshalCandidates: SlotCandidate[] = [];
  const leaders: UnavailableBoardPerson[] = [];
  const other: UnavailableBoardPerson[] = [];
  const conflicts: UnavailableSourceConflict[] = [];

  for (const item of flattenItems(groups)) {
    const hint = dutyHint.get(item.caddyId);
    const role = hint?.kind || opsRoleFromReason(item.reason);
    const off = isOffItem(item);
    const sickHit = isConfirmedSick(item, sickIds, Boolean(role));
    const absentHit = isConfirmedAbsent(item, absentIds, Boolean(role));

    if (off) {
      takeSpecialOr(item, (person) => {
        const n = houseTeamNumber(item.team);
        if (n) {
          const list = offByTeam.get(n) || [];
          list.push(person);
          offByTeam.set(n, list);
          return;
        }
        offOther.push(person);
      });
      continue;
    }

    if (role && (sickHit || absentHit)) {
      conflicts.push({
        caddyId: item.caddyId,
        name: item.name,
        status: absentHit ? "결근" : "병가",
        role: hint?.roleKey || hint?.role || role,
      });
      continue;
    }

    if (role === "당번") {
      dutyCandidates.push({
        item,
        slotLabel: hint?.roleKey ? slotLabelFromRoleKey(hint.roleKey) : null,
        period: dutyPeriod(item.reason, hint?.role),
      });
      continue;
    }
    if (role === "마샬") {
      marshalCandidates.push({
        item,
        slotLabel: hint?.roleKey ? slotLabelFromRoleKey(hint.roleKey) : null,
        period: marshalPeriod(item.reason, hint?.role),
      });
      continue;
    }
    if (role === "조장") {
      leaders.push(toPerson(item));
      continue;
    }

    if (sickHit) {
      sick.push(toPerson(item));
      continue;
    }
    if (absentHit) {
      absent.push(toPerson(item));
      continue;
    }

    takeSpecialOr(item, (person) => other.push(person));
  }

  const offTeams: UnavailableTeamBlock[] = [];
  for (let n = 1; n <= 12; n += 1) {
    const people = offByTeam.get(n);
    if (!people?.length) continue;
    offTeams.push({ team: `${n}조`, people });
  }
  if (offOther.length) {
    offTeams.push({ team: "기타", people: offOther });
  }

  const specialBands = UNAVAILABLE_SPECIAL_BANDS.filter((band) =>
    specialByBand.get(band)?.length
  ).map((band) => ({
    team: band,
    people: specialByBand.get(band) || [],
  }));

  return {
    total: unavailablePanelTotal(groups),
    offTeams,
    sick,
    absent,
    dutySlots: assignSlots(dutyCandidates, DUTY_SLOT_LABELS, 2),
    marshalSlots: assignSlots(marshalCandidates, MARSHAL_SLOT_LABELS, 2),
    leaders,
    specialBands,
    other,
    conflicts,
  };
}
