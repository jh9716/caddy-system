/**
 * 자동배치 우측 운영현황 패널 presentation-only.
 * 업무 규칙·엔진·DB write 없음. 기존 보드 view / DailySpecialDuty / DailySpecialSupport 를 조합한다.
 */

import {
  DAILY_SPECIAL_KIND_LABELS,
  DAILY_SPECIAL_KIND_UI,
  type DailySpecialKind,
} from "@/lib/dailySpecialDuty";
import {
  DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS,
  DAILY_SPECIAL_SUPPORT_KINDS,
  countSupportByKind,
  resolveSupportKind,
  supportListBadgeLabels,
  type DailySpecialSupportKind,
  type SpecialSupportRecord,
} from "@/lib/dailySpecialSupport";
import {
  DUTY_SLOT_LABELS,
  MARSHAL_SLOT_LABELS,
  type UnavailableBoardView,
  type UnavailableSlotBlock,
} from "@/lib/unavailablePanelView";

export type OpsSpecialDutyGroup = {
  kind: string;
  label: string;
  count: number;
  items: Array<{ name: string }>;
};

export type OpsSpecialSupportItem = {
  caddyId: number;
  name?: string;
  kind?: string;
  workPattern?: string;
  shift?: string;
};

export type OpsCountChip = {
  key: string;
  label: string;
  count: number;
};

export type OpsKindChip = {
  kind: string;
  label: string;
  count: number;
  names: string[];
};

export type OpsSupportPerson = {
  caddyId: number;
  name: string;
  kindBadge: string;
  patternBadge: string;
};

export type OpsSupportKindBlock = {
  kind: DailySpecialSupportKind;
  label: string;
  count: number;
  people: OpsSupportPerson[];
};

export function compactPeopleNames(
  people: Array<{ name?: string | null }>
): string {
  return people
    .map((row) => String(row.name || "").trim())
    .filter(Boolean)
    .join(" · ");
}

export function filledDutySlots(
  slots: readonly UnavailableSlotBlock[]
): UnavailableSlotBlock[] {
  return DUTY_SLOT_LABELS.map(
    (label) => slots.find((slot) => slot.label === label) || { label, people: [] }
  );
}

export function filledMarshalSlots(
  slots: readonly UnavailableSlotBlock[]
): UnavailableSlotBlock[] {
  return MARSHAL_SLOT_LABELS.map(
    (label) => slots.find((slot) => slot.label === label) || { label, people: [] }
  );
}

export function opsStatusCountChips(
  view: UnavailableBoardView,
  offCount: number | null | undefined
): OpsCountChip[] {
  const off =
    offCount != null
      ? offCount
      : view.offTeams.reduce((n, block) => n + block.people.length, 0);
  const chips: OpsCountChip[] = [];
  if (off > 0) chips.push({ key: "off", label: "휴무", count: off });
  if (view.sick.length > 0) {
    chips.push({ key: "sick", label: "병가", count: view.sick.length });
  }
  if (view.absent.length > 0) {
    chips.push({ key: "absent", label: "결근", count: view.absent.length });
  }
  if (view.other.length > 0) {
    chips.push({ key: "other", label: "기타", count: view.other.length });
  }
  return chips;
}

export function toOpsSpecialDutyGroups(
  groups:
    | Array<{
        kind: string;
        label?: string;
        count?: number;
        items?: Array<{ name?: string | null }>;
      }>
    | null
    | undefined
): OpsSpecialDutyGroup[] {
  return (groups || []).map((group) => {
    const kind = String(group.kind || "");
    const items = (group.items || []).map((item) => ({
      name: String(item.name || "").trim(),
    }));
    return {
      kind,
      label:
        group.label ||
        DAILY_SPECIAL_KIND_LABELS[kind as DailySpecialKind] ||
        kind,
      count: group.count ?? items.length,
      items,
    };
  });
}

export function opsSpecialDutyChips(
  groups: readonly OpsSpecialDutyGroup[] | null | undefined
): OpsKindChip[] {
  const byKind = new Map(
    (groups || []).map((group) => [group.kind, group] as const)
  );
  return DAILY_SPECIAL_KIND_UI.map((kind) => {
    const group = byKind.get(kind);
    const names = (group?.items || [])
      .map((item) => item.name)
      .filter(Boolean);
    return {
      kind,
      label: DAILY_SPECIAL_KIND_LABELS[kind],
      count: group?.count ?? names.length,
      names,
    };
  });
}

export function opsSpecialSupportBlocks(
  items: readonly OpsSpecialSupportItem[] | null | undefined
): OpsSupportKindBlock[] {
  const rows = (items || []) as SpecialSupportRecord[];
  const counts = countSupportByKind(rows);
  const peopleByKind = new Map<DailySpecialSupportKind, OpsSupportPerson[]>();
  for (const kind of DAILY_SPECIAL_SUPPORT_KINDS) {
    peopleByKind.set(kind, []);
  }
  for (const row of rows) {
    const kind = resolveSupportKind(row);
    const badges = supportListBadgeLabels(row.kind, row.workPattern, row.shift);
    peopleByKind.get(kind)?.push({
      caddyId: row.caddyId,
      name: String(row.name || "").trim() || `#${row.caddyId}`,
      kindBadge: badges.kind,
      patternBadge: badges.pattern,
    });
  }
  return DAILY_SPECIAL_SUPPORT_KINDS.map((kind) => ({
    kind,
    label: DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS[kind],
    count: counts[kind] || 0,
    people: peopleByKind.get(kind) || [],
  }));
}
