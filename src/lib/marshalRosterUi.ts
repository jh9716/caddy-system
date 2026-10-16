/**
 * 마샬 명단 화면용 순수 UI 계약.
 * API/eligibility/rotation 의미는 바꾸지 않는다.
 */

import { employmentStatusLabel } from "@/lib/caddyManage";
import {
  compactSearchText,
  matchesNameQuery,
  matchesTeamQuery,
  trimSearchQuery,
} from "@/lib/caddySearch";
import {
  caddyTypeLabel,
  type MarshalRosterRow,
} from "@/lib/marshalDomain";

export type MarshalPickerCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder?: number;
  caddyType?: string | null;
};

export const MARSHAL_ROSTER_TABLE_COLUMNS = [
  "순번",
  "이름",
  "조",
  "유형",
  "재직",
  "상태",
  "액션",
] as const;

export type MarshalRosterTableColumn =
  (typeof MARSHAL_ROSTER_TABLE_COLUMNS)[number];

export type MarshalRosterCardView = {
  id: number;
  name: string;
  summary: string;
  employmentLabel: string;
  statusLabel: "ACTIVE" | "비활성";
  active: boolean;
  rotationOrder: number | null;
  actionLabel: "비활성" | "복구";
};

export type MarshalRosterDenseView = {
  id: number;
  orderText: string;
  name: string;
  team: string;
  typeLabel: string;
  employmentLabel: string;
  metaText: string;
  statusLabel: "활성" | "비활성";
  active: boolean;
  rotationOrder: number | null;
  actionLabel: "비활성" | "복구";
};

export type MarshalCreateBody = {
  caddyId: number;
  rotationOrder?: number;
};

export function formatMarshalCaddyOptionLabel(
  caddy: MarshalPickerCaddy
): string {
  const team = String(caddy.team ?? "").trim();
  const name = String(caddy.name ?? "").trim() || "이름없음";
  const type = caddyTypeLabel(caddy.caddyType);
  return [team, name].filter(Boolean).join(" ") + ` · ${type}`;
}

export function tokenizeMarshalCaddyQuery(query: unknown): string[] {
  return trimSearchQuery(query).split(/\s+/u).filter(Boolean);
}

export function matchesMarshalCaddyTypeQuery(
  caddyType: unknown,
  query: string
): boolean {
  const raw = trimSearchQuery(query);
  if (!raw) return false;
  const q = compactSearchText(raw);
  const label = compactSearchText(caddyTypeLabel(caddyType));
  const key = compactSearchText(caddyType);
  if (label && label.includes(q)) return true;
  if (key && key.includes(q)) return true;
  return false;
}

export function matchesMarshalCaddyToken(
  caddy: MarshalPickerCaddy,
  token: string
): boolean {
  return (
    matchesNameQuery(caddy.name, token) ||
    matchesTeamQuery(caddy.team, token) ||
    matchesMarshalCaddyTypeQuery(caddy.caddyType, token)
  );
}

export function matchesMarshalCaddyQuery(
  caddy: MarshalPickerCaddy,
  query: string
): boolean {
  const raw = trimSearchQuery(query);
  if (!raw) return true;
  const tokens = tokenizeMarshalCaddyQuery(raw);
  if (tokens.every((token) => matchesMarshalCaddyToken(caddy, token))) {
    return true;
  }
  const hay = compactSearchText(
    `${caddy.team} ${caddy.name} ${caddyTypeLabel(caddy.caddyType)} ${caddy.caddyType ?? ""}`
  );
  return hay.includes(compactSearchText(raw));
}

export function sortMarshalAddableCaddies<T extends MarshalPickerCaddy>(
  a: T,
  b: T
): number {
  const team = String(a.team).localeCompare(String(b.team), "ko");
  if (team !== 0) return team;
  return (a.teamOrder || 0) - (b.teamOrder || 0);
}

export function listMarshalAddableCaddies<T extends MarshalPickerCaddy>(
  caddies: readonly T[],
  registeredIds: Iterable<number>
): T[] {
  const registered = new Set(registeredIds);
  return caddies
    .filter((caddy) => !registered.has(caddy.id))
    .slice()
    .sort(sortMarshalAddableCaddies);
}

export function filterMarshalPickerOptions<T extends MarshalPickerCaddy>(
  caddies: readonly T[],
  query: string
): T[] {
  return caddies.filter((caddy) => matchesMarshalCaddyQuery(caddy, query));
}

export function firstMarshalPickerMatch<T extends MarshalPickerCaddy>(
  caddies: readonly T[],
  query: string
): T | null {
  return filterMarshalPickerOptions(caddies, query)[0] ?? null;
}

export function visibleMarshalRoster(
  rows: readonly MarshalRosterRow[],
  showInactive: boolean
): MarshalRosterRow[] {
  return (showInactive ? rows : rows.filter((row) => row.active))
    .slice()
    .sort((a, b) => {
      const ao = a.rotationOrder ?? 9999;
      const bo = b.rotationOrder ?? 9999;
      if (ao !== bo) return ao - bo;
      return a.id - b.id;
    });
}

export function formatMarshalRosterOrder(
  rotationOrder: number | null | undefined
): string {
  return rotationOrder == null ? "—" : String(rotationOrder);
}

export function toMarshalRosterCardView(
  row: MarshalRosterRow
): MarshalRosterCardView {
  const team = String(row.caddy.team ?? "").trim();
  const type = caddyTypeLabel(row.caddy.caddyType);
  const orderText =
    row.rotationOrder == null ? "순번 —" : `순번 ${row.rotationOrder}`;
  return {
    id: row.id,
    name: row.caddy.name,
    summary: `${orderText} · ${team} · ${type}`,
    employmentLabel: employmentStatusLabel(row.caddy.employmentStatus),
    statusLabel: row.active ? "ACTIVE" : "비활성",
    active: row.active,
    rotationOrder: row.rotationOrder,
    actionLabel: row.active ? "비활성" : "복구",
  };
}

export function formatMarshalRosterDenseMeta(input: {
  team: string;
  typeLabel: string;
  employmentLabel: string;
}): string {
  const parts = [input.team, input.typeLabel, input.employmentLabel]
    .map((part) => String(part ?? "").trim())
    .filter((part) => part && part !== "—");
  return parts.join(" · ") || "—";
}

export function toMarshalRosterDenseView(
  row: MarshalRosterRow
): MarshalRosterDenseView {
  const team = String(row.caddy.team ?? "").trim() || "—";
  const typeLabel = caddyTypeLabel(row.caddy.caddyType);
  const employmentLabel = employmentStatusLabel(row.caddy.employmentStatus);
  return {
    id: row.id,
    orderText: formatMarshalRosterOrder(row.rotationOrder),
    name: String(row.caddy.name ?? "").trim() || "이름없음",
    team,
    typeLabel,
    employmentLabel,
    metaText: formatMarshalRosterDenseMeta({
      team,
      typeLabel,
      employmentLabel,
    }),
    statusLabel: row.active ? "활성" : "비활성",
    active: row.active,
    rotationOrder: row.rotationOrder,
    actionLabel: row.active ? "비활성" : "복구",
  };
}

export function marshalRosterSaveErrorMessage(input: {
  status?: number;
  code?: unknown;
  error?: unknown;
  fallback?: string;
}): string {
  const code = String(input.code ?? "").trim();
  const error = String(input.error ?? "").trim();
  const fallback = input.fallback || "수정 실패";
  if (code === "duplicate_rotation_order" || input.status === 409) {
    return (
      error || "활성 마샬 순번이 중복됩니다. 다른 순번을 입력하세요."
    );
  }
  return error || fallback;
}

export function buildMarshalCreateBody(input: {
  caddyId: string | number;
  rotationOrder?: string | number | null;
}): MarshalCreateBody {
  const body: MarshalCreateBody = {
    caddyId: Number(input.caddyId),
  };
  const raw = input.rotationOrder;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    body.rotationOrder = Number(raw);
  }
  return body;
}

export function buildMarshalActivePatch(active: boolean): { active: boolean } {
  return { active };
}

export function buildMarshalRotationPatch(
  rotationOrder: number | null
): { rotationOrder: number | null } {
  return { rotationOrder };
}
