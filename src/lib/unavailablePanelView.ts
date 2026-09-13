/**
 * 비가용 패널 presentation-only.
 * buildUnavailablePanelGroups / hydrate / source 는 변경하지 않는다.
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
};

export type OpsStatusSummary = {
  employed: number | null;
  off: number | null;
  finalAvailable: number | null;
  sick: number;
  absent: number;
};

export function pickOpsStatusSummary(
  dailySummary:
    | {
        baseAvailable: number;
        off: number;
        finalAvailable: number;
      }
    | null
    | undefined,
  groups: readonly UnavailablePanelGroup[]
): OpsStatusSummary {
  return {
    employed: dailySummary != null ? dailySummary.baseAvailable : null,
    off:
      dailySummary != null ? dailySummary.off : itemsOf(groups, "휴무").length,
    finalAvailable: dailySummary != null ? dailySummary.finalAvailable : null,
    sick: itemsOf(groups, "병가").length,
    absent: itemsOf(groups, "결근").length,
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

function itemsOf(
  groups: readonly UnavailablePanelGroup[],
  category: UnavailablePanelGroup["category"]
): UnavailablePanelItem[] {
  return groups.find((group) => group.category === category)?.items || [];
}

function toPerson(item: UnavailablePanelItem): UnavailableBoardPerson {
  return {
    caddyId: item.caddyId,
    name: item.name,
    badges: supportBadgesFromReason(item.reason),
  };
}

function dutyPeriod(reason: string): "am" | "pm" | "unknown" {
  const text = String(reason || "");
  if (/후출당번|DUTY_PM/.test(text)) return "pm";
  if (/조출당번|DUTY_AM/.test(text)) return "am";
  if (/후출/.test(text) && !/마샬/.test(text)) return "pm";
  if (/조출/.test(text) && !/마샬/.test(text)) return "am";
  return "unknown";
}

function marshalPeriod(reason: string): "am" | "pm" | "unknown" {
  const text = String(reason || "");
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

function assignSequentialSlots(
  items: UnavailablePanelItem[],
  periodOf: (reason: string) => "am" | "pm" | "unknown",
  labels: readonly string[],
  amCount: number
): UnavailableSlotBlock[] {
  const am: UnavailablePanelItem[] = [];
  const pm: UnavailablePanelItem[] = [];
  const unknown: UnavailablePanelItem[] = [];
  for (const item of items) {
    const period = periodOf(item.reason);
    if (period === "am") am.push(item);
    else if (period === "pm") pm.push(item);
    else unknown.push(item);
  }
  const buckets: UnavailableBoardPerson[][] = labels.map(() => []);
  const place = (list: UnavailablePanelItem[], start: number, count: number) => {
    list.forEach((item, index) => {
      const slot = start + Math.min(index, count - 1);
      buckets[slot].push(toPerson(item));
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
    view.other.length
  );
}

export function buildUnavailableBoardView(
  groups: readonly UnavailablePanelGroup[]
): UnavailableBoardView {
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
  for (const item of itemsOf(groups, "휴무")) {
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

  const other: UnavailableBoardPerson[] = [];
  for (const item of itemsOf(groups, "기타")) {
    takeSpecialOr(item, (person) => other.push(person));
  }

  const specialBands = UNAVAILABLE_SPECIAL_BANDS.filter((band) =>
    specialByBand.get(band)?.length
  ).map((band) => ({
    team: band,
    people: specialByBand.get(band) || [],
  }));

  const dutyItems = itemsOf(groups, "당번");
  const marshalItems = itemsOf(groups, "마샬");

  return {
    total: unavailablePanelTotal(groups),
    offTeams,
    sick: itemsOf(groups, "병가").map(toPerson),
    absent: itemsOf(groups, "결근").map(toPerson),
    dutySlots: dutyItems.length
      ? assignSequentialSlots(dutyItems, dutyPeriod, DUTY_SLOT_LABELS, 2)
      : [],
    marshalSlots: marshalItems.length
      ? assignSequentialSlots(marshalItems, marshalPeriod, MARSHAL_SLOT_LABELS, 2)
      : [],
    leaders: itemsOf(groups, "조장").map(toPerson),
    specialBands,
    other,
  };
}
